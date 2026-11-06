import {
  registerAudioPlaybackActivePredicate,
  isAudioSessionOrPlaybackActive,
} from "../../lib/audioActiveTracker";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { savePreferencesPatch } from "../../persistence/imperative";
import { AsyncResult, Atom } from "effect/reactivity";
import { Directory, File, Paths } from "expo-file-system";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { getDeviceTtsConfig, streamWavSegments, summarizeOnDevice } from "./deviceTts";
import {
  audioDurationSeconds,
  estimateSpeechSeconds,
  isTimelineExact,
  locateTimelineTime,
  timelineDuration,
  timelinePosition,
  type ReadAloudTimeline,
} from "./readAloudTimeline";
import { cleanTextForSpeech, type SpeechLanguageHint } from "@t3tools/shared/textForSpeech";
import type { TurnPart } from "../../lib/threadActivity";
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
  /** Set for threads read as short updates; `text` stays the full reply as the fallback. */
  readonly summary?: { readonly prefix: string; readonly body: string };
}

/** Whole-reply playback position, rounded to seconds so subscribers re-render at most once per second. */
export interface ReadAloudProgress {
  readonly position: number;
  readonly duration: number;
  /** False while the duration still includes text-length estimates. */
  readonly exact: boolean;
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
        seekReadAloudBy(10);
      } else if (cmd === "skipBackward") {
        seekReadAloudBy(-10);
      } else if (cmd === "previousTrack") {
        skipToPreviousAnswer();
      } else if (cmd === "nextTrack") {
        skipToNextAnswer();
      } else if (cmd === "stop") {
        stopGlobalAudioSession();
      }
    });
  } catch {}
}

/**
 * ±10s seeks across playlist items through `seekReadAloudBy`. Not marked as a
 * live stream: iOS then offers only Stop, which ends the whole audio session.
 */
const READ_ALOUD_LOCK_SCREEN_OPTIONS = {
  showPreviousTrack: false,
  showNextTrack: false,
  showSeekForward: true,
  showSeekBackward: true,
} as const;

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
  // Just the name: an English lead word ("Thread") tilts the voice model to English for the whole reply.
  const expectedPrefix = `${projectTitle}:`;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const title = projectTitle.toLowerCase();
  if (lower.startsWith(`${title}:`) || lower.startsWith(`${title}.`)) {
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

/** Space the floating two-row audio bar takes below the navigation bar, including its gap. */
export const AUDIO_BAR_CLEARANCE = 96;

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

let lastAudioLiveActivitySignature: string | null = null;

/** Thread rows in the Live Activity follow the thread list, not only playback changes. */
/** `_changedRows` names what changed; the Live Activity reads the current rows itself. */
export const refreshAudioLiveActivity = (_changedRows?: unknown) =>
  syncAudioLiveActivity(currentSpeech);

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
    const isWaiting = speech.phase === null;
    const audioStatus =
      speech.phase === "loading"
        ? "Lade Audio..."
        : speech.phase === "playing"
          ? "Liest Antwort vor"
          : speech.phase === "paused"
            ? "Pausiert"
            : "Warte auf Antwort";

    const targetEnvId = speech.environmentId
      ? String(speech.environmentId)
      : activeAudioSessionTarget?.environmentId
        ? String(activeAudioSessionTarget.environmentId)
        : "";
    const targetThreadId = speech.threadId ?? activeAudioSessionTarget?.threadId ?? "";
    const targetProjectTitle =
      speech.projectTitle ?? activeAudioSessionTarget?.projectTitle ?? "T3 Code";
    // While waiting nothing is being read, so the row must not name a thread as if it played.
    const targetThreadTitle = isWaiting
      ? "Warte auf Antwort..."
      : (speech.title ?? activeAudioSessionTarget?.threadTitle ?? "Sprachausgabe");

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
      title: isWaiting ? targetThreadTitle : speech.title || targetThreadTitle || "T3 Code",
      subtitle: audioStatus,
      activeCount: 1 + armedRows.length + workingRows.length,
      updatedAt: nowIso,
      audioPhase: speech.phase === "paused" ? "idle" : (speech.phase ?? "idle"),
      audioThreadId: targetThreadId,
      audioThreadTitle: targetThreadTitle,
      audioProjectTitle: targetProjectTitle,
      activities: allActivities,
    };

    // iOS budgets Live Activity updates; skip ones that change nothing but timestamps.
    const signature = JSON.stringify(props, (key, value) =>
      key === "updatedAt" ? undefined : value,
    );
    if (activeAudioLiveActivity && signature === lastAudioLiveActivitySignature) return;
    lastAudioLiveActivitySignature = signature;

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
  // The recorder shares this session; it releases it itself when recording ends.
  if (isVoiceRecordingActive) return;
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
  setTimeline(null);
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
  // isVoiceRecordingActive belongs to the recorder; stopping playback mid-recording must not clear it.
  pausedByVoiceInput = null;
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  answerBlockQueue = [];
  currentAnswerBlock = null;
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
  pausedByVoiceInput = null;
  cleanupActiveSegments();
  releasePlaylist();
  setSpeech(IDLE);
};

/**
 * Ensures iOS audio session is active and configured for playback without ducking.
 */
const ensureAudioSession = async () => {
  if (isVoiceRecordingActive) {
    log("ensureAudioSession: suppressed because voice recording is active");
    return;
  }
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
 * Synthesis requests in flight per reply. Enough to stay ahead of playback
 * without tripping free-tier rate limits.
 */
const SYNTHESIS_CONCURRENCY = 3;

/** Starts `run` for each input in order, at most `limit` at a time. */
const mapWithConcurrency = <A, B>(
  inputs: ReadonlyArray<A>,
  limit: number,
  run: (input: A, index: number) => Promise<B>,
): Array<Promise<B>> => {
  const settlers = inputs.map(() => {
    let resolve!: (value: B) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<B>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  });
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      try {
        settlers[index]!.resolve(await run(inputs[index]!, index));
      } catch (error) {
        settlers[index]!.reject(error);
      }
    }
  };
  for (let slot = 0; slot < Math.min(limit, inputs.length); slot += 1) void worker();
  return settlers.map((settler) => settler.promise);
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
/** Answers already played or skipped this session, oldest first, for skipping back. */
const playedAnswerBlocks: ReadItem[] = [];
const MAX_PLAYED_ANSWER_BLOCKS = 20;
/** Going back further into an answer than this restarts it instead of replaying the previous one. */
const RESTART_ANSWER_THRESHOLD_SECONDS = 3;

export { isAudioSessionOrPlaybackActive };

registerAudioPlaybackActivePredicate(
  () => isAudioSessionActive || currentSpeech.phase !== null || answerBlockQueue.length > 0,
);

const MAX_ANNOUNCED_REPLY_KEYS = 200;
const announcedReplyKeys = new Set<string>();

let lastFailureAt = 0;
let runCounter = 0;
let isUserPausedState = false;

let playlist: AudioPlaylist | null = null;
let playlistSubscription: { remove: () => void } | null = null;
let activeStreamAbort: AbortController | null = null;
const activeSegmentUris = new Set<string>();

let timeline: ReadAloudTimeline | null = null;
let progress: ReadAloudProgress | null = null;
const progressListeners = new Set<Listener>();

const publishProgress = () => {
  let next: ReadAloudProgress | null = null;
  if (timeline !== null) {
    const status = playlist?.currentStatus;
    const index = status?.currentIndex ?? playlist?.currentIndex ?? 0;
    const time = status?.currentTime ?? playlist?.currentTime ?? 0;
    const duration = timelineDuration(timeline);
    next = {
      position: Math.floor(Math.min(timelinePosition(timeline, index, time), duration)),
      duration: Math.round(duration),
      exact: isTimelineExact(timeline),
    };
  }
  if (
    next?.position === progress?.position &&
    next?.duration === progress?.duration &&
    next?.exact === progress?.exact
  ) {
    return;
  }
  progress = next;
  for (const listener of progressListeners) listener();
};

const setTimeline = (next: ReadAloudTimeline | null) => {
  timeline = next;
  publishProgress();
};

const setTimelineTrack = (index: number, seconds: number) => {
  if (timeline === null || index >= timeline.tracks.length) return;
  const tracks = [...timeline.tracks];
  tracks[index] = { seconds, exact: true };
  setTimeline({ ...timeline, tracks });
};

const subscribeProgress = (listener: Listener) => {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
};

export const useReadAloudProgress = (): ReadAloudProgress | null =>
  useSyncExternalStore(
    subscribeProgress,
    () => progress,
    () => null,
  );

/** Seeks relative to the whole reply, crossing clip boundaries inside the playlist. */
export const seekReadAloudBy = (deltaSeconds: number) => {
  const pl = playlist;
  if (!pl) return;
  try {
    const index = pl.currentIndex;
    const current = timeline ? timelinePosition(timeline, index, pl.currentTime) : pl.currentTime;
    const target = timeline
      ? locateTimelineTime(timeline, current + deltaSeconds, pl.trackCount)
      : { index, offset: Math.max(0, current + deltaSeconds) };
    if (target.index !== index) pl.skipTo(target.index);
    void pl.seekTo(target.offset);
  } catch (e) {
    log("seekReadAloudBy: failed", e);
  }
};

/** Exact clip length from the file on disk; the estimate stays when it cannot be read. */
const readClipSeconds = async (uri: string): Promise<number | null> => {
  try {
    return audioDurationSeconds(new Uint8Array(await new File(uri).arrayBuffer()));
  } catch {
    return null;
  }
};

let isVoiceRecordingActive = false;
let pausedByVoiceInput: "speech" | "waiting" | "idle" | null = null;

export const getIsVoiceRecordingActive = () => isVoiceRecordingActive;

export const pauseAudioForVoiceRecording = () => {
  isVoiceRecordingActive = true;
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
  } else {
    pausedByVoiceInput = "idle";
  }
};

export const resumeAudioAfterVoiceRecording = async () => {
  const previousState = pausedByVoiceInput;
  pausedByVoiceInput = null;
  isVoiceRecordingActive = false;

  // The session may have been ended during recording; nothing is left to resume then.
  if (!isAudioSessionActive && currentAnswerBlock === null && answerBlockQueue.length === 0) {
    return;
  }
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
    if (currentAnswerBlock) {
      startAnswerBlock(currentAnswerBlock);
      return;
    }
  }

  // If no speech was playing (or speech couldn't resume), but answer blocks were queued:
  if (currentAnswerBlock === null && answerBlockQueue.length > 0) {
    const nextBlock = answerBlockQueue.shift()!;
    log("resumeAudioAfterVoiceRecording: starting queued answer block", nextBlock.key);
    startAnswerBlock(nextBlock);
    return;
  }

  if (previousState === "waiting" || (isAudioSessionActive && !isUserPausedState)) {
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
/** Mirrors the read-aloud preferences for the module-level queue. */
let speechLanguageHint: SpeechLanguageHint | undefined;
let summaryThreadKeys: ReadonlySet<string> = new Set();
/** How long a short update may take before the full reply is read instead. */
const SUMMARY_TIMEOUT_MS = 15_000;

export const readAloudSummaryKey = (environmentId: string, threadId: string) =>
  `${environmentId}/${threadId}`;

let playThroughCurrentDeps: ((item: ReadItem) => void) | null = null;
let activeStartAnswerBlock: ((item: ReadItem, isCurrent: () => boolean) => void) | null = null;

const startAnswerBlock = (item: ReadItem) => {
  if (isVoiceRecordingActive) {
    log("startAnswerBlock: held because voice recording is active", item.key);
    answerBlockQueue.unshift(item);
    setSpeech({
      ...currentSpeech,
      queued: answerBlockQueue.length,
    });
    return;
  }
  log("startAnswerBlock:", item.key, "source:", item.source);
  currentAnswerBlock = item;
  isUserPausedState = false;
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
  if (currentAnswerBlock !== null) {
    playedAnswerBlocks.push(currentAnswerBlock);
    if (playedAnswerBlocks.length > MAX_PLAYED_ANSWER_BLOCKS) playedAnswerBlocks.shift();
  }
  currentAnswerBlock = null;

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
    readonly turnParts?: ReadonlyArray<TurnPart>;
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
  // The thread feed, armed watchers and completion watchers can all report the
  // same reply; it is read once even after it finished playing.
  if (item.source !== "manual" && announcedReplyKeys.has(item.key)) {
    log("enqueueAnswerBlock: already announced, ignoring duplicate", item.key);
    return;
  }

  // An automatic reply reads its turn from the first part not spoken yet: a
  // partial answer read mid-turn is not repeated when the rest arrives.
  const turnParts = item.source !== "manual" ? item.turnParts : undefined;
  const text =
    turnParts && turnParts.length > 0
      ? turnParts
          .filter((part) => !announcedReplyKeys.has(part.key))
          .map((part) => part.text)
          .join("\n\n")
      : item.text;
  const cleanedText = item.clipUri ? text : cleanTextForSpeech(text);
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

  for (const key of [item.key, ...(turnParts ?? []).map((part) => part.key)]) {
    announcedReplyKeys.add(key);
  }
  while (announcedReplyKeys.size > MAX_ANNOUNCED_REPLY_KEYS) {
    announcedReplyKeys.delete(announcedReplyKeys.values().next().value!);
  }

  // A manual "read this" plays in full; automatic replies of summary threads get condensed.
  const summarize =
    item.source !== "manual" &&
    !item.clipUri &&
    resolvedEnvId !== null &&
    item.threadId !== undefined &&
    summaryThreadKeys.has(readAloudSummaryKey(resolvedEnvId, item.threadId));
  const blockItem: ReadItem = {
    key: item.key,
    text: textToSpeak,
    source: item.source ?? "auto",
    clipUri: item.clipUri,
    threadId: item.threadId,
    environmentId: resolvedEnvId ?? undefined,
    title: item.title,
    projectTitle,
    ...(summarize ? { summary: { prefix: `${projectTitle}:`, body: cleanedText } } : {}),
  };

  if (options?.forceImmediate) {
    if (isVoiceRecordingActive) {
      log(
        "enqueueAnswerBlock: forceImmediate held because voice recording is active",
        blockItem.key,
      );
      answerBlockQueue.unshift(blockItem);
      setSpeech({
        ...currentSpeech,
        queued: answerBlockQueue.length,
      });
      return;
    }
    stopCurrent();
    startAnswerBlock(blockItem);
    return;
  }

  // Only a playing answer may hold replies back. A paused waiting loop is not
  // one: queueing behind it would leave the reply stranded until a newer one
  // starts, and then it would play after that newer reply.
  if (currentAnswerBlock === null && !isVoiceRecordingActive) {
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

/** Silences whatever is producing the current answer without settling it. */
const haltCurrentAnswerAudio = () => {
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  releasePlaylist();
  cleanupActiveSegments();
  if (T3NativeControls?.stopSpeaking) {
    try {
      void T3NativeControls.stopSpeaking();
    } catch {}
  }
};

/** Ends the current answer early; the next queued answer starts, or audio goes idle. */
export const skipToNextAnswer = () => {
  log("skipToNextAnswer called, queued blocks:", answerBlockQueue.length);
  if (currentAnswerBlock === null) return;
  haltCurrentAnswerAudio();
  finishCurrentAnswerBlock();
};

/**
 * Drops the current answer, paused or not, and keeps the session: the next queued answer
 * plays, otherwise it waits for the next reply. Stopping releases a manual pause, since the
 * paused answer is gone; during a recording the session resumes waiting once the mic is off.
 */
export const stopCurrentAnswer = () => {
  log("stopCurrentAnswer called, queued blocks:", answerBlockQueue.length);
  if (currentAnswerBlock === null) return;
  isUserPausedState = false;
  if (pausedByVoiceInput !== null) pausedByVoiceInput = "waiting";
  haltCurrentAnswerAudio();
  finishCurrentAnswerBlock();
};

/**
 * Podcast-style back: a few seconds into an answer it restarts that answer,
 * at its start it replays the previous one and queues the current answer
 * right after it.
 */
export const skipToPreviousAnswer = () => {
  const current = currentAnswerBlock;
  const position = progress?.position ?? 0;
  const previous = playedAnswerBlocks.at(-1);
  log("skipToPreviousAnswer called, position:", position, "history:", playedAnswerBlocks.length);
  if (current !== null && playlist && (position >= RESTART_ANSWER_THRESHOLD_SECONDS || !previous)) {
    try {
      if (playlist.currentIndex !== 0) playlist.skipTo(0);
      void playlist.seekTo(0);
    } catch (e) {
      log("skipToPreviousAnswer: restart failed", e);
    }
    return;
  }
  if (!previous) return;
  playedAnswerBlocks.pop();
  haltCurrentAnswerAudio();
  if (current !== null) answerBlockQueue.unshift(current);
  currentAnswerBlock = null;
  startAnswerBlock(previous);
};

export function useReadAloud(environmentId?: EnvironmentId | null) {
  const targetEnvId = environmentId ?? activeSpeechEnvironmentId ?? null;
  const preparedConnection = usePreparedConnection(targetEnvId);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const readAloudPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;

  const waitingAudioPreference = readAloudPreferences?.readAloudWaitingAudio ?? "music";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the native waiting-audio mode in step with the preference
  useEffect(() => {
    setGlobalWaitingAudioMode(waitingAudioPreference);
  }, [waitingAudioPreference]);
  const readAloudProvider = readAloudPreferences?.readAloudProvider;
  const readAloudGeminiApiKey = readAloudPreferences?.readAloudGeminiApiKey;
  const readAloudGeminiModel = readAloudPreferences?.readAloudGeminiModel;
  const readAloudGeminiVoice = readAloudPreferences?.readAloudGeminiVoice;
  const readAloudLanguage = readAloudPreferences?.readAloudLanguage;
  const readAloudSummaryThreads = readAloudPreferences?.readAloudSummaryThreads;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the module-level queue reads the language and summary threads outside React
  useEffect(() => {
    speechLanguageHint = readAloudLanguage;
    summaryThreadKeys = new Set(readAloudSummaryThreads ?? []);
  }, [readAloudLanguage, readAloudSummaryThreads]);

  const deviceTtsConfig = useMemo(
    () =>
      getDeviceTtsConfig({
        readAloudProvider,
        readAloudGeminiApiKey,
        readAloudGeminiModel,
        readAloudGeminiVoice,
        readAloudLanguage,
      }),
    [
      readAloudProvider,
      readAloudGeminiApiKey,
      readAloudGeminiModel,
      readAloudGeminiVoice,
      readAloudLanguage,
    ],
  );
  const ttsSynthesize = useAtomCommand(serverEnvironment.ttsSynthesize, {
    label: "speak message",
    reportFailure: false,
  });
  const ttsSummarize = useAtomCommand(serverEnvironment.ttsSummarize, {
    label: "summarize message",
    reportFailure: false,
  });
  const ttsSettings = useAtomValue(
    targetEnvId ? serverEnvironment.settingsValueAtom(targetEnvId) : EMPTY_SETTINGS_ATOM,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the module-level player reads the server's chunking setting outside React
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
        if (isVoiceRecordingActive) {
          log(
            "speakWithNativeFallback: voice recording active, cannot speak with native synthesizer",
          );
          answerBlockQueue.unshift(itemToSpeak);
          setSpeech({
            ...currentSpeech,
            queued: answerBlockQueue.length,
          });
          return true;
        }
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
            language: speechLanguageHint === "en" ? "en-US" : "de-DE",
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
          // The stream only reveals segment lengths as they arrive; until it ends,
          // the rest of the reply counts as an estimate.
          setTimeline({
            tracks: [],
            pendingSeconds: estimateSpeechSeconds(cleanTextForSpeech(item.text)),
          });

          for await (const segmentUri of streamWavSegments(
            deviceTtsConfig,
            item.text,
            abort.signal,
          )) {
            firstSegmentSeen = true;
            if (activeStreamAbort !== abort) return;
            segmentIndex += 1;
            activeSegmentUris.add(segmentUri);
            const segmentSeconds = await readClipSeconds(segmentUri);
            if (activeStreamAbort !== abort) return;
            if (timeline !== null) {
              setTimeline({
                tracks: [
                  ...timeline.tracks,
                  { seconds: segmentSeconds ?? 0, exact: segmentSeconds !== null },
                ],
                pendingSeconds: Math.max(0, timeline.pendingSeconds - (segmentSeconds ?? 0)),
              });
            }

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
                  READ_ALOUD_LOCK_SCREEN_OPTIONS,
                );
              } catch {}

              pl.addListener("trackChanged", ({ previousIndex, currentIndex }) => {
                log("playlist trackChanged:", previousIndex, "->", currentIndex);
              });

              playlistSubscription = pl.addListener("playlistStatusUpdate", (status) => {
                if (activeStreamAbort !== abort) return;
                publishProgress();
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

              if (isVoiceRecordingActive) {
                log("consumeDeviceStream: voice recording active, holding stream segment");
                setSpeech({
                  key: item.key,
                  threadId: item.threadId ?? currentSpeech.threadId,
                  environmentId: item.environmentId ?? currentSpeech.environmentId,
                  title: item.title ?? currentSpeech.title,
                  projectTitle: item.projectTitle ?? currentSpeech.projectTitle,
                  phase: "paused",
                  source: item.source,
                  queued: answerBlockQueue.length,
                });
                pausedByVoiceInput = "speech";
              } else {
                pl.play();
              }
            } else {
              playlist.add({ uri: segmentUri });
              if (
                !playlist.playing &&
                !isUserPaused &&
                !isUserPausedState &&
                !isVoiceRecordingActive
              ) {
                playlist.play();
              }
            }
          }

          clearTimeout(startWatchdog);
          streamDone = true;
          if (timeline !== null) setTimeline({ ...timeline, pendingSeconds: 0 });
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

  /**
   * Synthesizes every chunk of the reply up front, a few at a time, and plays
   * them through one playlist so the reply behaves like a single track: one
   * lock-screen entry, one position and duration, seeking across chunks. The
   * lead chunk stays short so the first sound still arrives quickly.
   */
  const playServerBlock = useCallback(
    (item: ReadItem, isCurrent: () => boolean) => {
      if (httpBaseUrl === null && !item.clipUri) {
        void (async () => {
          if (await speakWithNativeFallback(item, isCurrent)) return;
          announceExhausted("This environment is not connected right now.");
        })();
        return;
      }

      const texts = item.clipUri || !chunkedPlayback ? [item.text] : chunkReply(item.text);
      if (texts.length === 0) {
        finishCurrentAnswerBlock();
        return;
      }

      const synthesizeChunk = async (text: string): Promise<string> => {
        const result = await Promise.race([
          ttsSynthesize({
            environmentId: (item.environmentId ?? environmentId) as EnvironmentId,
            input: { text, ...(speechLanguageHint ? { languageHint: speechLanguageHint } : {}) },
          }),
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(new Error("The server did not answer. Check the connection and try again.")),
              SYNTHESIZE_TIMEOUT_MS,
            );
          }),
        ]);
        if (result._tag !== "Success") {
          throw new Error(
            "The server could not synthesize this reply. Check the read-aloud settings on your Mac.",
          );
        }
        const url =
          httpBaseUrl === null ? null : resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
        if (url === null) {
          throw new Error("The reply clip could not be loaded. Reconnect and try again.");
        }
        const file = await File.downloadFileAsync(url, new Directory(Paths.cache), {
          idempotent: true,
        });
        return file.uri;
      };

      void (async () => {
        await ensureAudioSession();
        if (!isCurrent()) return;

        let pl: AudioPlaylist | null = null;
        let abandoned = false;
        const isLive = () => isCurrent() && !abandoned;
        let started = false;
        let allAdded = false;
        // The playlist played everything it had before the next clip arrived.
        let drained = false;
        let unspokenRest: ReadItem | null = null;
        let startWatchdog: ReturnType<typeof setTimeout> | undefined;

        const finishBlock = () => {
          clearTimeout(startWatchdog);
          const rest = unspokenRest;
          releasePlaylist();
          if (rest === null) {
            finishCurrentAnswerBlock();
            return;
          }
          void (async () => {
            if (await speakWithNativeFallback(rest, isCurrent)) return;
            announceExhausted("The server stopped answering partway through this reply.");
          })();
        };

        try {
          setTimeline({
            tracks: texts.map((text) => ({ seconds: estimateSpeechSeconds(text), exact: false })),
            pendingSeconds: 0,
          });
          const clipUris = mapWithConcurrency(texts, SYNTHESIS_CONCURRENCY, async (text, index) => {
            if (!isLive()) throw new Error("Superseded.");
            const uri = item.clipUri ?? (await synthesizeChunk(text));
            if (!item.clipUri) activeSegmentUris.add(uri);
            if (!isLive()) throw new Error("Superseded.");
            const seconds = await readClipSeconds(uri);
            if (seconds !== null && isLive()) setTimelineTrack(index, seconds);
            return uri;
          });
          // Later clips may fail after this block stopped waiting for them.
          for (const clip of clipUris) clip.catch(() => undefined);

          for (let index = 0; index < clipUris.length; index += 1) {
            let uri: string;
            try {
              uri = await clipUris[index]!;
            } catch (error) {
              if (!isLive()) return;
              log("playlist: clip failed", index, error);
              const rest: ReadItem = {
                ...item,
                clipUri: undefined,
                text: texts.slice(index).join(" "),
              };
              if (pl === null) {
                setTimeline(null);
                if (await speakWithNativeFallback(rest, isCurrent)) return;
                announceExhausted(
                  error instanceof Error && error.message.length > 0
                    ? error.message
                    : "The server did not answer. Check the connection and try again.",
                );
                return;
              }
              unspokenRest = rest;
              if (timeline !== null) {
                setTimeline({ ...timeline, tracks: timeline.tracks.slice(0, index) });
              }
              break;
            }
            if (!isLive()) return;

            if (pl !== null) {
              pl.add({ uri });
              if (drained) {
                drained = false;
                pl.skipTo(index);
                if (!isUserPausedState && !isVoiceRecordingActive) pl.play();
              }
              continue;
            }

            const created = createAudioPlaylist({ sources: [{ uri }] });
            pl = created;
            playlist = created;
            if (T3NativeControls?.pauseWaitingAudio) {
              try {
                void T3NativeControls.pauseWaitingAudio();
              } catch {}
            }
            log(
              "playlist: created",
              item.clipUri ? "device clip" : `server clip 1/${texts.length}`,
              `${Date.now() - (speakStartedAt || Date.now())}ms after speak`,
              uri,
            );
            try {
              created.setActiveForLockScreen(
                true,
                {
                  title: item.title ?? "Antwort",
                  artist: item.projectTitle ? `T3 Code · ${item.projectTitle}` : "T3 Code",
                },
                READ_ALOUD_LOCK_SCREEN_OPTIONS,
              );
            } catch {}

            startWatchdog = setTimeout(() => {
              if (started || !isLive()) return;
              abandoned = true;
              releasePlaylist();
              void (async () => {
                if (await speakWithNativeFallback(item, isCurrent)) return;
                announceExhausted("The reply clip did not start playing.");
              })();
            }, START_WATCHDOG_MS);

            playlistSubscription = created.addListener("playlistStatusUpdate", (status) => {
              if (!isLive()) return;
              publishProgress();
              if (!started && status.isLoaded) {
                if (isVoiceRecordingActive) {
                  log("playServerBlock: voice recording active, holding loaded clip");
                  setSpeech({ ...currentSpeech, phase: "paused" });
                  pausedByVoiceInput = "speech";
                } else {
                  created.play();
                }
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
                setSpeech({ ...currentSpeech, phase: "playing" });
              }
              if (started && !status.didJustFinish) {
                if (!status.playing && currentSpeech.phase === "playing") {
                  log("playlistStatusUpdate (server): remote paused");
                  setSpeech({ ...currentSpeech, phase: "paused" });
                } else if (
                  status.playing &&
                  (currentSpeech.phase === "paused" || currentSpeech.phase === "loading")
                ) {
                  setSpeech({ ...currentSpeech, phase: "playing" });
                }
              }
              // expo-audio reports didJustFinish only after the last queued track.
              if (status.didJustFinish) {
                if (allAdded) {
                  log("playlist: finished reply, queued blocks:", answerBlockQueue.length);
                  finishBlock();
                } else {
                  log("playlist: drained, waiting for the next clip");
                  drained = true;
                  setSpeech({ ...currentSpeech, phase: "loading" });
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
              queued: answerBlockQueue.length,
            });
            if (!isVoiceRecordingActive) created.play();
          }

          allAdded = true;
          if (drained) finishBlock();
        } catch (error) {
          if (!isLive()) return;
          log("playlist: failed", error);
          clearTimeout(startWatchdog);
          releasePlaylist();
          if (await speakWithNativeFallback(item, isCurrent)) return;
          announceExhausted(
            error instanceof Error && error.message.length > 0
              ? error.message
              : "The server did not answer. Check the connection and try again.",
          );
        }
      })();
    },
    [environmentId, httpBaseUrl, speakWithNativeFallback, ttsSynthesize],
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
      readonly turnParts?: ReadonlyArray<TurnPart>;
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
      } catch {}
    }
    if (T3NativeControls?.pauseWaitingAudio) {
      try {
        void T3NativeControls.pauseWaitingAudio();
      } catch {}
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
        } catch {}
      } else if (T3NativeControls?.resumeSpeaking) {
        try {
          void T3NativeControls.resumeSpeaking();
        } catch {}
      }
      setSpeech({ ...currentSpeech, phase: null });
      return;
    }
    if (T3NativeControls?.resumeSpeaking && currentSpeech.phase === "paused") {
      try {
        void T3NativeControls.resumeSpeaking();
      } catch {}
      setSpeech({ ...currentSpeech, phase: "playing" });
      return;
    }
  }, []);

  const seekBy = useCallback((deltaSeconds: number) => seekReadAloudBy(deltaSeconds), []);

  const stop = useCallback(() => {
    stopCurrent();
  }, []);

  /** The short update for `item`, or null to read the full reply. */
  const summarizeReply = useCallback(
    async (item: ReadItem, body: string, signal: AbortSignal): Promise<string | null> => {
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS),
      );
      const request = async (): Promise<string | null> => {
        if (deviceTtsConfig) return summarizeOnDevice(deviceTtsConfig, body, signal);
        const result = await ttsSummarize({
          environmentId: (item.environmentId ?? environmentId) as EnvironmentId,
          input: {
            text: body,
            ...(speechLanguageHint ? { languageHint: speechLanguageHint } : {}),
          },
        });
        return result._tag === "Success" ? result.value.text : null;
      };
      try {
        return await Promise.race([request(), timeout]);
      } catch (error) {
        log("summarizeReply failed, reading the full reply", error);
        return null;
      }
    },
    [deviceTtsConfig, environmentId, ttsSummarize],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this mount's synthesizers with the module-level answer queue
  useEffect(() => {
    const play = (item: ReadItem, isCurrent: () => boolean) => {
      if (deviceTtsConfig && !item.clipUri) {
        consumeDeviceStream(item, isCurrent);
      } else {
        playServerBlock(item, isCurrent);
      }
    };
    const start = (item: ReadItem, isCurrent: () => boolean) => {
      const summary = item.summary;
      if (!summary) {
        play(item, isCurrent);
        return;
      }
      const abort = new AbortController();
      activeStreamAbort = abort;
      void summarizeReply(item, summary.body, abort.signal).then((short) => {
        if (!isCurrent() || abort.signal.aborted) return;
        const next: ReadItem =
          short === null
            ? { ...item, summary: undefined }
            : { ...item, text: `${summary.prefix} ${short}`, summary: undefined };
        // Replaying this answer later reads the same update instead of summarizing again.
        if (currentAnswerBlock?.key === item.key) currentAnswerBlock = next;
        play(next, isCurrent);
      });
    };
    activeStartAnswerBlock = start;
    playThroughCurrentDeps = (item: ReadItem) => {
      const run = ++runCounter;
      start(item, () => run === runCounter);
    };
  }, [consumeDeviceStream, deviceTtsConfig, playServerBlock, summarizeReply]);

  return {
    speech,
    speak,
    pause,
    resume,
    seekBy,
    stop,
    enqueue,
    skipNext: skipToNextAnswer,
    stopAnswer: stopCurrentAnswer,
    skipPrevious: skipToPreviousAnswer,
  };
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
 * Queues replies of one thread that finish while its feed is mounted; history stays silent.
 * Switching threads never stops the audio that is already playing.
 */
export function useReadAloudAutoAnnounce(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly threadTitle?: string;
  readonly projectTitle?: string;
  readonly feed?: ReadonlyArray<unknown>;
  readonly turnParts?: ReadonlyMap<string, ReadonlyArray<TurnPart>>;
}) {
  const { environmentId, threadId, threadTitle, projectTitle, feed, turnParts } = input;
  const { enqueue } = useReadAloud(environmentId);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const autoRead =
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.readAloudAutoSpeak === true;

  const announcedIdsRef = useRef<Set<string>>(new Set());
  const seenStreamingIdsRef = useRef<Set<string>>(new Set());
  const threadOpenedAtRef = useRef(0);
  const initialLoadHandledRef = useRef(false);
  const lastThreadKeyRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the per-thread announce bookkeeping when the mounted thread changes
  useEffect(() => {
    if (lastThreadKeyRef.current === threadId) return;
    lastThreadKeyRef.current = threadId;
    threadOpenedAtRef.current = Date.now();
    initialLoadHandledRef.current = false;
    announcedIdsRef.current = new Set();
    seenStreamingIdsRef.current = new Set();
    // Do NOT stop() here. Existing audio sessions continue playing globally!
  }, [threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands newly finished replies to the module-level read-aloud queue
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

    // Only the newest reply is read; its turn parts carry the earlier messages
    // of its turn, and replies from earlier turns arriving in the same update
    // (reconnect, catch-up) would otherwise play first.
    const newest = newlyFinished.at(-1);
    if (newest !== undefined) {
      if (isAudioSessionActive || isReadAloudArmedOnNextReply(threadId)) {
        const armed = armedTargets.get(threadId);
        if (!isAudioSessionActive) {
          disarmReadAloudOnNextReply(threadId);
        }
        enqueue({
          key: newest.key,
          text: newest.text,
          turnParts: turnParts?.get(newest.key),
          threadId,
          environmentId,
          title: armed?.threadTitle ?? threadTitle,
          projectTitle: armed?.projectTitle ?? projectTitle,
        });
      } else if (autoRead) {
        enqueue({
          ...newest,
          turnParts: turnParts?.get(newest.key),
          threadId,
          environmentId,
          title: threadTitle,
          projectTitle,
        });
      }
    }
  }, [autoRead, environmentId, feed, enqueue, threadId, threadTitle, projectTitle, turnParts]);
}

/** Whether automatic replies of a thread are read as a short update, and the switch for it. */
export function useReadAloudSummaryToggle(
  environmentId: string | null | undefined,
  threadId: string | null | undefined,
) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const key = environmentId && threadId ? readAloudSummaryKey(environmentId, threadId) : null;
  const enabled =
    key !== null &&
    AsyncResult.isSuccess(preferencesResult) &&
    (preferencesResult.value.readAloudSummaryThreads ?? []).includes(key);
  const toggle = () => {
    if (key === null) return;
    updatePreferences({
      transform: (current) => {
        const keys = current.readAloudSummaryThreads ?? [];
        return {
          readAloudSummaryThreads: keys.includes(key)
            ? keys.filter((existing) => existing !== key)
            : [...keys, key],
        };
      },
    });
  };
  return { available: key !== null, enabled, toggle };
}
