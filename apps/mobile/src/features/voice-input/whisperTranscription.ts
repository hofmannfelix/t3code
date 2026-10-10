import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import type { Preferences } from "../../persistence/mobile-preferences";

export const GROQ_WHISPER_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";

export const OPENAI_WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_DEFAULT_MODEL = "whisper-1";

export function getWhisperVoiceTranscriber(
  preferences?: Preferences,
): VoiceTranscriber | null {
  const provider = preferences?.voiceTranscriptionProvider ?? "groq";
  if (provider === "apple") {
    return null;
  }

  const rawApiKey = preferences?.voiceTranscriptionApiKey?.trim() ?? "";
  const customEndpoint = preferences?.voiceTranscriptionCustomEndpoint?.trim() ?? "";
  const customModel = preferences?.voiceTranscriptionCustomModel?.trim() ?? "";
  const language = preferences?.voiceTranscriptionLanguage?.trim();

  let endpoint = "";
  let model = "";

  if (provider === "groq") {
    endpoint = GROQ_WHISPER_ENDPOINT;
    model = GROQ_DEFAULT_MODEL;
  } else if (provider === "openai") {
    endpoint = OPENAI_WHISPER_ENDPOINT;
    model = OPENAI_DEFAULT_MODEL;
  } else if (provider === "custom") {
    endpoint = customEndpoint || "http://localhost:8000/v1/audio/transcriptions";
    model = customModel || "whisper-1";
  } else {
    return null;
  }

  return {
    prepare: async ({ signal }: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);

      // Validate required credentials before proceeding
      if (provider !== "custom" && !rawApiKey) {
        const providerName = provider === "groq" ? "Groq" : "OpenAI";
        throw new VoiceTranscriptionError(
          "unavailable",
          `Please configure your ${providerName} API key in Settings > Voice & Dictation.`,
        );
      }

      if (provider === "custom" && !customEndpoint) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Please configure your Custom Whisper endpoint in Settings > Voice & Dictation.",
        );
      }

      return {
        locale: language && language !== "auto" ? language : "auto",
        transcribe: async (uri: string, options: VoiceTranscriptionOptions): Promise<string> => {
          throwIfVoiceTranscriptionAborted(options.signal);
          return transcribeWithWhisperApi({
            uri,
            endpoint,
            model,
            apiKey: rawApiKey,
            language: language && language !== "auto" ? language : undefined,
            signal: options.signal,
          });
        },
      };
    },
  };
}

async function transcribeWithWhisperApi({
  uri,
  endpoint,
  model,
  apiKey,
  language,
  signal,
}: {
  readonly uri: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly language?: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);

    const formData = new FormData();
    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;

    formData.append("file", {
      uri: fileUri,
      name: "recording.m4a",
      type: "audio/m4a",
    } as unknown as Blob);

    formData.append("model", model);
    if (language) {
      formData.append("language", language);
    }

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: formData,
      signal,
    });

    throwIfVoiceTranscriptionAborted(signal);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorMessage = `Transcription request failed (${response.status})`;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.error?.message) {
          errorMessage = parsed.error.message;
        } else if (typeof parsed.detail === "string") {
          errorMessage = parsed.detail;
        }
      } catch {
        if (errorText) {
          errorMessage += `: ${errorText.slice(0, 200)}`;
        }
      }
      throw new VoiceTranscriptionError("transcription-failed", errorMessage);
    }

    const json = await response.json();
    throwIfVoiceTranscriptionAborted(signal);

    if (typeof json.text !== "string") {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "Invalid response format: missing transcription text.",
      );
    }

    return json.text.trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (error instanceof VoiceTranscriptionError) throw error;
    throw new VoiceTranscriptionError(
      "transcription-failed",
      error instanceof Error ? error.message : "Voice transcription failed.",
      { cause: error },
    );
  }
}
