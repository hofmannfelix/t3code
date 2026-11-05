import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

import { getWhisperVoiceTranscriber } from "../features/voice-input/whisperTranscription";
import type { Preferences } from "../persistence/mobile-preferences";

/**
 * The cloud Whisper transcriber chosen in Voice settings, or null when the on-device
 * transcriber should run. On-device availability is async, so callers fall back to it.
 */
export function getCloudVoiceTranscriber(preferences?: Preferences): VoiceTranscriber | null {
  const provider = preferences?.voiceTranscriptionProvider;
  if (provider === "apple") return null;
  if (provider === "groq" || provider === "openai" || provider === "custom") {
    return getWhisperVoiceTranscriber(preferences);
  }
  if (
    preferences?.voiceTranscriptionApiKey?.trim() ||
    preferences?.voiceTranscriptionCustomEndpoint?.trim()
  ) {
    return getWhisperVoiceTranscriber(preferences);
  }
  return null;
}

/** Without an on-device transcriber, Groq Whisper is the default unless on-device was chosen. */
export function getFallbackVoiceTranscriber(preferences?: Preferences): VoiceTranscriber | null {
  return preferences?.voiceTranscriptionProvider === "apple"
    ? null
    : getWhisperVoiceTranscriber(preferences);
}
