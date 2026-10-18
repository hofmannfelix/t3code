import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = mocks.readAudio;
  },
}));

import {
  GROQ_DEFAULT_MODEL,
  GROQ_WHISPER_ENDPOINT,
  getWhisperVoiceTranscriber,
} from "./whisperTranscription";

/** Records parts the way React Native's FormData does, without web Blob validation. */
class RecordingFormData {
  readonly parts: Array<[string, unknown]> = [];
  append(key: string, value: unknown) {
    this.parts.push([key, value]);
  }
}

const audio = new ArrayBuffer(8);

function partValue(parts: Array<[string, unknown]>, key: string): unknown {
  const part = parts.find(([name]) => name === key);
  expect(part, `missing form part "${key}"`).toBeDefined();
  return part![1];
}

describe("getWhisperVoiceTranscriber", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readAudio.mockResolvedValue(audio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uploads the recording as a bytes() part Expo's fetch can serialize", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: " hallo welt " }),
    }));
    vi.stubGlobal("FormData", RecordingFormData);
    vi.stubGlobal("fetch", fetchMock);

    const transcriber = getWhisperVoiceTranscriber({
      voiceTranscriptionProvider: "groq",
      voiceTranscriptionApiKey: "gsk_test",
    })!;
    const prepared = await transcriber.prepare({ signal: new AbortController().signal });
    await expect(
      prepared.transcribe("file:///voice.m4a", { signal: new AbortController().signal }),
    ).resolves.toBe("hallo welt");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, request] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(endpoint).toBe(GROQ_WHISPER_ENDPOINT);
    expect(request.method).toBe("POST");
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test");

    const formData = request.body as unknown as RecordingFormData;
    expect(formData.parts.map(([name]) => name)).toEqual(["file", "model"]);
    const file = partValue(formData.parts, "file") as {
      name?: string;
      type?: string;
      bytes: () => Uint8Array;
    };
    expect(file.name).toBe("recording.m4a");
    expect(file.type).toBe("audio/m4a");
    expect(file.bytes()).toEqual(new Uint8Array(audio));
    expect(partValue(formData.parts, "model")).toBe(GROQ_DEFAULT_MODEL);
  });

  it("fails preparation with the actionable message when the Groq key is missing", async () => {
    const transcriber = getWhisperVoiceTranscriber({ voiceTranscriptionProvider: "groq" })!;
    await expect(transcriber.prepare({ signal: new AbortController().signal })).rejects.toThrow(
      new VoiceTranscriptionError(
        "unavailable",
        "Please configure your Groq API key in Settings > Voice & Dictation.",
      ),
    );
  });
});
