import type { TtsSettings } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextToSpeech from "./TextToSpeech.ts";

const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";
const FAKE_AUDIO = new Uint8Array([1, 2, 3, 4]);

interface RecordedRequest {
  readonly url: string;
  readonly body: string;
}

const fakeSecretStore = (value: string | null) =>
  Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: () =>
      Effect.succeed(value === null ? Option.none() : Option.some(new TextEncoder().encode(value))),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  } satisfies ServerSecretStore.ServerSecretStore["Service"]);

const makeTestLayer = (input: {
  readonly storedKey?: string | null;
  readonly tts?: Partial<TtsSettings>;
  readonly status?: number;
  readonly recorded?: Array<RecordedRequest>;
  readonly responseBody?: string;
}) => {
  // Disk-backed clips read and write through the real node file system; the
  // config layer derives its paths inside a throwaway temp base directory.
  const layerClipsFs = NodeFileSystem.layer.pipe(Layer.provideMerge(NodePath.layer));
  const layerTestConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-tts-test" }).pipe(
    Layer.provide(layerClipsFs),
  );
  return TextToSpeech.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        fakeSecretStore(input.storedKey ?? null),
        ServerSettings.layerTest({
          tts: {
            apiKey: "",
            baseUrl: "",
            model: "",
            voice: "",
            provider: "",
            autoReadAloud: false,
            ...input.tts,
          },
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              input.recorded?.push({
                url: request.url,
                body:
                  request.body._tag === "Uint8Array"
                    ? new TextDecoder().decode(request.body.body)
                    : "",
              });
              const body =
                input.responseBody ?? (input.status === undefined ? FAKE_AUDIO : new Uint8Array());
              return HttpClientResponse.fromWeb(
                request,
                new Response(body, {
                  status: input.status ?? 200,
                  headers: {
                    "content-type": input.responseBody ? "application/json" : "audio/mpeg",
                  },
                }),
              );
            }),
          ),
        ),
      ),
    ),
    Layer.provide(layerTestConfig),
    Layer.provide(layerClipsFs),
  );
};

describe("TextToSpeech", () => {
  it.effect("fails as not configured without a stored or inline key", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* Effect.result(service.synthesize({ text: "hello" }));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.deepStrictEqual(result.failure.reason, "not-configured");
    }).pipe(Effect.provide(makeTestLayer({}))),
  );

  it.effect("ignores an inline redaction marker with nothing stored", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* Effect.result(service.synthesize({ text: "hello" }));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.deepStrictEqual(result.failure.reason, "not-configured");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          tts: { apiKey: SECRET_REDACTED },
        }),
      ),
    ),
  );

  it.effect("falls back to a plain inline key hand-edited into settings", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* service.synthesize({ text: "hello" });
      assert.ok(result.relativeUrl.startsWith("/api/tts-audio/"));
    }).pipe(
      Effect.provide(
        makeTestLayer({
          tts: { apiKey: "sk-inline" },
        }),
      ),
    ),
  );

  it.effect("posts to the configured endpoint and caches the clip", () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* service.synthesize({ text: "hello world" });
      assert.deepStrictEqual(recorded, [
        {
          url: "https://tts.example.com/v1/audio/speech",
          body: JSON.stringify({
            model: "big-tts",
            voice: "nova",
            input: "hello world",
            response_format: "mp3",
          }),
        },
      ]);
      const token = result.relativeUrl.slice("/api/tts-audio/".length);
      const clip = yield* service.clip(token);
      assert.deepStrictEqual(Option.getOrThrow(clip).bytes, FAKE_AUDIO);
      assert.strictEqual(Option.getOrThrow(clip).mimeType, "audio/mpeg");
      assert.deepStrictEqual(yield* service.clip("unknown-token"), Option.none());
    }).pipe(
      Effect.provide(
        makeTestLayer({
          storedKey: "sk-test",
          tts: { baseUrl: "https://tts.example.com/v1/", model: "big-tts", voice: "nova" },
          recorded,
        }),
      ),
    );
  });

  it.effect("synthesizes with gemini and wraps the pcm answer in a wav container", () => {
    const recorded: Array<RecordedRequest> = [];
    // The RIFF/WAV header is 44 bytes; four fake PCM bytes ride behind it.
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const responseBody = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: "AQIDBA==",
                  mimeType: "audio/L16;codec=pcm;rate=24000",
                },
              },
            ],
          },
        },
      ],
    });
    return Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* service.synthesize({ text: "hallo" });
      assert.deepStrictEqual(recorded, [
        {
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
          body: JSON.stringify({
            contents: [{ parts: [{ text: "hallo" }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
              },
            },
          }),
        },
      ]);
      const token = result.relativeUrl.slice("/api/tts-audio/".length);
      const clip = Option.getOrThrow(yield* service.clip(token));
      assert.strictEqual(clip.mimeType, "audio/wav");
      assert.strictEqual(clip.bytes.length, 44 + pcm.length);
      assert.deepStrictEqual(clip.bytes.slice(44), pcm);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          storedKey: "sk-test",
          tts: { provider: "gemini" },
          recorded,
          responseBody,
        }),
      ),
    );
  });

  it.effect("maps provider rejections to provider-failed", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* Effect.result(service.synthesize({ text: "hello" }));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.deepStrictEqual(result.failure.reason, "provider-failed");
    }).pipe(Effect.provide(makeTestLayer({ storedKey: "sk-test", status: 401 }))),
  );

  it.effect("leads a gemini request with the hinted language's direction", () => {
    const recorded: Array<RecordedRequest> = [];
    const responseBody = JSON.stringify({
      candidates: [
        { content: { parts: [{ inlineData: { data: "AQIDBA==", mimeType: "audio/wav" } }] } },
      ],
    });
    return Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      yield* service.synthesize({ text: "Build passed.", languageHint: "de" });
      const spoken = JSON.parse(recorded[0]!.body).contents[0].parts[0].text as string;
      assert.ok(spoken.startsWith("Lies den folgenden Text auf Deutsch vor."));
      assert.ok(spoken.endsWith("Build passed."));
    }).pipe(
      Effect.provide(
        makeTestLayer({
          storedKey: "sk-test",
          tts: { provider: "gemini" },
          recorded,
          responseBody,
        }),
      ),
    );
  });

  it.effect("summarizes with a gemini text model in the hinted language", () => {
    const recorded: Array<RecordedRequest> = [];
    const responseBody = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Der Build ist grün. " }] } }],
    });
    return Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* service.summarize({ text: "Long reply", languageHint: "de" });
      assert.strictEqual(result.text, "Der Build ist grün.");
      assert.strictEqual(
        recorded[0]!.url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
      );
      const body = JSON.parse(recorded[0]!.body);
      assert.ok(body.systemInstruction.parts[0].text.endsWith("Answer in German."));
      assert.strictEqual(body.contents[0].parts[0].text, "Long reply");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          storedKey: "sk-test",
          tts: { provider: "gemini" },
          recorded,
          responseBody,
        }),
      ),
    );
  });

  it.effect("summarizes through chat completions on OpenAI-compatible providers", () => {
    const recorded: Array<RecordedRequest> = [];
    const responseBody = JSON.stringify({
      choices: [{ message: { content: "Tests pass; nothing needs you." } }],
    });
    return Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* service.summarize({ text: "Long reply" });
      assert.strictEqual(result.text, "Tests pass; nothing needs you.");
      assert.strictEqual(recorded[0]!.url, "https://api.openai.com/v1/chat/completions");
      assert.strictEqual(JSON.parse(recorded[0]!.body).model, "gpt-4o-mini");
    }).pipe(Effect.provide(makeTestLayer({ storedKey: "sk-test", recorded, responseBody })));
  });
});
