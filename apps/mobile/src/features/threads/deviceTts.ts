import { File, Paths } from "expo-file-system";
// expo/fetch streams `response.body` incrementally; the global React Native
// fetch buffers the whole reply first, which would delay audio to the very end.
import { fetch } from "expo/fetch";

import type { Preferences } from "../../persistence/mobile-preferences";
import { cleanTextForSpeech } from "@t3tools/shared/textForSpeech";

export const GEMINI_TTS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_TTS_DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
export const GEMINI_TTS_DEFAULT_VOICE = "Kore";

/** Stage logging for the device pipeline; visible in Metro during development. */
const log = (...args: unknown[]) => {
  if (typeof __DEV__ !== "undefined" && __DEV__) console.log("[read-aloud]", ...args);
};

export interface DeviceTtsConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
}

export class DeviceTtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceTtsError";
  }
}

/**
 * Device-local read-aloud synthesis: the default read-aloud path whenever a
 * Gemini key exists on this device. The paired server's provider stays
 * available via the explicit "server" choice in settings.
 */
export function getDeviceTtsConfig(preferences?: Preferences): DeviceTtsConfig | null {
  const prefs = preferences ?? {};
  const provider = prefs.readAloudProvider ?? "gemini";
  if (provider !== "gemini") return null;
  const apiKey = prefs.readAloudGeminiApiKey?.trim() ?? "";
  if (apiKey.length === 0) return null;
  return {
    apiKey,
    model: prefs.readAloudGeminiModel?.trim() || GEMINI_TTS_DEFAULT_MODEL,
    voice: prefs.readAloudGeminiVoice?.trim() || GEMINI_TTS_DEFAULT_VOICE,
  };
}

/**
 * Gemini 2.5-era TTS answers headerless 16-bit mono PCM that needs a RIFF
 * container before the player accepts it; 3.x answers complete WAV.
 */
export const pcmToWav = (pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16) => {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const magic = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  magic(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  magic(8, "WAVE");
  magic(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  magic(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
};

export const decodeBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

interface GeminiAudio {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/**
 * Extracts retry delay seconds from Google's 429 response body.
 */
export function parseRetryInfoFromResponse(jsonBody: unknown): number | null {
  if (typeof jsonBody !== "object" || jsonBody === null) return null;
  const body = jsonBody as {
    error?: { details?: Array<{ "@type"?: string; retryDelay?: string }> };
  };
  const retryInfo = body.error?.details?.find((detail) =>
    (detail["@type"] ?? "").endsWith("RetryInfo"),
  );
  if (retryInfo?.retryDelay) {
    const seconds = parseFloat(retryInfo.retryDelay.replace("s", ""));
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  }
  return null;
}

/**
 * Scans a range of PCM bytes to find the best split point (lowest energy / silence window)
 * between words or sentences, preventing abrupt cuts in the middle of active phonemes.
 */
export function findSilenceCutPoint(
  pcm: Uint8Array,
  minBytes: number,
  maxBytes: number,
  sampleRate = 24_000,
): number {
  const safeMin = Math.max(0, Math.floor(minBytes / 2) * 2);
  const safeMax = Math.min(pcm.length, Math.floor(maxBytes / 2) * 2);

  if (safeMax <= safeMin) return safeMin;

  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const startSample = Math.floor(safeMin / 2);
  const endSample = Math.floor(safeMax / 2);

  // 20ms window (480 samples at 24kHz), capped if search range is smaller
  const rangeSamples = endSample - startSample;
  const windowSamples = Math.max(1, Math.min(Math.floor((sampleRate * 20) / 1000), rangeSamples));
  const stepSamples = Math.max(1, Math.floor(windowSamples / 2)); // 10ms steps

  let minEnergy = Infinity;
  let bestSampleIndex = startSample;

  for (let s = startSample; s + windowSamples <= endSample; s += stepSamples) {
    let energy = 0;
    for (let i = 0; i < windowSamples; i++) {
      energy += Math.abs(samples[s + i]!);
    }
    if (energy < minEnergy) {
      minEnergy = energy;
      bestSampleIndex = s + Math.floor(windowSamples / 2);
      // Clear silence detected (average amplitude < 150 out of 32767) -> break early
      if (energy / windowSamples < 150) {
        break;
      }
    }
  }

  return bestSampleIndex * 2;
}

/**
 * Applies a gentle linear fade-in and fade-out to the edges of a PCM chunk
 * to eliminate clicks and DC offset pops at segment boundaries.
 */
export function applyEdgeSmoothing(pcm: Uint8Array, fadeSamples = 72): Uint8Array {
  const copy = new Uint8Array(pcm);
  const evenSamplesCount = Math.floor(copy.byteLength / 2);
  const samples = new Int16Array(copy.buffer, copy.byteOffset, evenSamplesCount);
  const count = Math.min(fadeSamples, Math.floor(evenSamplesCount / 2));

  // 3ms Fade-In
  for (let i = 0; i < count; i++) {
    const factor = i / count;
    samples[i] = Math.round(samples[i]! * factor);
  }
  // 3ms Fade-Out
  for (let i = 0; i < count; i++) {
    const factor = (count - 1 - i) / count;
    samples[evenSamplesCount - count + i] = Math.round(
      samples[evenSamplesCount - count + i]! * factor,
    );
  }

  return copy;
}

/**
 * Unary Gemini TTS call, mirroring the server's synthesizeWithGemini: 3.x
 * answers complete WAV, 2.5-era answers PCM with a rate parameter that gets
 * wrapped here so the player receives a container it understands.
 */
async function synthesizeBytes(
  config: DeviceTtsConfig,
  text: string,
  signal: AbortSignal,
): Promise<GeminiAudio> {
  const isGemini3 = /gemini-3/.test(config.model);
  const speechConfig = isGemini3
    ? { voiceConfig: { voice: config.voice } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } };

  const response = await fetch(`${GEMINI_TTS_BASE_URL}/models/${config.model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig,
      },
    }),
    signal,
  });
  if (!response.ok) {
    throw new DeviceTtsError(`Gemini rejected the speech request with status ${response.status}.`);
  }
  const json = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };
  const inlineData = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (typeof inlineData?.data !== "string" || inlineData.data.length === 0) {
    throw new DeviceTtsError("Gemini returned no audio for this reply.");
  }
  const bytes = decodeBase64(inlineData.data);
  if ((inlineData.mimeType ?? "").includes("wav")) {
    return { bytes, mimeType: "audio/wav" };
  }
  const sampleRate = Number(/rate=(\d+)/.exec(inlineData.mimeType ?? "")?.[1] ?? 24_000);
  return { bytes: pcmToWav(bytes, sampleRate), mimeType: "audio/wav" };
}

/** Clip files live in the cache; the system clears them under storage pressure. */
let clipCounter = 0;

/**
 * Optimized segment bounds:
 * First segment: ~1.8s (min) to ~2.6s (max) for fast lead audio response.
 * Subsequent segments: ~3.5s (min) to ~5.0s (max) to give plenty of buffer for gapless playback.
 */
export const STREAM_FIRST_MIN_BYTES = Math.floor(1.8 * 24_000 * 2); // 86,400 bytes
export const STREAM_FIRST_MAX_BYTES = Math.floor(2.6 * 24_000 * 2); // 124,800 bytes
export const STREAM_NEXT_MIN_BYTES = Math.floor(3.5 * 24_000 * 2); // 168,000 bytes
export const STREAM_NEXT_MAX_BYTES = Math.floor(5.0 * 24_000 * 2); // 240,000 bytes

export const STREAM_FIRST_SEGMENT_PCM_BYTES = STREAM_FIRST_MIN_BYTES;
export const STREAM_SEGMENT_PCM_BYTES = STREAM_NEXT_MIN_BYTES;

/**
 * Streams `text` as ready-to-play WAV segment files using a single SSE connection.
 * Uses silence-detection cut points and edge smoothing to prevent clipping and clicks.
 */
export async function* streamWavSegments(
  config: DeviceTtsConfig,
  rawText: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const text = cleanTextForSpeech(rawText);
  if (!text) return;
  const isGemini3 = /gemini-3/.test(config.model);
  const speechConfig = isGemini3
    ? { voiceConfig: { voice: config.voice } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } };

  let attempt = 0;
  const maxAttempts = 3;
  let response: Response | null = null;

  while (attempt < maxAttempts) {
    if (signal.aborted) return;
    attempt += 1;

    const res = await fetch(
      `${GEMINI_TTS_BASE_URL}/models/${config.model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": config.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig,
          },
        }),
        signal,
      },
    );

    log(
      "stream: HTTP",
      res.status,
      `${config.model}`,
      `${text.length} chars (attempt ${attempt}/${maxAttempts})`,
    );

    if (res.status === 429) {
      let retryDelayMs = 4_000;
      try {
        const json = await res.json();
        const parsedSec = parseRetryInfoFromResponse(json);
        if (parsedSec) retryDelayMs = Math.ceil(parsedSec * 1000);
      } catch {}
      log(`stream: 429 rate limit received. Waiting ${retryDelayMs}ms before retry...`);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new DeviceTtsError("Gemini rejected the speech request with status 429 (rate limit).");
    }

    if (!res.ok) {
      throw new DeviceTtsError(`Gemini rejected the speech request with status ${res.status}.`);
    }
    if (!res.body) {
      throw new DeviceTtsError("Gemini's audio stream could not be read.");
    }

    response = res;
    break;
  }

  if (!response || !response.body) {
    return;
  }

  let pending = new Uint8Array();
  let isFirstSegment = true;
  let segmentIndex = 0;
  const decoder = new TextDecoder();
  let sseBuffer = "";

  const writeSegment = async (pcm: Uint8Array): Promise<string> => {
    segmentIndex += 1;
    const file = Paths.cache.createFile(
      `read-aloud-${Date.now()}-${segmentIndex}.wav`,
      "audio/wav",
    );
    const writer = file.writableStream().getWriter();
    await writer.write(pcmToWav(pcm, 24_000));
    await writer.close();
    if (!file.exists) {
      throw new DeviceTtsError("The synthesized audio clip could not be stored on this device.");
    }
    return file.uri;
  };

  const reader = response.body.getReader();
  let firstPcmAt: number | null = null;
  const streamStartedAt = Date.now();
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = sseBuffer.indexOf("\n\n");
      while (boundary !== -1) {
        const eventText = sseBuffer.slice(0, boundary);
        sseBuffer = sseBuffer.slice(boundary + 2);
        for (const line of eventText.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          try {
            const data = (
              JSON.parse(payload) as {
                candidates?: Array<{
                  content?: { parts?: Array<{ inlineData?: { data?: string } }> };
                }>;
              }
            ).candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (typeof data === "string" && data.length > 0) {
              if (firstPcmAt === null) {
                firstPcmAt = Date.now() - streamStartedAt;
                log("stream: first PCM chunk", `${firstPcmAt}ms`, `${data.length} base64 chars`);
              }
              const pcm = decodeBase64(data);
              const merged = new Uint8Array(pending.length + pcm.length);
              merged.set(pending);
              merged.set(pcm, pending.length);
              pending = merged;
            }
          } catch {
            // Skip keepalives / non-audio events
          }
        }

        let minBytes = isFirstSegment ? STREAM_FIRST_MIN_BYTES : STREAM_NEXT_MIN_BYTES;
        let maxBytes = isFirstSegment ? STREAM_FIRST_MAX_BYTES : STREAM_NEXT_MAX_BYTES;

        while (pending.length >= maxBytes) {
          const cutPoint = findSilenceCutPoint(pending, minBytes, maxBytes);
          const rawSegment = pending.subarray(0, cutPoint);
          const smoothedSegment = applyEdgeSmoothing(rawSegment);
          pending = pending.slice(cutPoint);
          isFirstSegment = false;
          minBytes = STREAM_NEXT_MIN_BYTES;
          maxBytes = STREAM_NEXT_MAX_BYTES;

          const uri = await writeSegment(smoothedSegment);
          log("stream: segment", segmentIndex, "written", uri);
          yield uri;
          if (signal.aborted) return;
        }

        boundary = sseBuffer.indexOf("\n\n");
      }
    }
    if (pending.length > 0) {
      const smoothedSegment = applyEdgeSmoothing(pending);
      const uri = await writeSegment(smoothedSegment);
      log("stream: final segment written", uri);
      yield uri;
    }
    log("stream: complete", `${Date.now() - streamStartedAt}ms`, `${segmentIndex} segments`);
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Synthesizes `text` on the device and stores the WAV clip in the cache,
 * returning the file URI the audio player plays.
 */
export async function synthesizeClipFile(
  config: DeviceTtsConfig,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const audio = await synthesizeBytes(config, text, signal);
  clipCounter += 1;
  const file = Paths.cache.createFile(`read-aloud-${Date.now()}-${clipCounter}.wav`, "audio/wav");
  const writer = file.writableStream().getWriter();
  await writer.write(audio.bytes);
  await writer.close();
  if (!file.exists) {
    throw new DeviceTtsError("The synthesized audio clip could not be stored on this device.");
  }
  return file.uri;
}
