import { TtsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as NodeBuffer from "node:buffer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { isSecretRedacted, TTS_API_KEY_SECRET_NAME } from "../serverSettings.ts";
import * as ServerSettings from "../serverSettings.ts";

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

interface CachedClip {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly expiresAt: number;
}

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

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  const clips = new Map<string, CachedClip>();

  const dropExpiredClips = (now: number) => {
    for (const [token, clip] of clips) {
      if (clip.expiresAt <= now) clips.delete(token);
    }
  };

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
    const request = yield* HttpClientRequest.post(
      `${input.baseUrl.replace(/\/+$/, "")}/models/${input.model}:generateContent`,
    ).pipe(
      HttpClientRequest.setHeader("x-goog-api-key", input.apiKey),
      HttpClientRequest.bodyJson({
        contents: [{ parts: [{ text: input.text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } },
          },
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
    const pcm = new Uint8Array(NodeBuffer.Buffer.from(inlineData.data, "base64"));
    const sampleRate = Number(/rate=(\d+)/.exec(inlineData.mimeType ?? "")?.[1] ?? 24_000);
    return { bytes: pcmToWav(pcm, sampleRate), mimeType: "audio/wav" as const };
  });

  const synthesize = Effect.fn("TextToSpeech.synthesize")(function* (input: {
    readonly text: string;
  }) {
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
        text: input.text,
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
        input: input.text,
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
    dropExpiredClips(now);
    while (clips.size >= MAX_CACHED_CLIPS) {
      const oldest = clips.keys().next();
      if (oldest.done) break;
      clips.delete(oldest.value);
    }
    const expiresAt = now + CLIP_TTL_MS;
    clips.set(token, { bytes: input.bytes, mimeType: input.mimeType, expiresAt });
    return { relativeUrl: `/api/tts-audio/${token}`, expiresAt };
  });

  const clip = (token: string): Effect.Effect<Option.Option<TtsClip>> =>
    Effect.gen(function* () {
      const cached = clips.get(token);
      if (cached === undefined) return Option.none();
      if (cached.expiresAt <= (yield* Clock.currentTimeMillis)) {
        clips.delete(token);
        return Option.none();
      }
      return Option.some({ bytes: cached.bytes, mimeType: cached.mimeType });
    });

  return TextToSpeech.of({ synthesize, clip });
});

export const layer = Layer.effect(TextToSpeech, make);
