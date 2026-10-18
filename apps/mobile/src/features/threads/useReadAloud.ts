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
import { savePreferencesPatch } from "../../persistence/imperative";
import { AsyncResult, Atom } from "effect/reactivity";
import { Directory, File, Paths } from "expo-file-system";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { getDeviceTtsConfig, streamWavSegments } from "./deviceTts";
import { cleanTextForSpeech } from "@t3tools/shared/textForSpeech";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { environmentProjects } from "../../state/projects";

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
        activateAudioSession?: (options?: {
          title?: string;
          projectTitle?: string;
          waitingAudioMode?: string;
        }) => Promise<boolean>;
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
        pauseWaitingAudio?: () => Promise<void>;
        resumeWaitingAudio?: (options?: { title?: string; projectTitle?: string }) => Promise<void>;
        setWaitingAudioMode?: (mode: string) => Promise<void>;
        isSpeaking?: () => boolean;
        deactivateAudioSession?: () => Promise<boolean>;
        enforceBuiltInMicrophone?: () => Promise<boolean>;
        resetPreferredAudioInput?: () => Promise<boolean>;
      } | null)
    : null;

const EMPTY_SETTINGS_ATOM = Atom.make<any>(null);

if (
  Platform.OS === "ios" &&
  T3NativeControls &&
  typeof (T3NativeControls as { addListener?: unknown }).addListener === "function"
) {
  try {
    (
      T3NativeControls as {
        addListener: (event: string, cb: (data: { phase?: string }) => void) => void;
      }
    ).addListener("onSpeechPhaseChanged", (event: { phase?: string }) => {
      if (event?.phase === "paused") {
        setSpeech({ ...currentSpeech, phase: "paused" });
      } else if (event?.phase === "playing") {
        setSpeech({ ...currentSpeech, phase: "playing" });
      } else if (event?.phase === "waiting" || event?.phase === "idle") {
        if (currentSpeech.phase === "paused" || currentSpeech.phase === "playing") {
          setSpeech({ ...currentSpeech, phase: null });
        }
      }
    });
    (
      T3NativeControls as {
        addListener: (event: string, cb: (data: { command?: string }) => void) => void;
      }
    ).addListener("onRemoteCommand", (event: { command?: string }) => {
      const cmd = event?.command;
      if (cmd === "pause") {
        isUserPausedState = true;
        if (playlist) {
          try {
            playlist.pause();
          } catch {}
        }
        if (currentSpeech.phase === "playing" || currentSpeech.phase === "loading") {
          setSpeech({ ...currentSpeech, phase: "paused" });
        }
      } else if (cmd === "play") {
        isUserPausedState = false;
        if (playlist) {
          try {
            playlist.play();
            setSpeech({ ...currentSpeech, phase: "playing" });
          } catch {}
        } else if (currentSpeech.phase === "paused") {
          setSpeech({ ...currentSpeech, phase: "playing" });
        } else if (isAudioSessionActive) {
          if (T3NativeControls?.resumeWaitingAudio) {
            try {
              void T3NativeControls.resumeWaitingAudio({
                projectTitle: activeAudioSessionTarget?.projectTitle,
                title: "Warte auf Antwort...",
              });
            } catch {}
          }
          setSpeech({ ...currentSpeech, phase: null });
        }
      } else if (cmd === "toggle") {
        if (currentSpeech.phase === "playing" || currentSpeech.phase === "loading") {
          isUserPausedState = true;
          if (playlist) {
            try {
              playlist.pause();
            } catch {}
          }
          if (T3NativeControls?.pauseSpeaking) {
            try {
              void T3NativeControls.pauseSpeaking();
            } catch {}
          }
          if (T3NativeControls?.pauseWaitingAudio) {
            try {
              void T3NativeControls.pauseWaitingAudio();
            } catch {}
          }
          setSpeech({ ...currentSpeech, phase: "paused" });
        } else if (currentSpeech.phase === "paused") {
          isUserPausedState = false;
          if (playlist) {
            try {
              playlist.play();
              setSpeech({ ...currentSpeech, phase: "playing" });
            } catch {}
          } else if (T3NativeControls?.resumeSpeaking) {
            try {
              void T3NativeControls.resumeSpeaking();
              setSpeech({ ...currentSpeech, phase: "playing" });
            } catch {}
          }
        } else if (isAudioSessionActive) {
          if (isUserPausedState) {
            isUserPausedState = false;
            if (T3NativeControls?.resumeWaitingAudio) {
              try {
                void T3NativeControls.resumeWaitingAudio({
                  projectTitle: activeAudioSessionTarget?.projectTitle,
                  title: "Warte auf Antwort...",
                });
              } catch {}
            }
            setSpeech({ ...currentSpeech, phase: null });
          } else {
            isUserPausedState = true;
            if (T3NativeControls?.pauseWaitingAudio) {
              try {
                void T3NativeControls.pauseWaitingAudio();
              } catch {}
            }
            setSpeech({ ...currentSpeech, phase: "paused" });
          }
        }
      } else if (cmd === "skipForward") {
        if (playlist) {
          try {
            void playlist.seekTo(playlist.currentTime + 10);
          } catch {}
        }
      } else if (cmd === "skipBackward") {
        if (playlist) {
          try {
            void playlist.seekTo(Math.max(0, playlist.currentTime - 10));
          } catch {}
        }
      } else if (cmd === "stop") {
        stopGlobalAudioSession();
      }
    });
  } catch {}
}

const START_WATCHDOG_MS = 5_000;
const STREAM_START_TIMEOUT_MS = 20_000;
export const SYNTHESIZE_TIMEOUT_MS = 30_000;

export interface ArmedReadAloudTarget {
  readonly threadId: string;
  readonly environmentId?: EnvironmentId | null;
  readonly threadTitle?: string;
  readonly projectTitle?: string;
  readonly armedAt?: number;
}

export interface ActiveAudioSessionTarget {
  readonly threadId?: string | null;
  readonly environmentId?: EnvironmentId | null;
  readonly threadTitle?: string;
  readonly projectTitle?: string;
}

let isAudioSessionActive = false;
let activeAudioSessionTarget: ActiveAudioSessionTarget | null = null;
let audioSessionActivatedAt = 0;
const audioSessionListeners = new Set<() => void>();

const notifyAudioSessionListeners = () => {
  for (const listener of audioSessionListeners) {
    listener();
  }
};

export const isGlobalAudioSessionActive = (): boolean => isAudioSessionActive;
export const getActiveAudioSessionTarget = (): ActiveAudioSessionTarget | null =>
  activeAudioSessionTarget;

export const useIsAudioSessionActive = (): boolean => {
  return useSyncExternalStore(
    (onStoreChange) => {
      audioSessionListeners.add(onStoreChange);
      return () => {
        audioSessionListeners.delete(onStoreChange);
      };
    },
    isGlobalAudioSessionActive,
    isGlobalAudioSessionActive,
  );
};

const armedTargets = new Map<string, ArmedReadAloudTarget>();
let cachedArmedTargets: ReadonlyArray<ArmedReadAloudTarget> = Object.freeze([]);
const armedTargetListeners = new Set<() => void>();

const notifyArmedTargetListeners = () => {
  for (const listener of armedTargetListeners) {
    listener();
  }
};

export function resolveProjectTitle(options?: {
  readonly environmentId?: EnvironmentId | null;
  readonly threadId?: string | null;
  readonly projectTitle?: string | null;
}): string {
  if (options?.projectTitle && options.projectTitle.trim().length > 0) {
    return options.projectTitle.trim();
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
    armedAt: previous?.armedAt ?? Date.now(),
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

let currentWaitingAudioMode: "music" | "silent" = "music";
export const setGlobalWaitingAudioMode = (mode: "music" | "silent") => {
  currentWaitingAudioMode = mode;
  if (Platform.OS === "ios" && T3NativeControls?.setWaitingAudioMode) {
    void T3NativeControls.setWaitingAudioMode(mode);
  }
};

export const startGlobalAudioSession = async (
  target?: ActiveAudioSessionTarget,
  options?: { readonly persist?: boolean },
) => {
  isAudioSessionActive = true;
  audioSessionActivatedAt = Date.now();
  if (target) {
    activeAudioSessionTarget = target;
    if (target.threadId) {
      armReadAloudOnNextReply({
        threadId: target.threadId,
        environmentId: target.environmentId,
        threadTitle: target.threadTitle,
        projectTitle: target.projectTitle,
      });
    }
  }
  if (options?.persist ?? true) {
    try {
      void savePreferencesPatch({
        audioSessionActive: true,
        audioSessionTarget: target
          ? {
              environmentId: target.environmentId ? String(target.environmentId) : null,
              threadId: target.threadId ? String(target.threadId) : null,
              threadTitle: target.threadTitle ?? null,
              projectTitle: target.projectTitle ?? null,
            }
          : null,
      }).catch(() => {});
    } catch {}
  }
  if (Platform.OS === "ios" && T3NativeControls?.activateAudioSession) {
    try {
      await T3NativeControls.activateAudioSession({
        projectTitle: target?.projectTitle,
        title: "Warte auf Antwort...",
        waitingAudioMode: currentWaitingAudioMode,
      });
    } catch {}
  }
  await ensureAudioSession();
  notifyAudioSessionListeners();
  for (const listener of listeners) listener();
  syncAudioLiveActivity(currentSpeech);
};

export const stopGlobalAudioSession = (options?: { readonly persist?: boolean }) => {
  isAudioSessionActive = false;
  activeAudioSessionTarget = null;
  audioSessionActivatedAt = 0;
  clearArmedReadAloudTargets();
  stopCurrent();
  void deactivateAudioSession();
  if (options?.persist ?? true) {
    try {
      void savePreferencesPatch({
        audioSessionActive: false,
        audioSessionTarget: null,
      }).catch(() => {});
    } catch {}
  }
  if (Platform.OS === "ios" && T3NativeControls?.deactivateAudioSession) {
    try {
      void T3NativeControls.deactivateAudioSession();
    } catch {}
  }
  notifyAudioSessionListeners();
  for (const listener of listeners) listener();
  syncAudioLiveActivity(IDLE);
};

export const useIsAudioBarVisible = (): boolean => {
  const isSessionActive = useIsAudioSessionActive();
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => currentSpeech,
    () => IDLE,
  );
  return isSessionActive || current.phase !== null;
};

export function useThreadAudioMode(
  threadId?: string | null,
  options?: {
    readonly environmentId?: EnvironmentId | null;
    readonly threadTitle?: string;
    readonly projectTitle?: string;
  },
) {
  const isGlobalActive = useIsAudioSessionActive();
  const isArmed = useIsThreadReadAloudArmed(threadId);
  const { speech, pause, resume, seekBy } = useReadAloud(options?.environmentId ?? undefined);
  const isCurrentThreadPlayback = Boolean(
    threadId && speech.phase !== null && speech.threadId === threadId,
  );
  const isActive = isGlobalActive || isArmed || isCurrentThreadPlayback;

  const toggleAudioMode = useCallback(
    (desiredActive?: boolean) => {
      const next = desiredActive ?? !isActive;
      if (next) {
        void startGlobalAudioSession({
          threadId: threadId ?? null,
          environmentId: options?.environmentId ?? null,
          threadTitle: options?.threadTitle,
          projectTitle: options?.projectTitle,
        });
      } else {
        stopGlobalAudioSession();
      }
    },
    [isActive, options?.environmentId, options?.projectTitle, options?.threadTitle, threadId],
  );

  return {
    isActive,
    isArmed,
    isCurrentThreadPlayback,
    speech,
    pause,
    resume,
    seekBy,
    stop: stopGlobalAudioSession,
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

    if (!speech.phase && !isAudioSessionActive) {
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
    const audioStatus =
      speech.phase === "loading"
        ? "Lade Audio..."
        : speech.phase === "playing"
          ? "Liest Antwort vor"
          : speech.phase === "paused"
            ? "Pausiert"
            : "Audio-Session aktiv";

    const targetEnvId = speech.environmentId
      ? String(speech.environmentId)
      : activeAudioSessionTarget?.environmentId
        ? String(activeAudioSessionTarget.environmentId)
        : "";
    const targetThreadId = speech.threadId ?? activeAudioSessionTarget?.threadId ?? "";
    const targetProjectTitle =
      speech.projectTitle ?? activeAudioSessionTarget?.projectTitle ?? "T3 Code";
    const targetThreadTitle =
      speech.title ?? activeAudioSessionTarget?.threadTitle ?? "Sprachausgabe";

    const audioRowDeepLink =
      targetEnvId && targetThreadId
        ? `/threads/${targetEnvId}/${targetThreadId}`
        : targetThreadId
          ? `/threads/${targetThreadId}`
          : "/";

    const audioRow: AgentActivityRowProps = {
      environmentId: targetEnvId,
      threadId: targetThreadId,
      projectTitle: targetProjectTitle,
      threadTitle: targetThreadTitle,
      modelTitle: "",
      phase: "running",
      status: audioStatus,
      updatedAt: nowIso,
      deepLink: audioRowDeepLink,
      isAudioActive: true,
    };

    const seenThreadIds = new Set<string>();
    if (targetThreadId) seenThreadIds.add(targetThreadId);

    const armedRows: AgentActivityRowProps[] = armedTargets
      .filter((t) => t.threadId !== targetThreadId)
      .map((t) => {
        const envId = t.environmentId ? String(t.environmentId) : "";
        seenThreadIds.add(t.threadId);
        return {
          environmentId: envId,
          threadId: t.threadId,
          projectTitle: t.projectTitle || "T3 Code",
          threadTitle: t.threadTitle || "Thread",
          modelTitle: "",
          phase: "running",
          status: "Antwort abwarten",
          updatedAt: nowIso,
          deepLink: envId ? `/threads/${envId}/${t.threadId}` : `/threads/${t.threadId}`,
          isAudioArmed: true,
        };
      });

    const workingRows: AgentActivityRowProps[] = [];
    const recentRows: AgentActivityRowProps[] = [];
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const nowMs = Date.now();

    try {
      const shells = appAtomRegistry.get(environmentThreadShells.navigationThreadShellsAtom) ?? [];
      for (const shell of shells) {
        if (!shell || !shell.id || seenThreadIds.has(shell.id)) continue;
        const envIdStr = String(shell.environmentId);
        const threadIdStr = String(shell.id);
        const project = appAtomRegistry.get(
          environmentProjects.projectAtom({
            environmentId: shell.environmentId,
            projectId: shell.projectId,
          }),
        );
        const projectTitle = project?.title || "T3 Code";
        const threadTitle = shell.title || "Thread";
        const deepLink = `/threads/${envIdStr}/${threadIdStr}`;

        if (shell.hasPendingApprovals) {
          workingRows.push({
            environmentId: envIdStr,
            threadId: threadIdStr,
            projectTitle,
            threadTitle,
            modelTitle: "",
            phase: "waiting_for_approval",
            status: "Genehmigung erforderlich",
            updatedAt: shell.updatedAt ?? nowIso,
            deepLink,
          });
          seenThreadIds.add(threadIdStr);
        } else if (shell.hasPendingUserInput) {
          workingRows.push({
            environmentId: envIdStr,
            threadId: threadIdStr,
            projectTitle,
            threadTitle,
            modelTitle: "",
            phase: "waiting_for_input",
            status: "Eingabe erforderlich",
            updatedAt: shell.updatedAt ?? nowIso,
            deepLink,
          });
          seenThreadIds.add(threadIdStr);
        } else if (
          shell.runtime !== null &&
          ["preparing", "queued", "starting", "running", "waiting"].includes(shell.runtime.status)
        ) {
          workingRows.push({
            environmentId: envIdStr,
            threadId: threadIdStr,
            projectTitle,
            threadTitle,
            modelTitle: "",
            phase: "running",
            status: "Arbeitet",
            updatedAt: shell.updatedAt ?? nowIso,
            deepLink,
          });
          seenThreadIds.add(threadIdStr);
        } else if (shell.latestRun?.completedAt) {
          const completedAtMs = Date.parse(shell.latestRun.completedAt);
          if (!Number.isNaN(completedAtMs) && nowMs - completedAtMs <= THREE_HOURS_MS) {
            const isFailed = shell.latestRun.status === "failed";
            recentRows.push({
              environmentId: envIdStr,
              threadId: threadIdStr,
              projectTitle,
              threadTitle,
              modelTitle: "",
              phase: isFailed ? "failed" : "completed",
              status: isFailed ? "Fehlgeschlagen" : "Fertig",
              updatedAt: shell.latestRun.completedAt,
              deepLink,
            });
            seenThreadIds.add(threadIdStr);
          }
        }
      }
    } catch {
      // Best-effort registry read
    }

    const allActivities = [audioRow, ...armedRows, ...workingRows, ...recentRows].slice(0, 5);

    const props: AgentActivityProps = {
      title: speech.title || targetThreadTitle || "T3 Code",
      subtitle: audioStatus,
      activeCount: 1 + armedRows.length + workingRows.length,
      updatedAt: nowIso,
      audioPhase: speech.phase === "paused" ? "idle" : (speech.phase ?? "idle"),
      audioThreadId: targetThreadId,
      audioThreadTitle: targetThreadTitle,
      audioProjectTitle: targetProjectTitle,
      activities: allActivities,
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
  if (next.phase === null && !isAudioSessionActive) {
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

/** Stopping is a take-over: all pending answer blocks and active audio die with it. */
export const stopAllSpeech = () => stopCurrent();

const stopCurrent = () => {
  runCounter += 1;
  isUserPausedState = false;
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  answerBlockQueue = [];
  currentAnswerBlock = null;
  currentBlockChunks = [];
  if (T3NativeControls?.stopSpeaking) {
    try {
      void T3NativeControls.stopSpeaking();
    } catch {}
  }
  releasePlaylist();
  cleanupActiveSegments();
  setSpeech(IDLE);
};

const announceExhausted = (message: string) => {
  const now = Date.now();
  // A cascade would stack alerts; the first one stands in for the rest.
  if (now - lastFailureAt >= 15_000) {
    lastFailureAt = now;
    Alert.alert("Read aloud unavailable", message);
  }
  answerBlockQueue = [];
  currentAnswerBlock = null;
  currentBlockChunks = [];
  cleanupActiveSegments();
  releasePlaylist();
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

/**
 * Global queue of complete answer blocks (one block per thread reply).
 * Managed strictly according to First-In, First-Out (FIFO) so that answers
 * from different threads or consecutive replies NEVER interleave their snippets.
 */
let answerBlockQueue: ReadItem[] = [];
let currentAnswerBlock: ReadItem | null = null;
let currentBlockChunks: QueueEntry[] = [];

export const isAudioSessionOrPlaybackActive = (): boolean =>
  isAudioSessionActive || currentSpeech.phase !== null || answerBlockQueue.length > 0;

let enqueueCounter = 0;
let lastFailureAt = 0;
let runCounter = 0;
let isUserPausedState = false;

let playlist: AudioPlaylist | null = null;
let playlistSubscription: { remove: () => void } | null = null;
let activeStreamAbort: AbortController | null = null;
const activeSegmentUris = new Set<string>();

let pausedByVoiceInput: "speech" | "waiting" | null = null;

export const pauseAudioForVoiceRecording = () => {
  if (currentSpeech.phase === "playing" || currentSpeech.phase === "loading") {
    pausedByVoiceInput = "speech";
    if (playlist) {
      try {
        playlist.pause();
      } catch (e) {
        log("pauseAudioForVoiceRecording: playlist.pause() failed", e);
      }
    }
    if (T3NativeControls?.pauseSpeaking) {
      try {
        void T3NativeControls.pauseSpeaking();
      } catch {}
    }
    if (T3NativeControls?.pauseWaitingAudio) {
      try {
        void T3NativeControls.pauseWaitingAudio();
      } catch {}
    }
    setSpeech({ ...currentSpeech, phase: "paused" });
  } else if (isAudioSessionActive && !isUserPausedState) {
    pausedByVoiceInput = "waiting";
    if (T3NativeControls?.pauseWaitingAudio) {
      try {
        void T3NativeControls.pauseWaitingAudio();
      } catch {}
    }
  }
};

export const resumeAudioAfterVoiceRecording = async () => {
  const previousState = pausedByVoiceInput;
  pausedByVoiceInput = null;

  if (!previousState) return;

  await ensureAudioSession();

  if (previousState === "speech") {
    if (playlist) {
      try {
        playlist.play();
        setSpeech({ ...currentSpeech, phase: "playing" });
        return;
      } catch (e) {
        log("resumeAudioAfterVoiceRecording: playlist.play() failed", e);
      }
    }
    if (T3NativeControls?.resumeSpeaking) {
      try {
        await T3NativeControls.resumeSpeaking();
        setSpeech({ ...currentSpeech, phase: "playing" });
        return;
      } catch {}
    }
  } else if (previousState === "waiting") {
    if (isAudioSessionActive && !isUserPausedState) {
      if (T3NativeControls?.resumeWaitingAudio) {
        try {
          await T3NativeControls.resumeWaitingAudio({
            projectTitle: activeAudioSessionTarget?.projectTitle,
            title: "Warte auf Antwort...",
          });
        } catch {}
      }
    }
  }
};

let chunkedPlayback = true;

let playThroughCurrentDeps: ((item: ReadItem) => void) | null = null;
let activeStartAnswerBlock: ((item: ReadItem, isCurrent: () => boolean) => void) | null = null;

const startAnswerBlock = (item: ReadItem) => {
  log("startAnswerBlock:", item.key, "source:", item.source);
  currentAnswerBlock = item;
  currentBlockChunks = [];
  speakStartedAt = Date.now();
  runCounter += 1;
  const run = runCounter;
  const isCurrent = () => run === runCounter;

  const resolvedEnvId = item.environmentId ?? activeSpeechEnvironmentId ?? null;
  if (resolvedEnvId) activeSpeechEnvironmentId = resolvedEnvId;

  const projectTitle = resolveProjectTitle({
    environmentId: resolvedEnvId,
    threadId: item.threadId,
    projectTitle: item.projectTitle,
  });

  setSpeech({
    ...IDLE,
    key: item.key,
    threadId: item.threadId ?? null,
    environmentId: resolvedEnvId,
    title: item.title ?? null,
    projectTitle,
    phase: "loading",
    source: item.source,
    queued: answerBlockQueue.length,
  });

  if (activeStartAnswerBlock) {
    activeStartAnswerBlock(item, isCurrent);
  } else if (playThroughCurrentDeps) {
    playThroughCurrentDeps(item);
  }
};

const finishCurrentAnswerBlock = () => {
  log(
    "finishCurrentAnswerBlock: finished block",
    currentAnswerBlock?.key,
    "remaining in FIFO queue:",
    answerBlockQueue.length,
  );
  releasePlaylist();
  cleanupActiveSegments();
  currentAnswerBlock = null;
  currentBlockChunks = [];

  if (answerBlockQueue.length > 0) {
    const nextBlock = answerBlockQueue.shift()!;
    log(
      "finishCurrentAnswerBlock: starting next block (FIFO):",
      nextBlock.key,
      "remaining:",
      answerBlockQueue.length,
    );
    startAnswerBlock(nextBlock);
  } else {
    log("finishCurrentAnswerBlock: FIFO queue empty, returning to idle");
    setSpeech(IDLE);
    if (isAudioSessionActive) {
      void T3NativeControls?.resumeWaitingAudio?.({
        projectTitle: currentSpeech.projectTitle ?? "T3 Code",
        title: "Warte auf Antwort...",
      });
    }
  }
};

const enqueueAnswerBlock = (
  item: {
    readonly key: string;
    readonly text: string;
    readonly source?: "manual" | "auto";
    readonly clipUri?: string;
    readonly threadId?: string;
    readonly environmentId?: EnvironmentId;
    readonly title?: string;
    readonly projectTitle?: string;
  },
  options?: { readonly forceImmediate?: boolean },
) => {
  if (currentAnswerBlock?.key === item.key) {
    log("enqueueAnswerBlock: already current block, ignoring duplicate", item.key);
    return;
  }
  if (answerBlockQueue.some((b) => b.key === item.key)) {
    log("enqueueAnswerBlock: already in FIFO queue, ignoring duplicate", item.key);
    return;
  }

  const cleanedText = item.clipUri ? item.text : cleanTextForSpeech(item.text);
  if (!item.clipUri && cleanedText.length === 0) {
    log("enqueueAnswerBlock: ignored, text is empty after sanitization");
    return;
  }

  const resolvedEnvId = item.environmentId ?? activeSpeechEnvironmentId ?? null;
  if (resolvedEnvId) activeSpeechEnvironmentId = resolvedEnvId;

  const projectTitle = resolveProjectTitle({
    environmentId: resolvedEnvId,
    threadId: item.threadId,
    projectTitle: item.projectTitle,
  });

  const textToSpeak = item.clipUri
    ? cleanedText
    : prefixTextWithProject(cleanedText, {
        environmentId: resolvedEnvId,
        threadId: item.threadId,
        projectTitle,
      });

  const blockItem: ReadItem = {
    key: item.key,
    text: textToSpeak,
    source: item.source ?? "auto",
    clipUri: item.clipUri,
    threadId: item.threadId,
    environmentId: resolvedEnvId ?? undefined,
    title: item.title,
    projectTitle,
  };

  if (options?.forceImmediate) {
    stopCurrent();
    startAnswerBlock(blockItem);
    return;
  }

  if (currentAnswerBlock === null && currentSpeech.phase === null) {
    startAnswerBlock(blockItem);
  } else {
    answerBlockQueue.push(blockItem);
    log(
      "enqueueAnswerBlock: appended to FIFO queue",
      blockItem.key,
      "total queued blocks:",
      answerBlockQueue.length,
    );
    setSpeech({
      ...currentSpeech,
      queued: answerBlockQueue.length,
    });
  }
};

const skipToNextBlock = () => {
  log("skipToNextBlock called, queued blocks:", answerBlockQueue.length);
  if (answerBlockQueue.length > 0) {
    if (activeStreamAbort) {
      activeStreamAbort.abort();
      activeStreamAbort = null;
    }
    releasePlaylist();
    cleanupActiveSegments();
    if (T3NativeControls?.stopSpeaking) {
      try {
        void T3NativeControls.stopSpeaking();
      } catch {}
    }
    finishCurrentAnswerBlock();
  } else {
    stopCurrent();
  }
};

export function useReadAloud(environmentId?: EnvironmentId | null) {
  const targetEnvId = environmentId ?? activeSpeechEnvironmentId ?? null;
  const preparedConnection = usePreparedConnection(targetEnvId);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const readAloudPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;

  const waitingAudioPreference = readAloudPreferences?.readAloudWaitingAudio ?? "music";
  useEffect(() => {
    setGlobalWaitingAudioMode(waitingAudioPreference);
  }, [waitingAudioPreference]);
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
            queued: answerBlockQueue.length,
          });
          if (T3NativeControls?.pauseWaitingAudio) {
            try {
              void T3NativeControls.pauseWaitingAudio();
            } catch {}
          }
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
          finishCurrentAnswerBlock();
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
    (item: ReadItem, isCurrent: () => boolean) => {
      if (!deviceTtsConfig) return;
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
        let isUserPaused = false;
        if (T3NativeControls?.pauseWaitingAudio) {
          try {
            void T3NativeControls.pauseWaitingAudio();
          } catch {}
        }

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
                pl.setActiveForLockScreen(
                  true,
                  {
                    title: item.title ?? "Antwort",
                    artist: item.projectTitle ? `T3 Code · ${item.projectTitle}` : "T3 Code",
                  },
                  {
                    showPreviousTrack: true,
                    showNextTrack: true,
                    showSeekForward: true,
                    showSeekBackward: true,
                  },
                );
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
                    answerBlockQueue.length,
                  );
                  setSpeech({
                    key: item.key,
                    threadId: item.threadId ?? currentSpeech.threadId,
                    environmentId: item.environmentId ?? currentSpeech.environmentId,
                    title: item.title ?? currentSpeech.title,
                    projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
                    phase: "playing",
                    source: item.source,
                    queued: answerBlockQueue.length,
                  });
                }
                if (started && !status.didJustFinish) {
                  if (!status.playing && currentSpeech.phase === "playing") {
                    log("playlistStatusUpdate: remote paused");
                    isUserPaused = true;
                    isUserPausedState = true;
                    setSpeech({
                      ...currentSpeech,
                      phase: "paused",
                    });
                  } else if (status.playing && currentSpeech.phase === "paused") {
                    log("playlistStatusUpdate: remote resumed");
                    isUserPaused = false;
                    isUserPausedState = false;
                    setSpeech({
                      ...currentSpeech,
                      phase: "playing",
                    });
                  }
                }
                if (status.didJustFinish && streamDone) {
                  clearTimeout(startWatchdog);
                  log("stream consumer: finished all segments, queued:", answerBlockQueue.length);
                  finishCurrentAnswerBlock();
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
                queued: answerBlockQueue.length,
              });

              pl.play();
            } else {
              playlist.add({ uri: segmentUri });
              if (!playlist.playing && !isUserPaused && !isUserPausedState) {
                playlist.play();
              }
            }
          }

          clearTimeout(startWatchdog);
          streamDone = true;
          log("stream consumer: complete stream", `${segmentIndex} segments`);

          // If the last track finished before the stream completion was marked
          if (playlist?.currentStatus?.didJustFinish) {
            log("stream consumer: didJustFinish on stream completion");
            finishCurrentAnswerBlock();
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

  const playClip = useCallback(
    async (chunkItem: ReadItem, isCurrent: () => boolean) => {
      await ensureAudioSession();
      if (!isCurrent()) return;

      try {
        let clipUri: string | null;
        if (chunkItem.clipUri) {
          clipUri = chunkItem.clipUri;
        } else {
          const result = await Promise.race([
            ttsSynthesize({
              environmentId: (chunkItem.environmentId ?? environmentId) as EnvironmentId,
              input: { text: chunkItem.text },
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
            if (await speakWithNativeFallback(chunkItem, isCurrent)) return;
            announceExhausted(
              "The server could not synthesize this reply. Check the read-aloud settings on your Mac.",
            );
            return;
          }
          clipUri =
            httpBaseUrl === null ? null : resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
          if (clipUri === null) {
            if (await speakWithNativeFallback(chunkItem, isCurrent)) return;
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

        if (T3NativeControls?.pauseWaitingAudio) {
          try {
            void T3NativeControls.pauseWaitingAudio();
          } catch {}
        }
        log(
          "playlist: created",
          chunkItem.clipUri ? "device segment" : "server clip",
          `${Date.now() - (speakStartedAt || Date.now())}ms after speak`,
          clipUri,
        );
        playlist = clipPlaylist;
        try {
          clipPlaylist.setActiveForLockScreen(
            true,
            {
              title: chunkItem.title ?? "Antwort",
              artist: chunkItem.projectTitle ? `T3 Code · ${chunkItem.projectTitle}` : "T3 Code",
            },
            {
              showPreviousTrack: true,
              showNextTrack: true,
              showSeekForward: true,
              showSeekBackward: true,
            },
          );
        } catch {}

        let started = false;

        const startWatchdog = setTimeout(() => {
          if (started || !isCurrent()) return;
          releasePlaylist();
          void (async () => {
            if (await speakWithNativeFallback(chunkItem, isCurrent)) return;
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
              answerBlockQueue.length,
            );
            setSpeech({
              key: chunkItem.key,
              threadId: chunkItem.threadId ?? currentSpeech.threadId,
              environmentId: chunkItem.environmentId ?? currentSpeech.environmentId,
              title: chunkItem.title ?? currentSpeech.title,
              projectTitle: chunkItem.projectTitle ?? currentSpeech.projectTitle,
              phase: "playing",
              source: chunkItem.source,
              queued: answerBlockQueue.length,
            });
          }
          if (started && !status.didJustFinish) {
            if (!status.playing && currentSpeech.phase === "playing") {
              log("playlistStatusUpdate (clip): remote paused");
              setSpeech({
                ...currentSpeech,
                phase: "paused",
              });
            } else if (status.playing && currentSpeech.phase === "paused") {
              log("playlistStatusUpdate (clip): remote resumed");
              setSpeech({
                ...currentSpeech,
                phase: "playing",
              });
            }
          }
          if (status.didJustFinish) {
            clearTimeout(startWatchdog);
            releasePlaylist();
            log(
              "playlist: finished chunk, remaining in current block:",
              currentBlockChunks.length,
              "queued blocks:",
              answerBlockQueue.length,
            );
            if (currentBlockChunks.length > 0) {
              const nextChunk = currentBlockChunks.shift()!;
              void playClip(nextChunk, isCurrent);
            } else {
              finishCurrentAnswerBlock();
            }
          }
        });

        setSpeech({
          key: chunkItem.key,
          threadId: chunkItem.threadId ?? currentSpeech.threadId,
          environmentId: chunkItem.environmentId ?? currentSpeech.environmentId,
          title: chunkItem.title ?? currentSpeech.title,
          projectTitle: chunkItem.projectTitle ?? currentSpeech.projectTitle,
          phase: "loading",
          source: chunkItem.source,
          queued: answerBlockQueue.length,
        });
        clipPlaylist.play();
      } catch (error) {
        if (!isCurrent()) return;
        log("playlist: failed", error);
        if (await speakWithNativeFallback(chunkItem, isCurrent)) return;
        announceExhausted(
          error instanceof Error && error.message.length > 0
            ? error.message
            : "The server did not answer. Check the connection and try again.",
        );
      }
    },
    [environmentId, httpBaseUrl, speakWithNativeFallback, ttsSynthesize],
  );

  const playServerOrClipBlock = useCallback(
    (item: ReadItem, isCurrent: () => boolean) => {
      if (httpBaseUrl === null && !deviceTtsConfig && !item.clipUri) {
        void (async () => {
          if (await speakWithNativeFallback(item, isCurrent)) return;
          announceExhausted("This environment is not connected right now.");
        })();
        return;
      }

      if (item.clipUri) {
        void playClip(item, isCurrent);
        return;
      }

      const chunks = chunkedPlayback ? chunkReply(item.text) : [item.text];
      const lead = chunks[0];
      if (lead === undefined) {
        finishCurrentAnswerBlock();
        return;
      }

      currentBlockChunks = chunks.slice(1).map((text, idx) => ({
        ...item,
        text,
        dedupeKey: `${item.key}#${idx + 1}`,
      }));

      void playClip({ ...item, text: lead }, isCurrent);
    },
    [deviceTtsConfig, httpBaseUrl, playClip, speakWithNativeFallback],
  );

  const speak = useCallback(
    (
      item: {
        readonly key: string;
        readonly text: string;
        readonly threadId?: string;
        readonly environmentId?: EnvironmentId;
        readonly title?: string;
        readonly projectTitle?: string;
      },
      options?: { readonly forceImmediate?: boolean },
    ) => {
      enqueueAnswerBlock(
        {
          ...item,
          source: "manual",
        },
        { forceImmediate: options?.forceImmediate ?? true },
      );
    },
    [],
  );

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
      enqueueAnswerBlock({
        ...item,
        source: "auto",
      });
    },
    [],
  );

  const pause = useCallback(() => {
    log("pause called, currentSpeech:", currentSpeech);
    isUserPausedState = true;
    if (playlist) {
      try {
        playlist.pause();
      } catch (e) {
        log("pause: playlist.pause() failed", e);
      }
    }
    if (T3NativeControls?.pauseSpeaking) {
      try {
        void T3NativeControls.pauseSpeaking();
      } catch (e) {}
    }
    if (T3NativeControls?.pauseWaitingAudio) {
      try {
        void T3NativeControls.pauseWaitingAudio();
      } catch (e) {}
    }
    setSpeech({ ...currentSpeech, phase: "paused" });
  }, []);

  const resume = useCallback(() => {
    log("resume called, currentSpeech:", currentSpeech);
    isUserPausedState = false;
    if (playlist) {
      try {
        playlist.play();
        setSpeech({ ...currentSpeech, phase: "playing" });
        if (T3NativeControls?.resumeSpeaking) {
          try {
            void T3NativeControls.resumeSpeaking();
          } catch {}
        }
        return;
      } catch (e) {
        log("resume: playlist.play() failed", e);
      }
    }
    if (isAudioSessionActive) {
      if (T3NativeControls?.resumeWaitingAudio) {
        try {
          void T3NativeControls.resumeWaitingAudio({
            projectTitle: currentSpeech.projectTitle ?? activeAudioSessionTarget?.projectTitle,
            title: "Warte auf Antwort...",
          });
        } catch (e) {}
      } else if (T3NativeControls?.resumeSpeaking) {
        try {
          void T3NativeControls.resumeSpeaking();
        } catch (e) {}
      }
      setSpeech({ ...currentSpeech, phase: null });
      return;
    }
    if (T3NativeControls?.resumeSpeaking && currentSpeech.phase === "paused") {
      try {
        void T3NativeControls.resumeSpeaking();
      } catch (e) {}
      setSpeech({ ...currentSpeech, phase: "playing" });
      return;
    }
  }, []);

  const seekBy = useCallback((deltaSeconds: number) => {
    if (playlist) {
      try {
        const pl = playlist as unknown as {
          currentTime?: number;
          currentIndex?: number;
          trackCount?: number;
          currentStatus?: { currentTime?: number; currentIndex?: number };
          seekTo?: (seconds: number) => Promise<void>;
          skipTo?: (index: number) => void;
          previous?: () => void;
        };
        const current = pl.currentTime ?? pl.currentStatus?.currentTime ?? 0;
        const target = current + deltaSeconds;
        if (target < 0) {
          const currentIndex = pl.currentIndex ?? pl.currentStatus?.currentIndex ?? 0;
          if (currentIndex > 0) {
            pl.skipTo?.(currentIndex - 1);
          } else {
            void pl.seekTo?.(0);
          }
        } else {
          void pl.seekTo?.(target);
        }
      } catch (e) {
        log("seekBy: failed", e);
      }
    }
  }, []);

  const stop = useCallback(() => {
    stopCurrent();
  }, []);

  useEffect(() => {
    activeStartAnswerBlock = (item: ReadItem, isCurrent: () => boolean) => {
      if (deviceTtsConfig && !item.clipUri) {
        consumeDeviceStream(item, isCurrent);
      } else {
        playServerOrClipBlock(item, isCurrent);
      }
    };
    playThroughCurrentDeps = (item: ReadItem) => {
      const run = ++runCounter;
      const isCurrent = () => run === runCounter;
      if (deviceTtsConfig && !item.clipUri) {
        consumeDeviceStream(item, isCurrent);
      } else {
        playServerOrClipBlock(item, isCurrent);
      }
    };
  }, [consumeDeviceStream, deviceTtsConfig, playServerOrClipBlock]);

  return { speech, speak, pause, resume, seekBy, stop, enqueue, skipNext: skipToNextBlock };
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
      if (isAudioSessionActive || isReadAloudArmedOnNextReply(threadId)) {
        const armed = armedTargets.get(threadId);
        if (!isAudioSessionActive) {
          disarmReadAloudOnNextReply(threadId);
        }
        for (const item of newlyFinished) {
          const textToSpeak = turnTexts?.get(item.key) ?? item.text;
          const resolvedProject = armed?.projectTitle ?? projectTitle;
          enqueue({
            key: item.key,
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
