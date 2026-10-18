import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  createAudioPlaylist,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlaylist,
} from "expo-audio";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Alert, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "../agent-awareness/agentLiveActivity";
import type { AgentActivityProps, AgentActivityRowProps } from "../../widgets/AgentActivity";

import { usePreparedConnection } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobilePreferencesAtom } from "../../state/preferences";
import { AsyncResult, Atom } from "effect/reactivity";
import { Directory, File, Paths } from "expo-file-system";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { getDeviceTtsConfig, streamWavSegments } from "./deviceTts";
import { cleanTextForSpeech } from "@t3tools/shared/textForSpeech";

export interface ReadAloudSpeech {
  readonly key: string | null;
  readonly threadId: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly title: string | null;
  readonly projectTitle: string | null;
  readonly phase: "loading" | "playing" | "paused" | null;
  readonly source: "manual" | "auto" | null;
  readonly queued: number;
}

interface ReadItem {
  readonly key: string;
  readonly text: string;
  readonly source: "manual" | "auto";
  readonly threadId?: string;
  readonly environmentId?: EnvironmentId;
  readonly title?: string;
  readonly projectTitle?: string;
  /** Pre-rendered device clip; present skips synthesis and plays the file. */
  readonly clipUri?: string;
}

interface QueueEntry extends ReadItem {
  readonly dedupeKey: string;
}

interface ThreadFeedMessageEntry {
  readonly type: "message";
  readonly id?: string;
  readonly createdAt?: string;
  readonly message: {
    readonly id: string;
    readonly role: string;
    readonly streaming: boolean;
    readonly text: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  };
}

const T3NativeControls =
  Platform.OS === "ios"
    ? (requireOptionalNativeModule("T3NativeControls") as {
        speakText?: (
          text: string,
          options?: {
            language?: string;
            title?: string;
            projectTitle?: string;
            rate?: number;
          },
        ) => Promise<void>;
        stopSpeaking?: () => Promise<void>;
        pauseSpeaking?: () => Promise<void>;
        resumeSpeaking?: () => Promise<void>;
        isSpeaking?: () => boolean;
        deactivateAudioSession?: () => Promise<boolean>;
      } | null)
    : null;

const EMPTY_SETTINGS_ATOM = Atom.make<any>(null);

const START_WATCHDOG_MS = 5_000;
/**
 * Read-aloud contract: audio starts within 20s or fails visibly. Applies to
 * the device stream's first segment; playback itself is never cut off.
 */
export const STREAM_START_TIMEOUT_MS = 20_000;
/**
 * Server path: the provider may take 30s per attempt plus 429 retries, so
 * this side waits longer before surfacing "the server did not answer".
 */
export const SYNTHESIZE_TIMEOUT_MS = 60_000;

export interface ArmedReadAloudTarget {
  readonly threadId: string;
  readonly environmentId?: EnvironmentId | null;
  readonly threadTitle?: string;
  readonly projectTitle?: string;
  readonly armedAt?: number;
}

const armedTargets = new Map<string, ArmedReadAloudTarget>();
let cachedArmedTargets: ReadonlyArray<ArmedReadAloudTarget> = Object.freeze([]);
const armedTargetListeners = new Set<() => void>();

const notifyArmedTargetListeners = () => {
  for (const listener of armedTargetListeners) {
    listener();
  }
};

export function resolveProjectTitle(options: {
  readonly environmentId?: EnvironmentId | null;
  readonly threadId?: string | null;
  readonly projectTitle?: string | null;
}): string {
  if (options.projectTitle && options.projectTitle.trim().length > 0) {
    return options.projectTitle.trim();
  }
  if (options.threadId) {
    const armed = armedTargets.get(options.threadId);
    if (armed?.projectTitle && armed.projectTitle.trim().length > 0) {
      return armed.projectTitle.trim();
    }
  }
  return "T3 Code";
}

export function prefixTextWithProject(
  text: string,
  options: {
    readonly environmentId?: EnvironmentId | null;
    readonly threadId?: string | null;
    readonly projectTitle?: string | null;
  },
): string {
  const projectTitle = resolveProjectTitle(options);
  const expectedPrefix = `Thread ${projectTitle}:`;
  const trimmed = text.trim();
  if (
    trimmed.startsWith(expectedPrefix) ||
    trimmed.startsWith(`Thread ${projectTitle}.`) ||
    trimmed.toLowerCase().startsWith(`thread ${projectTitle.toLowerCase()}:`) ||
    trimmed.toLowerCase().startsWith(`thread ${projectTitle.toLowerCase()}.`)
  ) {
    return text;
  }
  return `${expectedPrefix} ${trimmed}`;
}

export const armReadAloudOnNextReply = (
  input:
    | string
    | {
        threadId: string;
        environmentId?: EnvironmentId | null;
        threadTitle?: string;
        projectTitle?: string;
      },
) => {
  const threadId = typeof input === "string" ? input : input.threadId;
  const environmentId =
    typeof input === "string"
      ? (activeSpeechEnvironmentId ?? null)
      : (input.environmentId ?? activeSpeechEnvironmentId ?? null);
  const threadTitle = typeof input === "string" ? undefined : input.threadTitle;
  const projectTitle = typeof input === "string" ? undefined : input.projectTitle;

  const previous = armedTargets.get(threadId);
  const nextTarget: ArmedReadAloudTarget = {
    threadId,
    environmentId,
    threadTitle: threadTitle ?? previous?.threadTitle,
    projectTitle: projectTitle ?? previous?.projectTitle,
    armedAt: Date.now(),
  };

  const isUnchanged =
    previous !== undefined &&
    previous.threadId === nextTarget.threadId &&
    previous.environmentId === nextTarget.environmentId &&
    previous.threadTitle === nextTarget.threadTitle &&
    previous.projectTitle === nextTarget.projectTitle;

  if (!isUnchanged) {
    armedTargets.set(threadId, nextTarget);
    cachedArmedTargets = Object.freeze(Array.from(armedTargets.values()));
    notifyArmedTargetListeners();
  }
};

export const disarmReadAloudOnNextReply = (threadId: string) => {
  if (armedTargets.delete(threadId)) {
    cachedArmedTargets = Object.freeze(Array.from(armedTargets.values()));
    notifyArmedTargetListeners();
  }
};

export const clearArmedReadAloudTargets = () => {
  if (armedTargets.size > 0) {
    armedTargets.clear();
    cachedArmedTargets = Object.freeze([]);
    notifyArmedTargetListeners();
  }
};

export const isReadAloudArmedOnNextReply = (threadId: string) => {
  return armedTargets.has(threadId);
};

export const getArmedReadAloudTargets = (): ReadonlyArray<ArmedReadAloudTarget> => {
  return cachedArmedTargets;
};

export const useArmedReadAloudTargets = (): ReadonlyArray<ArmedReadAloudTarget> => {
  return useSyncExternalStore(
    (onStoreChange) => {
      armedTargetListeners.add(onStoreChange);
      return () => {
        armedTargetListeners.delete(onStoreChange);
      };
    },
    getArmedReadAloudTargets,
    getArmedReadAloudTargets,
  );
};

export const useIsThreadReadAloudArmed = (threadId?: string | null): boolean => {
  const armedTargets = useArmedReadAloudTargets();
  if (!threadId) return false;
  return armedTargets.some((target) => target.threadId === threadId);
};

export function useThreadAudioMode(
  threadId?: string | null,
  options?: {
    readonly environmentId?: EnvironmentId | null;
    readonly threadTitle?: string;
    readonly projectTitle?: string;
  },
) {
  const isArmed = useIsThreadReadAloudArmed(threadId);
  const { speech, pause, resume, seekBy, stop } = useReadAloud(options?.environmentId ?? undefined);
  const isCurrentThreadPlayback = Boolean(
    threadId && speech.phase !== null && speech.threadId === threadId,
  );
  const isActive = isArmed || isCurrentThreadPlayback;

  const toggleAudioMode = useCallback(
    (desiredActive?: boolean) => {
      if (!threadId) return;
      const next = desiredActive ?? !isActive;
      if (next) {
        armReadAloudOnNextReply({
          threadId,
          environmentId: options?.environmentId ?? null,
          threadTitle: options?.threadTitle,
          projectTitle: options?.projectTitle,
        });
      } else {
        disarmReadAloudOnNextReply(threadId);
        if (isCurrentThreadPlayback) {
          stop();
        }
      }
    },
    [
      threadId,
      isActive,
      isCurrentThreadPlayback,
      options?.environmentId,
      options?.threadTitle,
      options?.projectTitle,
      stop,
    ],
  );

  return {
    isActive,
    isArmed,
    isCurrentThreadPlayback,
    speech,
    pause,
    resume,
    seekBy,
    stop,
    toggleAudioMode,
  };
}

/** Stage logging for the device pipeline; visible in Metro during development. */
const log = (...args: unknown[]) => {
  if (typeof __DEV__ !== "undefined" && __DEV__) console.log("[read-aloud]", ...args);
};

let activeAudioLiveActivity: ReturnType<typeof startAgentLiveActivity> = null;

export const syncAudioLiveActivity = (speech: ReadAloudSpeech) => {
  if (Platform.OS !== "ios") return;
  try {
    const activities = getAgentLiveActivities();
    const armedTargets = getArmedReadAloudTargets();

    if (!speech.phase) {
      if (activeAudioLiveActivity) {
        try {
          void activeAudioLiveActivity.end("immediate");
        } catch {}
        activeAudioLiveActivity = null;
      }
      for (const act of activities) {
        if ((act as unknown as { readonly __t3_audio?: boolean }).__t3_audio) {
          try {
            void act.end("immediate");
          } catch {}
        }
      }
      return;
    }

    const nowIso = new Date().toISOString();
    const audioStatus = speech.phase === "loading" ? "Lade Audio..." : "Liest Antwort vor";

    const audioRow: AgentActivityRowProps = {
      environmentId: speech.environmentId ? String(speech.environmentId) : "",
      threadId: speech.threadId ?? "",
      projectTitle: speech.projectTitle || "T3 Code",
      threadTitle: speech.title || "Sprachausgabe",
      modelTitle: "",
      phase: "running",
      status: audioStatus,
      updatedAt: nowIso,
      deepLink: speech.threadId ? `/threads/${speech.threadId}` : "/",
      isAudioActive: true,
    };

    const armedRows: AgentActivityRowProps[] = armedTargets
      .filter((t) => t.threadId !== speech.threadId)
      .map((t) => ({
        environmentId: t.environmentId ? String(t.environmentId) : "",
        threadId: t.threadId,
        projectTitle: t.projectTitle || "T3 Code",
        threadTitle: t.threadTitle || "Thread",
        modelTitle: "",
        phase: "running",
        status: "Antwort abwarten",
        updatedAt: nowIso,
        deepLink: `/threads/${t.threadId}`,
        isAudioArmed: true,
      }));

    const props: AgentActivityProps = {
      title: speech.title || "T3 Code",
      subtitle: audioStatus,
      activeCount: 1 + armedRows.length,
      updatedAt: nowIso,
      audioPhase: speech.phase === "paused" ? "idle" : speech.phase,
      audioThreadId: speech.threadId,
      audioThreadTitle: speech.title,
      audioProjectTitle: speech.projectTitle,
      activities: [audioRow, ...armedRows],
    };

    if (activeAudioLiveActivity) {
      void activeAudioLiveActivity.update(props);
    } else if (activities.length > 0) {
      for (const act of activities) {
        (act as unknown as { __t3_audio?: boolean }).__t3_audio = true;
        activeAudioLiveActivity = act;
        void act.update(props);
      }
    } else {
      const act = startAgentLiveActivity(props);
      if (act) {
        (act as unknown as { __t3_audio?: boolean }).__t3_audio = true;
        activeAudioLiveActivity = act;
      }
    }
  } catch {
    // Live Activity is best-effort
  }
};

export const deactivateAudioSession = async () => {
  try {
    if (T3NativeControls?.deactivateAudioSession) {
      await T3NativeControls.deactivateAudioSession();
    }
  } catch {}
  try {
    await setIsAudioActiveAsync(false);
  } catch {}
};

const setSpeech = (next: ReadAloudSpeech) => {
  currentSpeech = next;
  for (const listener of listeners) listener();
  syncAudioLiveActivity(next);
  if (next.phase === null) {
    void deactivateAudioSession();
  }
};

/** Set when a reply starts being spoken; used for stage timing in the logs. */
let speakStartedAt: number | null = null;

const releasePlaylist = () => {
  playlistSubscription?.remove();
  playlistSubscription = null;
  if (playlist) {
    try {
      playlist.pause();
      playlist.clear();
      playlist.release();
    } catch {}
    playlist = null;
  }
};

const cleanupActiveSegments = () => {
  for (const uri of activeSegmentUris) {
    try {
      new File(uri).delete();
    } catch {}
  }
  activeSegmentUris.clear();
};

/** Stopping is a take-over: a pending auto-read queue dies with it. */
const stopCurrent = () => {
  runCounter += 1;
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  readQueue = [];
  if (T3NativeControls?.stopSpeaking) {
    try {
      void T3NativeControls.stopSpeaking();
    } catch {}
  }
  releasePlaylist();
  cleanupActiveSegments();
  setSpeech(IDLE);
};

const playNextFromQueue = () => {
  if (playThroughCurrentDeps === null) return;
  const next = readQueue.shift();
  if (!next) {
    setSpeech(IDLE);
    return;
  }
  setSpeech({
    ...IDLE,
    queued: readQueue.length,
    phase: "loading",
    key: next.key,
    threadId: next.threadId ?? currentSpeech.threadId,
    environmentId: next.environmentId ?? currentSpeech.environmentId,
    title: next.title ?? currentSpeech.title,
    projectTitle: next.projectTitle ?? currentSpeech.projectTitle,
  });
  playThroughCurrentDeps(next);
};

const announceExhausted = (message: string) => {
  const now = Date.now();
  // A cascade would stack alerts; the first one stands in for the rest.
  if (now - lastFailureAt >= 15_000) {
    lastFailureAt = now;
    Alert.alert("Read aloud unavailable", message);
  }
  readQueue = [];
  cleanupActiveSegments();
  setSpeech(IDLE);
};

/**
 * Ensures iOS audio session is active and configured for playback without ducking.
 */
const ensureAudioSession = async () => {
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });
    await setIsAudioActiveAsync(true);
  } catch {
    // Continue anyway; expo-audio often works regardless.
  }
};

/**
 * Exponential lead: the first sentence plays in ~1-2s, then chunks of 2, 4
 * and 8 sentences, then the rest in one request.
 */
const chunkReply = (text: string): string[] => {
  const sentences = text.match(/[^.!?…]+[.!?…]+["'»)]*\s*|[^.!?…]+$/g) ?? [text];
  const chunks: string[] = [];
  let index = 0;
  for (const size of [1, 2, 4, 8]) {
    if (index >= sentences.length) break;
    chunks.push(sentences.slice(index, index + size).join(" "));
    index += size;
  }
  if (index < sentences.length) chunks.push(sentences.slice(index).join(" "));
  return chunks.filter((chunk) => chunk.trim().length > 0);
};

const IDLE: ReadAloudSpeech = {
  key: null,
  threadId: null,
  environmentId: null,
  title: null,
  projectTitle: null,
  phase: null,
  source: null,
  queued: 0,
};

type Listener = () => void;

let currentSpeech: ReadAloudSpeech = IDLE;
const listeners = new Set<Listener>();

let activeSpeechEnvironmentId: EnvironmentId | null = null;
let readQueue: QueueEntry[] = [];
let enqueueCounter = 0;
let lastFailureAt = 0;
let runCounter = 0;

let playlist: AudioPlaylist | null = null;
let playlistSubscription: { remove: () => void } | null = null;
let activeStreamAbort: AbortController | null = null;
const activeSegmentUris = new Set<string>();

let chunkedPlayback = true;

let playThroughCurrentDeps: ((item: ReadItem) => void) | null = null;

/**
 * Read-aloud for the phone:
 * When device Gemini is configured:
 * Uses a single SSE stream from Gemini and queues ready segment WAV files
 * into the native AVQueuePlayer (via AudioPlaylist) for hardware gapless playback.
 * When server provider is configured:
 * The paired server synthesizes clips, downloaded to cache, and played.
 */
export function useReadAloud(environmentId?: EnvironmentId | null) {
  const targetEnvId = environmentId ?? activeSpeechEnvironmentId ?? null;
  const preparedConnection = usePreparedConnection(targetEnvId);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const readAloudPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;
  const readAloudProvider = readAloudPreferences?.readAloudProvider;
  const readAloudGeminiApiKey = readAloudPreferences?.readAloudGeminiApiKey;
  const readAloudGeminiModel = readAloudPreferences?.readAloudGeminiModel;
  const readAloudGeminiVoice = readAloudPreferences?.readAloudGeminiVoice;

  const deviceTtsConfig = useMemo(
    () =>
      getDeviceTtsConfig({
        readAloudProvider,
        readAloudGeminiApiKey,
        readAloudGeminiModel,
        readAloudGeminiVoice,
      }),
    [readAloudProvider, readAloudGeminiApiKey, readAloudGeminiModel, readAloudGeminiVoice],
  );
  const ttsSynthesize = useAtomCommand(serverEnvironment.ttsSynthesize, {
    label: "speak message",
    reportFailure: false,
  });
  const ttsSettings = useAtomValue(
    targetEnvId ? serverEnvironment.settingsValueAtom(targetEnvId) : EMPTY_SETTINGS_ATOM,
  );
  useEffect(() => {
    chunkedPlayback =
      ttsSettings?.tts?.chunkedPlayback ?? DEFAULT_SERVER_SETTINGS.tts.chunkedPlayback ?? true;
  }, [ttsSettings]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const speech = useSyncExternalStore(
    subscribe,
    () => currentSpeech,
    () => IDLE,
  );

  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;

  const speakWithNativeFallback = useCallback(
    async (itemToSpeak: ReadItem, isCurrent: () => boolean) => {
      if (Platform.OS === "ios" && T3NativeControls?.speakText) {
        try {
          await ensureAudioSession();
          if (!isCurrent()) return true;
          setSpeech({
            key: itemToSpeak.key,
            threadId: itemToSpeak.threadId ?? currentSpeech.threadId,
            environmentId: itemToSpeak.environmentId ?? currentSpeech.environmentId,
            title: itemToSpeak.title ?? currentSpeech.title,
            projectTitle: itemToSpeak.projectTitle ?? currentSpeech.projectTitle,
            phase: "playing",
            source: itemToSpeak.source,
            queued: readQueue.length,
          });
          log(
            "speakWithNativeFallback: speaking via iOS AVSpeechSynthesizer",
            `${itemToSpeak.text.length} chars`,
          );
          await T3NativeControls.speakText(itemToSpeak.text, {
            language: "de-DE",
            title: itemToSpeak.title ?? "Antwort",
            projectTitle: itemToSpeak.projectTitle ?? "T3 Code",
          });
          if (!isCurrent()) return true;
          if (itemToSpeak.source === "auto" || readQueue.length > 0) {
            playNextFromQueue();
          } else {
            setSpeech(IDLE);
          }
          return true;
        } catch (e) {
          log("speakWithNativeFallback failed", e);
        }
      }
      return false;
    },
    [],
  );

  /**
   * Streams the reply from Gemini in ONE SSE connection and feeds segment
   * files directly into the native AVQueuePlayer playlist for seamless 0ms playback.
   */
  const consumeDeviceStream = useCallback(
    (item: ReadItem) => {
      if (!deviceTtsConfig) return;
      const run = runCounter;
      const isCurrent = () => run === runCounter;
      const abort = new AbortController();
      activeStreamAbort = abort;
      log(
        "stream consumer: start",
        `${item.text.length} chars`,
        "model:",
        deviceTtsConfig.model,
        "voice:",
        deviceTtsConfig.voice,
      );

      void (async () => {
        let segmentIndex = 0;
        let firstSegmentSeen = false;
        let streamDone = false;
        let started = false;

        const startWatchdog = setTimeout(() => {
          if (!firstSegmentSeen && activeStreamAbort === abort) {
            abort.abort();
            void (async () => {
              if (await speakWithNativeFallback(item, isCurrent)) return;
              announceExhausted(
                "Gemini's audio stream did not start within 20 seconds. Try again.",
              );
            })();
          }
        }, STREAM_START_TIMEOUT_MS);

        try {
          await ensureAudioSession();
          if (activeStreamAbort !== abort) return;

          for await (const segmentUri of streamWavSegments(
            deviceTtsConfig,
            item.text,
            abort.signal,
          )) {
            firstSegmentSeen = true;
            if (activeStreamAbort !== abort) return;
            segmentIndex += 1;
            activeSegmentUris.add(segmentUri);

            log("stream consumer: segment", segmentIndex, segmentUri);

            if (!playlist) {
              const pl = createAudioPlaylist({
                sources: [{ uri: segmentUri }],
              });
              playlist = pl;
              try {
                pl.setActiveForLockScreen(true, {
                  title: item.title ?? "Antwort",
                  artist: item.projectTitle ? `T3 Code · ${item.projectTitle}` : "T3 Code",
                });
              } catch {}

              pl.addListener("trackChanged", ({ previousIndex, currentIndex }) => {
                log("playlist trackChanged:", previousIndex, "->", currentIndex);
              });

              playlistSubscription = pl.addListener("playlistStatusUpdate", (status) => {
                if (activeStreamAbort !== abort) return;
                if (!started && status.isLoaded) {
                  pl.play();
                }
                if (status.playing && !started) {
                  started = true;
                  clearTimeout(startWatchdog);
                  log(
                    "playlist: PLAYING",
                    `${Date.now() - (speakStartedAt || Date.now())}ms after speak`,
                    "queued:",
                    readQueue.length,
                  );
                  setSpeech({
                    key: item.key,
                    threadId: item.threadId ?? currentSpeech.threadId,
                    environmentId: item.environmentId ?? currentSpeech.environmentId,
                    title: item.title ?? currentSpeech.title,
                    projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
                    phase: "playing",
                    source: item.source,
                    queued: readQueue.length,
                  });
                }
                if (status.didJustFinish && streamDone) {
                  clearTimeout(startWatchdog);
                  releasePlaylist();
                  cleanupActiveSegments();
                  log("stream consumer: finished all segments, queue:", readQueue.length);
                  if (item.source === "auto" || readQueue.length > 0) {
                    playNextFromQueue();
                  } else {
                    setSpeech(IDLE);
                  }
                }
              });

              setSpeech({
                key: item.key,
                threadId: item.threadId ?? currentSpeech.threadId,
                environmentId: item.environmentId ?? currentSpeech.environmentId,
                title: item.title ?? currentSpeech.title,
                projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
                phase: "loading",
                source: item.source,
                queued: readQueue.length,
              });

              pl.play();
            } else {
              playlist.add({ uri: segmentUri });
              if (!playlist.playing) {
                playlist.play();
              }
            }
          }

          clearTimeout(startWatchdog);
          streamDone = true;
          log("stream consumer: complete stream", `${segmentIndex} segments`);

          // If the last track finished before the stream completion was marked
          if (playlist?.currentStatus?.didJustFinish) {
            releasePlaylist();
            cleanupActiveSegments();
            if (item.source === "auto" || readQueue.length > 0) {
              playNextFromQueue();
            } else {
              setSpeech(IDLE);
            }
          }
        } catch (error) {
          clearTimeout(startWatchdog);
          log("stream consumer: failed", error);
          if (activeStreamAbort !== abort) return;
          if (await speakWithNativeFallback(item, isCurrent)) return;
          announceExhausted(
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Gemini's audio stream failed.",
          );
        }
      })();
    },
    [deviceTtsConfig, speakWithNativeFallback],
  );

  const speak = useCallback(
    (item: {
      readonly key: string;
      readonly text: string;
      readonly threadId?: string;
      readonly environmentId?: EnvironmentId;
      readonly title?: string;
      readonly projectTitle?: string;
    }) => {
      if (deviceTtsConfig && activeStreamAbort !== null && currentSpeech.key === item.key) {
        log("speak: ignored, this reply is already streaming");
        return;
      }
      stopCurrent();
      const cleanedText = cleanTextForSpeech(item.text);
      if (cleanedText.length === 0) {
        log("speak: ignored, text is empty after sanitization");
        return;
      }
      speakStartedAt = Date.now();
      const resolvedEnvId =
        item.environmentId ?? environmentId ?? currentSpeech.environmentId ?? null;
      if (resolvedEnvId) {
        activeSpeechEnvironmentId = resolvedEnvId;
      }
      const projectTitle = resolveProjectTitle({
        environmentId: resolvedEnvId,
        threadId: item.threadId,
        projectTitle: item.projectTitle,
      });
      const textToSpeak = prefixTextWithProject(cleanedText, {
        environmentId: resolvedEnvId,
        threadId: item.threadId,
        projectTitle,
      });
      if (deviceTtsConfig) {
        log("speak: device Gemini stream", `${textToSpeak.length} chars`);
        setSpeech({
          key: item.key,
          threadId: item.threadId ?? null,
          environmentId: resolvedEnvId,
          title: item.title ?? null,
          projectTitle,
          phase: "loading",
          source: "manual",
          queued: readQueue.length,
        });
        consumeDeviceStream({
          key: item.key,
          text: textToSpeak,
          source: "manual",
          threadId: item.threadId,
          environmentId: resolvedEnvId ?? undefined,
          title: item.title,
          projectTitle,
        });
        return;
      }
      log("speak: server path", `${textToSpeak.length} chars`, "chunked:", chunkedPlayback);
      const chunks = chunkedPlayback ? chunkReply(textToSpeak) : [textToSpeak];
      const lead = chunks[0];
      if (lead === undefined) return;
      setSpeech({
        key: item.key,
        threadId: item.threadId ?? null,
        environmentId: resolvedEnvId,
        title: item.title ?? null,
        projectTitle,
        phase: "loading",
        source: "manual",
        queued: readQueue.length,
      });
      playThroughCurrentDeps?.({
        key: item.key,
        text: lead,
        source: "manual",
        threadId: item.threadId,
        environmentId: resolvedEnvId ?? undefined,
        title: item.title,
        projectTitle,
      });
      for (let index = 1; index < chunks.length; index++) {
        const text = chunks[index];
        if (text === undefined) continue;
        readQueue.push({
          key: item.key,
          dedupeKey: `${item.key}#${index}`,
          text,
          source: "auto",
          threadId: item.threadId,
          environmentId: resolvedEnvId ?? undefined,
          title: item.title,
          projectTitle,
        });
      }
    },
    [consumeDeviceStream, deviceTtsConfig, environmentId],
  );

  const pause = useCallback(() => {
    if (T3NativeControls?.pauseSpeaking && currentSpeech.phase === "playing") {
      try {
        void T3NativeControls.pauseSpeaking();
      } catch (e) {
        log("native pause: failed", e);
      }
      setSpeech({
        ...currentSpeech,
        phase: "paused",
      });
      return;
    }
    if (playlist && (currentSpeech.phase === "playing" || currentSpeech.phase === "loading")) {
      try {
        playlist.pause();
      } catch (e) {
        log("pause: failed", e);
      }
      setSpeech({
        ...currentSpeech,
        phase: "paused",
      });
    }
  }, []);

  const resume = useCallback(() => {
    if (T3NativeControls?.resumeSpeaking && currentSpeech.phase === "paused") {
      try {
        void T3NativeControls.resumeSpeaking();
      } catch (e) {
        log("native resume: failed", e);
      }
      setSpeech({
        ...currentSpeech,
        phase: "playing",
      });
      return;
    }
    if (playlist && currentSpeech.phase === "paused") {
      try {
        playlist.play();
      } catch (e) {
        log("resume: failed", e);
      }
      setSpeech({
        ...currentSpeech,
        phase: "playing",
      });
    }
  }, []);

  const seekBy = useCallback((deltaSeconds: number) => {
    if (playlist) {
      try {
        const pl = playlist as unknown as {
          currentTime?: number;
          currentStatus?: { currentTime?: number };
          seekTo?: (seconds: number) => Promise<void>;
        };
        const current = pl.currentTime ?? pl.currentStatus?.currentTime ?? 0;
        const target = Math.max(0, current + deltaSeconds);
        void pl.seekTo?.(target);
      } catch (e) {
        log("seekBy: failed", e);
      }
    }
  }, []);

  const stop = useCallback(() => {
    stopCurrent();
  }, []);

  const enqueue = useCallback(
    (item: {
      readonly key: string;
      readonly text: string;
      readonly clipUri?: string;
      readonly threadId?: string;
      readonly environmentId?: EnvironmentId;
      readonly title?: string;
      readonly projectTitle?: string;
    }) => {
      const resolvedEnvId = item.environmentId ?? environmentId ?? null;
      if (resolvedEnvId) activeSpeechEnvironmentId = resolvedEnvId;
      const projectTitle = resolveProjectTitle({
        environmentId: resolvedEnvId,
        threadId: item.threadId,
        projectTitle: item.projectTitle,
      });
      const cleanedText = item.clipUri ? item.text : cleanTextForSpeech(item.text);
      if (!item.clipUri && cleanedText.length === 0) return;
      const textToQueue = item.clipUri
        ? cleanedText
        : prefixTextWithProject(cleanedText, {
            environmentId: resolvedEnvId,
            threadId: item.threadId,
            projectTitle,
          });
      enqueueCounter += 1;
      const dedupeKey = `${item.key}#${enqueueCounter}`;
      readQueue.push({
        key: item.key,
        dedupeKey,
        text: textToQueue,
        source: "auto",
        clipUri: item.clipUri,
        threadId: item.threadId,
        environmentId: resolvedEnvId ?? undefined,
        title: item.title,
        projectTitle,
      });
      if (currentSpeech.phase === null) {
        playNextFromQueue();
      } else {
        setSpeech({ ...currentSpeech, queued: readQueue.length });
      }
    },
    [environmentId],
  );

  useEffect(() => {
    playThroughCurrentDeps = (item: ReadItem) => {
      const run = ++runCounter;
      const isCurrent = () => run === runCounter;
      const resolvedEnvId =
        item.environmentId ?? environmentId ?? activeSpeechEnvironmentId ?? null;
      if (resolvedEnvId) activeSpeechEnvironmentId = resolvedEnvId;
      setSpeech({
        ...IDLE,
        phase: "loading",
        key: item.key,
        threadId: item.threadId ?? currentSpeech.threadId,
        environmentId: resolvedEnvId,
        title: item.title ?? currentSpeech.title,
        projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
        queued: readQueue.length,
      });

      if (httpBaseUrl === null && !deviceTtsConfig) {
        void (async () => {
          if (await speakWithNativeFallback(item, isCurrent)) return;
          announceExhausted("This environment is not connected right now.");
        })();
        return;
      }

      if (!item.clipUri && deviceTtsConfig) {
        consumeDeviceStream(item);
        return;
      }

      const startPlayback = async () => {
        await ensureAudioSession();
        if (!isCurrent()) return;

        try {
          let clipUri: string | null;
          if (item.clipUri) {
            clipUri = item.clipUri;
          } else {
            const result = await Promise.race([
              ttsSynthesize({
                environmentId: resolvedEnvId ?? (environmentId as EnvironmentId),
                input: { text: item.text },
              }),
              new Promise<never>((_, reject) => {
                setTimeout(
                  () =>
                    reject(
                      new Error("The server did not answer. Check the connection and try again."),
                    ),
                  SYNTHESIZE_TIMEOUT_MS,
                );
              }),
            ]);
            if (!isCurrent()) return;
            if (result._tag !== "Success") {
              if (await speakWithNativeFallback(item, isCurrent)) return;
              announceExhausted(
                "The server could not synthesize this reply. Check the read-aloud settings on your Mac.",
              );
              return;
            }
            clipUri =
              httpBaseUrl === null ? null : resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
            if (clipUri === null) {
              if (await speakWithNativeFallback(item, isCurrent)) return;
              announceExhausted("The reply clip could not be loaded. Reconnect and try again.");
              return;
            }
            const clipFile = await File.downloadFileAsync(clipUri, new Directory(Paths.cache), {
              idempotent: true,
            });
            clipUri = clipFile.uri;
          }
          if (!isCurrent()) return;

          const clipPlaylist = (() => {
            try {
              return createAudioPlaylist({ sources: [{ uri: clipUri }] });
            } catch (error) {
              log("playlist: createAudioPlaylist FAILED", error, clipUri);
              throw error;
            }
          })();

          log(
            "playlist: created",
            item.clipUri ? "device segment" : "server clip",
            `${Date.now() - (speakStartedAt || Date.now())}ms after speak`,
            clipUri,
          );
          playlist = clipPlaylist;
          try {
            clipPlaylist.setActiveForLockScreen(true, {
              title: item.title ?? "Antwort",
              artist: item.projectTitle ? `T3 Code · ${item.projectTitle}` : "T3 Code",
            });
          } catch {}

          let started = false;

          const startWatchdog = setTimeout(() => {
            if (started || !isCurrent()) return;
            releasePlaylist();
            void (async () => {
              if (await speakWithNativeFallback(item, isCurrent)) return;
              announceExhausted("The reply clip did not start playing.");
            })();
          }, START_WATCHDOG_MS);

          playlistSubscription = clipPlaylist.addListener("playlistStatusUpdate", (status) => {
            if (!isCurrent()) return;
            if (!started && status.isLoaded) clipPlaylist.play();
            if (status.playing && !started) {
              started = true;
              clearTimeout(startWatchdog);
              log(
                "playlist: PLAYING",
                `${Date.now() - (speakStartedAt || Date.now())}ms after speak`,
                "queued:",
                readQueue.length,
              );
              setSpeech({
                key: item.key,
                threadId: item.threadId ?? currentSpeech.threadId,
                environmentId: item.environmentId ?? currentSpeech.environmentId,
                title: item.title ?? currentSpeech.title,
                projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
                phase: "playing",
                source: item.source,
                queued: readQueue.length,
              });
            }
            if (status.didJustFinish) {
              clearTimeout(startWatchdog);
              releasePlaylist();
              log("playlist: finished segment, queue:", readQueue.length);
              if (item.source === "auto" || readQueue.length > 0) {
                playNextFromQueue();
              } else {
                cleanupActiveSegments();
                setSpeech(IDLE);
              }
            }
          });

          setSpeech({
            key: item.key,
            threadId: item.threadId ?? currentSpeech.threadId,
            environmentId: item.environmentId ?? currentSpeech.environmentId,
            title: item.title ?? currentSpeech.title,
            projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
            phase: "loading",
            source: item.source,
            queued: readQueue.length,
          });
          clipPlaylist.play();
        } catch (error) {
          if (!isCurrent()) return;
          log("playlist: failed", error);
          if (await speakWithNativeFallback(item, isCurrent)) return;
          announceExhausted(
            error instanceof Error && error.message.length > 0
              ? error.message
              : "The server did not answer. Check the connection and try again.",
          );
        }
      };
      void startPlayback();
    };
  }, [
    consumeDeviceStream,
    deviceTtsConfig,
    environmentId,
    httpBaseUrl,
    speakWithNativeFallback,
    ttsSynthesize,
  ]);

  return { speech, speak, pause, resume, seekBy, stop, enqueue };
}

function isMessageEntry(entry: unknown): entry is ThreadFeedMessageEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "message" &&
    typeof (entry as { message?: unknown }).message === "object"
  );
}

/**
 * Announces newly finished assistant replies of one thread to the shared
 * queue while auto-read is on. History stays silent: only replies that
 * complete while this feed is mounted are spoken.
 * Crucially: switching threads does NOT cancel or re-initialize an actively
 * playing speech session.
 */
export function useReadAloudAutoAnnounce(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly threadTitle?: string;
  readonly projectTitle?: string;
  readonly feed?: ReadonlyArray<unknown>;
  readonly turnTexts?: ReadonlyMap<string, string>;
}) {
  const { environmentId, threadId, threadTitle, projectTitle, feed, turnTexts } = input;
  const { enqueue, speak } = useReadAloud(environmentId);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const autoRead =
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.readAloudAutoSpeak === true;

  const announcedIdsRef = useRef<Set<string>>(new Set());
  const seenStreamingIdsRef = useRef<Set<string>>(new Set());
  const threadOpenedAtRef = useRef<number>(Date.now());
  const initialLoadHandledRef = useRef(false);
  const lastThreadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastThreadKeyRef.current === threadId) return;
    lastThreadKeyRef.current = threadId;
    threadOpenedAtRef.current = Date.now();
    initialLoadHandledRef.current = false;
    announcedIdsRef.current = new Set();
    seenStreamingIdsRef.current = new Set();
    // Do NOT stop() here. Existing audio sessions continue playing globally!
  }, [threadId]);

  useEffect(() => {
    if (!Array.isArray(feed)) return;
    const newlyFinished: Array<{ readonly key: string; readonly text: string }> = [];
    const threadOpenedAt = threadOpenedAtRef.current;
    const isFirstPassWithContent = !initialLoadHandledRef.current && feed.length > 0;
    if (isFirstPassWithContent) {
      initialLoadHandledRef.current = true;
    }

    for (const entry of feed) {
      if (!isMessageEntry(entry)) continue;
      const message = entry.message;
      if (message.role !== "assistant") continue;

      // Track messages seen streaming in this session so we know their completion is new.
      if (message.streaming) {
        seenStreamingIdsRef.current.add(message.id);
        continue;
      }

      if (message.text.trim().length === 0) continue;
      if (announcedIdsRef.current.has(message.id)) continue;
      announcedIdsRef.current.add(message.id);

      // Check whether this message completed before entering the thread.
      const timestampStr = message.updatedAt || message.createdAt || entry.createdAt;
      const messageTime = timestampStr ? Date.parse(timestampStr) : NaN;
      const wasCompletedBeforeOpening =
        isFirstPassWithContent || (Number.isFinite(messageTime) && messageTime < threadOpenedAt);

      if (wasCompletedBeforeOpening && !seenStreamingIdsRef.current.has(message.id)) {
        continue;
      }

      newlyFinished.push({ key: message.id, text: message.text });
    }

    if (newlyFinished.length > 0) {
      if (isReadAloudArmedOnNextReply(threadId)) {
        const armed = armedTargets.get(threadId);
        disarmReadAloudOnNextReply(threadId);
        const lastItem = newlyFinished[newlyFinished.length - 1];
        if (lastItem) {
          const textToSpeak = turnTexts?.get(lastItem.key) ?? lastItem.text;
          const resolvedProject = armed?.projectTitle ?? projectTitle;
          speak({
            key: lastItem.key,
            text: textToSpeak,
            threadId,
            environmentId,
            title: armed?.threadTitle ?? threadTitle,
            projectTitle: resolvedProject,
          });
        }
      } else if (autoRead) {
        for (const item of newlyFinished) {
          enqueue({
            ...item,
            threadId,
            environmentId,
            title: threadTitle,
            projectTitle,
          });
        }
      }
    }
  }, [
    autoRead,
    environmentId,
    feed,
    speak,
    enqueue,
    threadId,
    threadTitle,
    projectTitle,
    turnTexts,
  ]);
}
