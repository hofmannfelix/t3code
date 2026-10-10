import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { getWhisperVoiceTranscriber } from "../features/voice-input/whisperTranscription";
import type { Preferences } from "../persistence/mobile-preferences";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export function getVoiceTranscriber(preferences?: Preferences): VoiceTranscriber | null {
  return getWhisperVoiceTranscriber(preferences);
}
