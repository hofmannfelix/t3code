import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { type VoiceTranscriptionProvider } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { GEMINI_TTS_DEFAULT_MODEL, GEMINI_TTS_DEFAULT_VOICE } from "../threads/deviceTts";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

interface ProviderOption {
  readonly id: VoiceTranscriptionProvider;
  readonly label: string;
  readonly description: string;
}

const PROVIDER_OPTIONS: ReadonlyArray<ProviderOption> = [
  {
    id: "groq",
    label: "Groq Whisper (Recommended)",
    description: "Ultra-fast cloud transcription (~300ms) with whisper-large-v3-turbo.",
  },
  {
    id: "openai",
    label: "OpenAI Whisper",
    description: "Cloud transcription using OpenAI whisper-1.",
  },
  {
    id: "apple",
    label: "Apple Speech (On-Device)",
    description: "Private on-device transcription (requires iOS 26+ and Apple Intelligence).",
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    description: "OpenAI-compatible server (self-hosted Whisper, Ollama, LocalAI, etc.).",
  },
];

export function SettingsVoiceInputRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;

  const preferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;
  const currentProvider: VoiceTranscriptionProvider =
    preferences?.voiceTranscriptionProvider ?? "groq";

  const [apiKey, setApiKey] = useState(preferences?.voiceTranscriptionApiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [customEndpoint, setCustomEndpoint] = useState(
    preferences?.voiceTranscriptionCustomEndpoint ?? "",
  );
  const [customModel, setCustomModel] = useState(preferences?.voiceTranscriptionCustomModel ?? "");

  const handleSelectProvider = (provider: VoiceTranscriptionProvider) => {
    savePreferences({ voiceTranscriptionProvider: provider });
  };

  const handleSaveApiKey = (value: string) => {
    setApiKey(value);
    savePreferences({ voiceTranscriptionApiKey: value.trim() });
  };

  const handleSaveCustomEndpoint = (value: string) => {
    setCustomEndpoint(value);
    savePreferences({ voiceTranscriptionCustomEndpoint: value.trim() });
  };

  const handleSaveCustomModel = (value: string) => {
    setCustomModel(value);
    savePreferences({ voiceTranscriptionCustomModel: value.trim() });
  };

  const handleSelectReadAloudProvider = (provider: "server" | "gemini") => {
    savePreferences({ readAloudProvider: provider });
  };
  const handleSaveReadAloudApiKey = (value: string) => {
    savePreferences({ readAloudGeminiApiKey: value.trim() });
  };
  const handleSaveReadAloudModel = (value: string) => {
    savePreferences({ readAloudGeminiModel: value.trim() });
  };
  const handleSaveReadAloudVoice = (value: string) => {
    savePreferences({ readAloudGeminiVoice: value.trim() });
  };
  const handleSelectWaitingAudio = (waitingAudio: "music" | "silent") => {
    savePreferences({ readAloudWaitingAudio: waitingAudio });
  };

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert("Unable to open URL", url);
    });
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice & Dictation" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Speech Recognition Provider">
          {PROVIDER_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.id}
              label={option.label}
              description={option.description}
              selected={currentProvider === option.id}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => handleSelectProvider(option.id)}
            />
          ))}
        </SettingsSection>

        {currentProvider === "groq" || currentProvider === "openai" ? (
          <SettingsSection title={currentProvider === "groq" ? "Groq API Key" : "OpenAI API Key"}>
            <View className="gap-3 p-4">
              <View className="relative">
                <AppTextInput
                  value={apiKey}
                  onChangeText={handleSaveApiKey}
                  placeholder={currentProvider === "groq" ? "gsk_..." : "sk-..."}
                  secureTextEntry={!showKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  className="pr-12"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={showKey ? "Hide API Key" : "Show API Key"}
                  onPress={() => setShowKey(!showKey)}
                  className="absolute right-3 top-3.5 p-1"
                >
                  <SymbolView
                    name={showKey ? "eye.slash" : "eye"}
                    size={20}
                    tintColorClassName="accent-icon"
                  />
                </Pressable>
              </View>

              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-foreground-muted">
                  {currentProvider === "groq"
                    ? "Groq provides high-accuracy, ultra-low latency Whisper."
                    : "Standard cloud transcription using OpenAI Whisper."}
                </Text>
                <Pressable
                  onPress={() =>
                    openUrl(
                      currentProvider === "groq"
                        ? "https://console.groq.com/keys"
                        : "https://platform.openai.com/api-keys",
                    )
                  }
                  className="active:opacity-70"
                >
                  <Text className="text-sm font-medium text-accent">Get API Key</Text>
                </Pressable>
              </View>
            </View>
          </SettingsSection>
        ) : null}

        {currentProvider === "custom" ? (
          <SettingsSection title="Custom Whisper Server">
            <View className="gap-4 p-4">
              <View className="gap-1.5">
                <Text className="text-sm font-medium text-foreground">Endpoint URL</Text>
                <AppTextInput
                  value={customEndpoint}
                  onChangeText={handleSaveCustomEndpoint}
                  placeholder="https://api.example.com/v1/audio/transcriptions"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-sm font-medium text-foreground">Model Name (optional)</Text>
                <AppTextInput
                  value={customModel}
                  onChangeText={handleSaveCustomModel}
                  placeholder="whisper-1"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-sm font-medium text-foreground">API Key (optional)</Text>
                <View className="relative">
                  <AppTextInput
                    value={apiKey}
                    onChangeText={handleSaveApiKey}
                    placeholder="Bearer token or secret key"
                    secureTextEntry={!showKey}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="pr-12"
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={showKey ? "Hide API Key" : "Show API Key"}
                    onPress={() => setShowKey(!showKey)}
                    className="absolute right-3 top-3.5 p-1"
                  >
                    <SymbolView
                      name={showKey ? "eye.slash" : "eye"}
                      size={20}
                      tintColorClassName="accent-icon"
                    />
                  </Pressable>
                </View>
              </View>
            </View>
          </SettingsSection>
        ) : null}

        {currentProvider === "apple" ? (
          <View className="rounded-2xl border border-border-subtle bg-grouped-card p-4">
            <Text className="text-base font-semibold text-foreground">
              Apple On-Device Recognition
            </Text>
            <Text className="mt-1 text-sm leading-relaxed text-foreground-muted">
              Audio stays completely on your device. This engine is powered by Apple Intelligence
              and requires a compatible iPhone / iPad running iOS 26 or newer.
            </Text>
          </View>
        ) : null}

        <ReadAloudSection
          provider={preferences?.readAloudProvider ?? "server"}
          apiKey={preferences?.readAloudGeminiApiKey ?? ""}
          model={preferences?.readAloudGeminiModel ?? ""}
          voice={preferences?.readAloudGeminiVoice ?? ""}
          waitingAudio={preferences?.readAloudWaitingAudio ?? "music"}
          preferencesReady={preferencesReady}
          onProviderChange={handleSelectReadAloudProvider}
          onApiKeyChange={handleSaveReadAloudApiKey}
          onModelChange={handleSaveReadAloudModel}
          onVoiceChange={handleSaveReadAloudVoice}
          onWaitingAudioChange={handleSelectWaitingAudio}
        />
      </ScrollView>
    </View>
  );
}

interface ReadAloudSectionProps {
  readonly apiKey: string;
  readonly model: string;
  readonly preferencesReady: boolean;
  readonly provider: "server" | "gemini";
  readonly voice: string;
  readonly waitingAudio: "music" | "silent";
  readonly onApiKeyChange: (value: string) => void;
  readonly onModelChange: (value: string) => void;
  readonly onProviderChange: (provider: "server" | "gemini") => void;
  readonly onVoiceChange: (value: string) => void;
  readonly onWaitingAudioChange: (waitingAudio: "music" | "silent") => void;
}

const WAITING_AUDIO_OPTIONS = [
  {
    id: "music" as const,
    label: "Elevator music",
    description:
      "Plays elevator music while waiting for the assistant's reply to keep the audio session active.",
  },
  {
    id: "silent" as const,
    label: "Silent audio track (Nullmusik)",
    description: "Plays an inaudible track to keep the audio session active without sound.",
  },
];

const READ_ALOUD_PROVIDER_OPTIONS = [
  {
    id: "server" as const,
    label: "Paired server",
    description: "Uses the text-to-speech provider configured on your Mac.",
  },
  {
    id: "gemini" as const,
    label: "This device (Gemini)",
    description: "Synthesizes directly on the phone with its own Gemini API key.",
  },
];

function ReadAloudSection(props: ReadAloudSectionProps) {
  const [showKey, setShowKey] = useState(false);
  return (
    <View>
      <SettingsSection title="Read aloud">
        {READ_ALOUD_PROVIDER_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.id}
            label={option.label}
            description={option.description}
            selected={props.provider === option.id}
            separated={index > 0}
            disabled={!props.preferencesReady}
            onPress={() => props.onProviderChange(option.id)}
          />
        ))}
      </SettingsSection>
      {props.provider === "gemini" ? (
        <SettingsSection title="Gemini API Key">
          <View className="gap-3 p-4">
            <View className="relative">
              <AppTextInput
                value={props.apiKey}
                onChangeText={props.onApiKeyChange}
                placeholder="AIza..."
                secureTextEntry={!showKey}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                className="pr-12"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={showKey ? "Hide API Key" : "Show API Key"}
                onPress={() => setShowKey(!showKey)}
                className="absolute right-3 top-3.5 p-1"
              >
                <SymbolView
                  name={showKey ? "eye.slash" : "eye"}
                  size={20}
                  tintColorClassName="accent-icon"
                />
              </Pressable>
            </View>
            <Text className="text-sm text-foreground-muted">
              Gemini 3.x TTS speaks from this phone with your own key. Get one at{" "}
              <Text className="text-accent">aistudio.google.com</Text>.
            </Text>
            <AppTextInput
              value={props.model}
              onChangeText={props.onModelChange}
              placeholder={`Model (default ${GEMINI_TTS_DEFAULT_MODEL})`}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <AppTextInput
              value={props.voice}
              onChangeText={props.onVoiceChange}
              placeholder={`Voice (default ${GEMINI_TTS_DEFAULT_VOICE})`}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Background audio while waiting">
        {WAITING_AUDIO_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.id}
            label={option.label}
            description={option.description}
            selected={props.waitingAudio === option.id}
            separated={index > 0}
            disabled={!props.preferencesReady}
            onPress={() => props.onWaitingAudioChange(option.id)}
          />
        ))}
      </SettingsSection>
    </View>
  );
}
