import type { TtsSettings } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
    directory: undefined,
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
}) =>
  TextToSpeech.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        fakeSecretStore(input.storedKey ?? null),
        ServerSettings.layerTest({
          tts: { apiKey: "", baseUrl: "", model: "", voice: "", ...input.tts },
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
              const body = input.status === undefined ? FAKE_AUDIO : new Uint8Array();
              return HttpClientResponse.fromWeb(
                request,
                new Response(body, {
                  status: input.status ?? 200,
                  headers: { "content-type": "audio/mpeg" },
                }),
              );
            }),
          ),
        ),
      ),
    ),
  );

describe("TextToSpeech", () => {
  it.effect("fails as not configured without a stored or inline key", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* Effect.result(service.synthesize({ text: "hello" }));
      assert.deepStrictEqual(result.failure.reason, "not-configured");
    }).pipe(Effect.provide(makeTestLayer({}))),
  );

  it.effect("ignores an inline redaction marker with nothing stored", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* Effect.result(service.synthesize({ text: "hello" }));
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

  it.effect("maps provider rejections to provider-failed", () =>
    Effect.gen(function* () {
      const service = yield* TextToSpeech.TextToSpeech;
      const result = yield* Effect.result(service.synthesize({ text: "hello" }));
      assert.deepStrictEqual(result.failure.reason, "provider-failed");
    }).pipe(Effect.provide(makeTestLayer({ storedKey: "sk-test", status: 401 }))),
  );
});
