import { TtsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as NodeBuffer from "node:buffer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { isSecretRedacted, TTS_API_KEY_SECRET_NAME } from "../serverSettings.ts";
import * as ServerSettings from "../serverSettings.ts";
import { cleanTextForSpeech } from "@t3tools/shared/textForSpeech";

/**
 * OpenAI-compatible defaults, applied when the settings fields are empty so a
 * plain API key is enough to get cloud voices. The shape matches OpenAI and
 * Groq `POST {baseUrl}/audio/speech`; self-hosted gateways follow it too.
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "tts-1";
const DEFAULT_VOICE = "alloy";

/**
 * Gemini speaks through `generateContent` with AUDIO response modality and
 * answers raw PCM that has to be wrapped in a WAV container for the clients'
 * `<audio>` elements.
 */
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_DEFAULT_VOICE = "Kore";

/** Clips are replayable until they expire, then dropped lazily on the next use. */
const CLIP_TTL_MS = 10 * 60_000;
const MAX_CACHED_CLIPS = 32;

export interface TtsClip {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export class TextToSpeech extends Context.Service<
  TextToSpeech,
  {
    /** Synthesize `text` to speech, served back through a short-lived server-relative URL. */
    readonly synthesize: (input: {
      readonly text: string;
    }) => Effect.Effect<{ readonly relativeUrl: string; readonly expiresAt: number }, TtsError>;
    /** The cached clip behind a synthesize URL, `none` for unknown or expired tokens. */
    readonly clip: (token: string) => Effect.Effect<Option.Option<TtsClip>>;
  }
>()("t3/tts/TextToSpeech") {}

/** Gemini answers 16-bit little-endian mono PCM; browsers need a RIFF header to play it. */
const pcmToWav = (pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16) => {
  const header = NodeBuffer.Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Uint8Array.from(NodeBuffer.Buffer.concat([header, pcm]));
};

/** Google 429 bodies carry RetryInfo with a delay like "26s". */
const retryDelayFromResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const body = (yield* response.json.pipe(Effect.orElseSucceed(() => ({})))) as {
      error?: {
        details?: Array<{ "@type"?: string; retryDelay?: string }>;
      };
    };
    const retryInfo = body.error?.details?.find((detail) =>
      (detail["@type"] ?? "").endsWith("RetryInfo"),
    );
    const seconds = Number.parseFloat(retryInfo?.retryDelay?.replace("s", "") ?? "0");
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
  });

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Clips persist under the state directory so every execution context that
  // serves /api/tts-audio — the process that synthesized, a restart, or a
  // request forwarded in through T3 Connect — reads the same bytes.
  const clipsDir = path.join(config.stateDir, "tts-clips");

  interface ClipFile {
    readonly name: string;
    readonly expiresAt: number;
    readonly extension: string;
  }

  // File name layout: `<expiresAt>-<token>.<ext>`.
  const listClipFiles = Effect.fn("TextToSpeech.listClipFiles")(function* () {
    const names = yield* fs.readDirectory(clipsDir).pipe(Effect.orElseSucceed(() => []));
    const files: Array<ClipFile> = [];
    for (const name of names) {
      const dot = name.lastIndexOf(".");
      const stem = dot === -1 ? name : name.slice(0, dot);
      const expiresAt = Number.parseInt(stem, 10);
      if (Number.isFinite(expiresAt)) {
        files.push({
          name,
          expiresAt,
          extension: dot === -1 ? "" : name.slice(dot + 1),
        });
      }
    }
    return files.sort((a, b) => a.expiresAt - b.expiresAt);
  });

  const removeClipFile = (file: ClipFile) =>
    fs.remove(path.join(clipsDir, file.name), { force: true }).pipe(Effect.ignore);

  const clipMimeType = (extension: string) =>
    extension === "mp3"
      ? "audio/mpeg"
      : extension === "wav"
        ? "audio/wav"
        : "application/octet-stream";
  const clipExtension = (mimeType: string) => (mimeType === "audio/mpeg" ? "mp3" : "wav");

  const resolveApiKey: Effect.Effect<string> = Effect.gen(function* () {
    const stored = yield* secretStore.get(TTS_API_KEY_SECRET_NAME).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.catch(() => Effect.succeedNone),
    );
    if (Option.isSome(stored) && stored.value.length > 0) return stored.value;
    // The store move can be pending when the key was hand-edited into settings.json.
    const inline = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.tts.apiKey),
      Effect.catch(() => Effect.succeed("")),
    );
    return inline.length > 0 && !isSecretRedacted(inline) ? inline : "";
  });

  const synthesizeWithGemini = Effect.fn("TextToSpeech.synthesizeWithGemini")(function* (input: {
    readonly text: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly voice: string;
    readonly apiKey: string;
  }) {
    // Gemini 3.x TTS models take the voice directly and answer complete WAV;
    // 2.5-era models want prebuiltVoiceConfig.voiceName and answer raw PCM.
    const isGemini3 = /gemini-3/.test(input.model);
    const speechConfig = isGemini3
      ? { voiceConfig: { voice: input.voice } }
      : { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } };
    // Free-tier rate limits answer 429 on short bursts; honoring Google's
    // RetryInfo (or backing off) turns those into delayed successes instead
    // of silent fallbacks.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      const request = yield* HttpClientRequest.post(
        `${input.baseUrl.replace(/\/+$/, "")}/models/${input.model}:generateContent`,
      ).pipe(
        HttpClientRequest.setHeader("x-goog-api-key", input.apiKey),
        HttpClientRequest.bodyJson({
          contents: [{ parts: [{ text: input.text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig,
          },
        }),
        Effect.mapError(
          () =>
            new TtsError({
              reason: "provider-failed",
              message: "The text-to-speech request could not be encoded.",
            }),
        ),
      );
      const response = yield* http.execute(request).pipe(
        Effect.timeout("30 seconds"),
        Effect.catch(() =>
          Effect.fail(
            new TtsError({
              reason: "provider-failed",
              message: "The text-to-speech provider could not be reached.",
            }),
          ),
        ),
      );
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfterMs = yield* retryDelayFromResponse(response).pipe(
          Effect.orElseSucceed(() => 3_000 * attempt),
        );
        yield* Effect.sleep(`${retryAfterMs} millis`);
        continue;
      }
      if (response.status !== 200) {
        return yield* new TtsError({
          reason: "provider-failed",
          message: `The text-to-speech provider rejected the request with status ${response.status}.`,
        });
      }
      const json = yield* response.json.pipe(
        Effect.catch(() =>
          Effect.fail(
            new TtsError({
              reason: "provider-failed",
              message: "The text-to-speech provider returned an unreadable response.",
            }),
          ),
        ),
      );
      const inlineData = (
        json as {
          candidates?: Array<{
            content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
          }>;
        }
      ).candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (typeof inlineData?.data !== "string" || inlineData.data.length === 0) {
        return yield* new TtsError({
          reason: "provider-failed",
          message: "The text-to-speech provider returned no audio.",
        });
      }
      const bytes = new Uint8Array(NodeBuffer.Buffer.from(inlineData.data, "base64"));
      // 3.x answers complete WAV; 2.5-era answers headerless PCM that needs the container.
      if ((inlineData.mimeType ?? "").includes("wav")) {
        return { bytes, mimeType: "audio/wav" as const };
      }
      const sampleRate = Number(/rate=(\d+)/.exec(inlineData.mimeType ?? "")?.[1] ?? 24_000);
      return { bytes: pcmToWav(bytes, sampleRate), mimeType: "audio/wav" as const };
    }
  });

  const synthesize = Effect.fn("TextToSpeech.synthesize")(function* (input: {
    readonly text: string;
  }) {
    const text = cleanTextForSpeech(input.text);
    if (text.length === 0) {
      return yield* new TtsError({
        reason: "provider-failed",
        message: "The requested text is empty.",
      });
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () =>
          new TtsError({
            reason: "provider-failed",
            message: "The text-to-speech settings could not be read.",
          }),
      ),
    );
    const apiKey = yield* resolveApiKey;
    if (apiKey.length === 0) {
      return yield* new TtsError({
        reason: "not-configured",
        message: "No text-to-speech provider is configured in the server settings.",
      });
    }
    const provider = settings.tts.provider.trim();
    if (provider === "gemini") {
      const gemini = yield* synthesizeWithGemini({
        text,
        baseUrl: settings.tts.baseUrl.trim() || GEMINI_DEFAULT_BASE_URL,
        model: settings.tts.model.trim() || GEMINI_DEFAULT_MODEL,
        voice: settings.tts.voice.trim() || GEMINI_DEFAULT_VOICE,
        apiKey,
      });
      return yield* storeClip({ bytes: gemini.bytes, mimeType: gemini.mimeType });
    }
    const baseUrl = settings.tts.baseUrl.trim() || DEFAULT_BASE_URL;
    const model = settings.tts.model.trim() || DEFAULT_MODEL;
    const voice = settings.tts.voice.trim() || DEFAULT_VOICE;

    const request = yield* HttpClientRequest.post(
      `${baseUrl.replace(/\/+$/, "")}/audio/speech`,
    ).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJson({
        model,
        voice,
        input: text,
        response_format: "mp3",
      }),
      Effect.mapError(
        () =>
          new TtsError({
            reason: "provider-failed",
            message: "The text-to-speech request could not be encoded.",
          }),
      ),
    );
    const response = yield* http.execute(request).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch(() =>
        Effect.fail(
          new TtsError({
            reason: "provider-failed",
            message: "The text-to-speech provider could not be reached.",
          }),
        ),
      ),
    );
    if (response.status !== 200) {
      return yield* new TtsError({
        reason: "provider-failed",
        message: `The text-to-speech provider rejected the request with status ${response.status}.`,
      });
    }
    const bytes = yield* Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)).pipe(
      Effect.catch(() =>
        Effect.fail(
          new TtsError({
            reason: "provider-failed",
            message: "The text-to-speech provider returned an unreadable response.",
          }),
        ),
      ),
    );

    return yield* storeClip({ bytes, mimeType: "audio/mpeg" });
  });

  const storeClip = Effect.fn("TextToSpeech.storeClip")(function* (input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }) {
    const token = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        () =>
          new TtsError({
            reason: "provider-failed",
            message: "A text-to-speech clip id could not be generated.",
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + CLIP_TTL_MS;
    const storeFailed = () =>
      new TtsError({
        reason: "provider-failed",
        message: "A text-to-speech clip could not be stored.",
      });
    // Expired clips go on the next store; the cache stays bounded by dropping
    // the oldest entries first.
    const existing = yield* listClipFiles();
    const keep = existing
      .filter((file) => file.expiresAt > now)
      .slice(-Math.max(0, MAX_CACHED_CLIPS - 1));
    for (const file of existing) {
      if (!keep.includes(file)) yield* removeClipFile(file);
    }
    yield* fs.makeDirectory(clipsDir, { recursive: true }).pipe(Effect.mapError(storeFailed));
    yield* fs
      .writeFile(
        path.join(clipsDir, `${expiresAt}-${token}.${clipExtension(input.mimeType)}`),
        input.bytes,
      )
      .pipe(Effect.mapError(storeFailed));
    return { relativeUrl: `/api/tts-audio/${token}`, expiresAt };
  });

  const clip = (token: string): Effect.Effect<Option.Option<TtsClip>> =>
    Effect.gen(function* () {
      if (token.length === 0) return Option.none();
      const files = yield* listClipFiles();
      const file = files.find((file) =>
        file.name.slice(0, file.name.lastIndexOf(".")).endsWith(`-${token}`),
      );
      if (file === undefined) return Option.none();
      if (file.expiresAt <= (yield* Clock.currentTimeMillis)) {
        yield* removeClipFile(file);
        return Option.none();
      }
      const bytes = yield* fs
        .readFile(path.join(clipsDir, file.name))
        .pipe(Effect.orElseSucceed(() => new Uint8Array()));
      if (bytes.length === 0) return Option.none();
      return Option.some({ bytes, mimeType: clipMimeType(file.extension) });
    });

  return TextToSpeech.of({ synthesize, clip });
});

export const layer = Layer.effect(TextToSpeech, make);
