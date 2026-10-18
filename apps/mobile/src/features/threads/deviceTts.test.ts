import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  writtenFiles: vi.fn<() => Array<{ uri: string; bytes: Uint8Array }>>(),
  expoFetch: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class FileClass {
    uri: string;
    #bytes: Uint8Array = new Uint8Array();
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("");
    }
    writableStream() {
      const file = this;
      const chunks: Uint8Array[] = [];
      return {
        getWriter: () => ({
          write: async (chunk: Uint8Array) => {
            chunks.push(chunk);
          },
          close: async () => {
            file.#bytes = chunks[0] ?? new Uint8Array();
            mocks.writtenFiles().push({ uri: file.uri, bytes: file.#bytes });
          },
        }),
      };
    }
    get exists() {
      return true;
    }
  }
  return {
    File: FileClass,
    Paths: {
      cache: {
        createFile: (name: string) => new FileClass(`file:///cache/${name}`),
      },
    },
  };
});

// deviceTts.ts imports the named `fetch` from expo/fetch; the module mock
// keeps vitest away from React Native's Flow sources and lets every test
// install its own network behavior.
vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => mocks.expoFetch(...args),
}));

import {
  GEMINI_TTS_BASE_URL,
  GEMINI_TTS_DEFAULT_MODEL,
  STREAM_FIRST_MIN_BYTES,
  STREAM_FIRST_MAX_BYTES,
  STREAM_NEXT_MIN_BYTES,
  STREAM_NEXT_MAX_BYTES,
  applyEdgeSmoothing,
  findSilenceCutPoint,
  getDeviceTtsConfig,
  parseRetryInfoFromResponse,
  streamWavSegments,
  synthesizeClipFile,
} from "./deviceTts";

const WAV_BASE64 = btoa("RIFF-WAV-AUDIO");

function geminiResponse(inlineData: { data: string; mimeType: string }): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ inlineData }] },
        },
      ],
    }),
    { status: 200 },
  );
}

const signal = new AbortController().signal;

describe("getDeviceTtsConfig", () => {
  it("defaults to device Gemini whenever a key exists", () => {
    expect(getDeviceTtsConfig(undefined)).toBeNull();
    expect(getDeviceTtsConfig({ readAloudGeminiApiKey: " k " })).toEqual({
      apiKey: "k",
      model: GEMINI_TTS_DEFAULT_MODEL,
      voice: "Kore",
    });
  });

  it("stays off without a key or on the explicit server choice", () => {
    expect(
      getDeviceTtsConfig({ readAloudProvider: "server", readAloudGeminiApiKey: "k" }),
    ).toBeNull();
    expect(getDeviceTtsConfig({ readAloudProvider: "gemini" })).toBeNull();
  });
});

describe("synthesizeClipFile", () => {
  beforeEach(() => {
    mocks.writtenFiles.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores complete WAV answers as a cache clip", async () => {
    mocks.expoFetch.mockImplementation(async () =>
      geminiResponse({ data: WAV_BASE64, mimeType: "audio/wav" }),
    );
    const fetchMock = mocks.expoFetch;

    const uri = await synthesizeClipFile(
      { apiKey: "k", model: "gemini-3.8-flash-lite-tts", voice: "Orbit" },
      "Hallo.",
      signal,
    );

    expect(uri).toMatch(/^file:\/\/\/cache\/read-aloud-\d+-1\.wav$/);
    const [endpoint, request] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(endpoint).toContain(":generateContent");
    expect((request.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(request.body as string);
    expect(body.generationConfig.speechConfig.voiceConfig.voice).toBe("Orbit");
    expect(mocks.writtenFiles()[0]!.bytes).toEqual(new Uint8Array(Buffer.from("RIFF-WAV-AUDIO")));
  });

  it("wraps headerless PCM answers into a WAV container", async () => {
    // Three PCM samples decode to [1, 2, 3]; the container is a 44-byte RIFF header.
    mocks.expoFetch.mockImplementation(async () =>
      geminiResponse({
        data: btoa(String.fromCharCode(1, 0, 2, 0, 3, 0)),
        mimeType: "audio/l16; rate=24000; channels=1",
      }),
    );

    await synthesizeClipFile(
      { apiKey: "k", model: "gemini-3.8-flash-lite-tts", voice: "Kore" },
      "Hallo.",
      signal,
    );

    const clip = mocks.writtenFiles()[0]!;
    const view = new DataView(clip.bytes.buffer);
    expect(clip.bytes.length).toBe(44 + 6);
    expect(String.fromCharCode(...clip.bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(clip.bytes.slice(44)).toEqual(new Uint8Array([1, 0, 2, 0, 3, 0]));
  });

  it("surfaces provider rejections with the status", async () => {
    mocks.expoFetch.mockImplementation(async () => new Response("quota exceeded", { status: 400 }));

    await expect(
      synthesizeClipFile(
        { apiKey: "k", model: "gemini-3.8-flash-lite-tts", voice: "Kore" },
        "Hallo.",
        signal,
      ),
    ).rejects.toThrow("status 400");
  });
});

describe("findSilenceCutPoint", () => {
  it("cuts at the silence region within bounds", () => {
    // 24kHz mono 16-bit: 2 bytes per sample
    // Create 5000 samples: 2000 loud (5000), 1000 silent (10), 2000 loud (5000)
    const samples = new Int16Array(5000);
    samples.fill(5000, 0, 2000);
    samples.fill(10, 2000, 3000);
    samples.fill(5000, 3000, 5000);
    const pcm = new Uint8Array(samples.buffer);

    // Search between sample 1000 (2000 bytes) and sample 4000 (8000 bytes)
    const cut = findSilenceCutPoint(pcm, 2000, 8000, 24_000);
    const cutSample = cut / 2;
    // Should cut within the silent region (between 2000 and 3000)
    expect(cutSample).toBeGreaterThanOrEqual(2000);
    expect(cutSample).toBeLessThanOrEqual(3000);
  });
});

describe("applyEdgeSmoothing", () => {
  it("smooths the leading and trailing samples with a linear fade", () => {
    const samples = new Int16Array(200);
    samples.fill(1000);
    const pcm = new Uint8Array(samples.buffer);

    const smoothedBytes = applyEdgeSmoothing(pcm, 10);
    const smoothed = new Int16Array(smoothedBytes.buffer);

    // First sample should fade in from 0
    expect(smoothed[0]).toBe(0);
    expect(smoothed[5]).toBe(500);
    // Middle sample untouched
    expect(smoothed[50]).toBe(1000);
    // Last sample should fade down
    expect(smoothed[199]).toBe(0);
  });
});

describe("parseRetryInfoFromResponse", () => {
  it("extracts retryDelay seconds from Google 429 response body", () => {
    const errorBody = {
      error: {
        code: 429,
        message: "Resource exhausted",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "3.5s",
          },
        ],
      },
    };
    expect(parseRetryInfoFromResponse(errorBody)).toBe(3.5);
  });

  it("returns null when no retry info is present", () => {
    expect(parseRetryInfoFromResponse({})).toBeNull();
    expect(parseRetryInfoFromResponse(null)).toBeNull();
  });
});

const pcmBase64 = (byteCount: number, fill: number): string => {
  const bytes = new Uint8Array(byteCount).fill(fill);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

const sseEvent = (pcmBase64Payload: string): string =>
  JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { data: pcmBase64Payload } }] } }],
  });

/** A Gemini-style SSE response whose payload arrives in small network slices. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const payload = events.map((event) => `data: ${event}\r\n\r\n`).join("");
  const bytes = encoder.encode(payload);
  const cut = Math.ceil(bytes.length / 3);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, cut));
      controller.enqueue(bytes.subarray(cut));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("streamWavSegments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields WAV segments as PCM accumulates and flushes the tail at stream end", async () => {
    mocks.expoFetch.mockImplementation(async () =>
      sseResponse([
        sseEvent(pcmBase64(STREAM_FIRST_MAX_BYTES, 1)),
        sseEvent(pcmBase64(STREAM_NEXT_MAX_BYTES, 2)),
        sseEvent(pcmBase64(1_000, 3)),
      ]),
    );

    const uris: string[] = [];
    for await (const uri of streamWavSegments(
      { apiKey: "k", model: GEMINI_TTS_DEFAULT_MODEL, voice: "Kore" },
      "Hallo.",
      signal,
    )) {
      uris.push(uri);
    }

    expect(uris).toHaveLength(3);
    const written = mocks.writtenFiles();
    expect(written).toHaveLength(3);

    // Total PCM bytes written across segments equals total bytes sent
    const totalPcmBytes = written.reduce((sum, file) => sum + (file.bytes.length - 44), 0);
    expect(totalPcmBytes).toBe(STREAM_FIRST_MAX_BYTES + STREAM_NEXT_MAX_BYTES + 1_000);

    // Every segment is a standalone WAV with RIFF header
    for (const file of written) {
      expect(String.fromCharCode(...file.bytes.slice(0, 4))).toBe("RIFF");
    }
  });

  it("finishes quietly when the stream is aborted", async () => {
    mocks.expoFetch.mockImplementation((_url: unknown, request: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${sseEvent(pcmBase64(STREAM_FIRST_MAX_BYTES, 1))}\r\n\r\n`,
            ),
          );
          // A real fetch stops delivering when its signal aborts.
          request.signal?.addEventListener("abort", () => controller.close());
        },
      });
      return new Response(stream, { status: 200 });
    });

    const controller = new AbortController();
    const segments: string[] = [];
    for await (const uri of streamWavSegments(
      { apiKey: "k", model: GEMINI_TTS_DEFAULT_MODEL, voice: "Kore" },
      "Hallo.",
      controller.signal,
    )) {
      segments.push(uri);
      controller.abort();
    }
    expect(segments).toHaveLength(1);
  });

  it("hits the configured endpoint", async () => {
    mocks.expoFetch.mockImplementation(async () => sseResponse([sseEvent(pcmBase64(10, 1))]));
    const fetchMock = mocks.expoFetch;

    for await (const _ of streamWavSegments(
      { apiKey: "k", model: GEMINI_TTS_DEFAULT_MODEL, voice: "Kore" },
      "Hallo.",
      signal,
    )) {
      // Drain.
    }

    const [endpoint] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(endpoint).toBe(
      `${GEMINI_TTS_BASE_URL}/models/${GEMINI_TTS_DEFAULT_MODEL}:streamGenerateContent?alt=sse`,
    );
  });
});
