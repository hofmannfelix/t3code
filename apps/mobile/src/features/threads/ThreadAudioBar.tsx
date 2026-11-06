import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOut,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import * as Option from "effect/Option";

import { SymbolView } from "../../components/ui/AppSymbol";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { startOpeningDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
} from "../workspace/workspace-detail-selection";
import { gatherMessageTurnParts } from "../../lib/threadActivity";
import { useEnvironmentThread } from "../../state/threads";
import { cleanTextForSpeech } from "@t3tools/shared/textForSpeech";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { collectCompletedReplies, findRunReply, type CompletedReply } from "./readAloudCompletions";
import {
  refreshAudioLiveActivity,
  useReadAloud,
  useArmedReadAloudTargets,
  useThreadAudioMode,
  useIsAudioSessionActive,
  useReadAloudProgress,
  useReadAloudSummaryToggle,
  getActiveAudioSessionTarget,
  disarmReadAloudOnNextReply,
  startGlobalAudioSession,
  stopGlobalAudioSession,
  type ArmedReadAloudTarget,
} from "./useReadAloud";

/** The bar floats over the thread list and threads only; elsewhere (Settings, sheets) it covers content. */
const AUDIO_BAR_ROUTES: ReadonlySet<string> = new Set(["Home", "Thread"]);
let audioBarRouteAllowed = true;
const audioBarRouteListeners = new Set<() => void>();

/** Called with the focused root route whenever navigation state changes. */
export function setAudioBarRoute(routeName: string | undefined): void {
  const allowed = routeName === undefined || AUDIO_BAR_ROUTES.has(routeName);
  if (allowed === audioBarRouteAllowed) return;
  audioBarRouteAllowed = allowed;
  for (const listener of audioBarRouteListeners) listener();
}

const subscribeAudioBarRoute = (listener: () => void) => {
  audioBarRouteListeners.add(listener);
  return () => {
    audioBarRouteListeners.delete(listener);
  };
};

const AUDIO_BAR_ENTERING = FadeInUp.duration(200).reduceMotion(ReduceMotion.System);
const AUDIO_BAR_EXITING = FadeOutUp.duration(160).reduceMotion(ReduceMotion.System);
const BUTTON_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const BUTTON_EXITING = FadeOut.duration(140).reduceMotion(ReduceMotion.System);
const AUDIO_LAYOUT_TRANSITION = LinearTransition.duration(200).reduceMotion(ReduceMotion.System);

const formatClock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * Elapsed and total time of the reply being read. Subscribes on its own so the
 * once-per-second updates re-render only this label and the line under it.
 */
function ReadAloudProgressLabel() {
  const progress = useReadAloudProgress();
  if (progress === null || progress.duration <= 0) return null;
  const total = `${progress.exact ? "" : "~"}${formatClock(progress.duration)}`;
  return (
    <Text className="text-xs font-t3-medium text-foreground-muted tabular-nums" numberOfLines={1}>
      {formatClock(progress.position)} / {total}
    </Text>
  );
}

function ReadAloudProgressLine() {
  const progress = useReadAloudProgress();
  if (progress === null || progress.duration <= 0) return null;
  const fraction = Math.min(1, progress.position / progress.duration);
  return (
    <View
      pointerEvents="none"
      className="absolute bottom-0.5 left-5 right-5 h-0.5 rounded-full bg-foreground/10"
    >
      <View className="h-full rounded-full bg-primary" style={{ width: `${fraction * 100}%` }} />
    </View>
  );
}

/**
 * The inactive speaker toggle below a thread's navigation bar. The active bar is
 * GlobalAudioPlayerControl, so it survives navigation.
 */
export function ThreadAudioFloatingControl(props: {
  readonly environmentId?: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle?: string;
  readonly projectTitle?: string;
  readonly top?: number;
}) {
  const insets = useSafeAreaInsets();
  const defaultTop = insets.top + (Platform.OS === "ios" ? 44 : 56) + 8;
  const top = props.top ?? defaultTop;

  const threadIdStr = String(props.threadId);

  const { isActive, toggleAudioMode } = useThreadAudioMode(threadIdStr, {
    environmentId: props.environmentId,
    threadTitle: props.threadTitle,
    projectTitle: props.projectTitle,
  });

  if (isActive) {
    return null;
  }

  return (
    <Animated.View
      key="collapsed-audio-btn"
      entering={BUTTON_ENTERING}
      exiting={BUTTON_EXITING}
      layout={AUDIO_LAYOUT_TRANSITION}
      pointerEvents="box-none"
      className="absolute right-3.5 z-40 items-center justify-center"
      style={{ top }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Audio vorlesen aktivieren"
        hitSlop={8}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          toggleAudioMode(true);
        }}
        className="size-9 items-center justify-center rounded-full border border-border bg-card shadow-md shadow-black/15 active:scale-95 active:opacity-75"
      >
        <SymbolView
          name="speaker.wave.2"
          size={16}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
          style={{ opacity: 0.5 }}
        />
      </Pressable>
    </Animated.View>
  );
}

/**
 * Global ThreadAudioBar used when audio playback or an active audio session exists.
 * Floats persistently across all screens (Thread Detail, Thread List, Settings).
 */
export function ThreadAudioBar(props?: {
  readonly environmentId?: EnvironmentId;
  readonly top?: number;
}) {
  const insets = useSafeAreaInsets();
  const defaultTop = insets.top + (Platform.OS === "ios" ? 44 : 56) + 8;
  const top = props?.top ?? defaultTop;

  const { speech, pause, resume, seekBy, stop, stopAnswer, skipNext, skipPrevious } = useReadAloud(
    props?.environmentId,
  );
  const isSessionActive = useIsAudioSessionActive();
  const phase = speech.phase;
  const activeTarget = getActiveAudioSessionTarget();
  const targetEnvId = speech.environmentId ?? activeTarget?.environmentId;
  const targetThreadId = speech.threadId ?? activeTarget?.threadId;
  const summaryToggle = useReadAloudSummaryToggle(targetEnvId, targetThreadId);

  // Render nothing when no session is active and no speech is playing
  if (phase === null && !isSessionActive) {
    return null;
  }

  const isPlaying = phase === "playing";
  const isPaused = phase === "paused";
  const isLoading = phase === "loading";
  const hasAnswer = isPlaying || isPaused || isLoading;
  const isWaitingWithMusic = isSessionActive && !isPaused && !isPlaying && !isLoading;

  const handleTogglePlayPause = () => {
    if (isPlaying || isWaitingWithMusic) {
      pause();
    } else if (isPaused) {
      resume();
    }
  };

  const handleStopAndClose = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    stop();
    stopGlobalAudioSession();
  };

  // Always show project title, NEVER the thread title:
  const targetProjectTitle = speech.projectTitle ?? activeTarget?.projectTitle ?? "T3 Code";

  const handleNavigateToThread = () => {
    // The bar renders above the navigator, so navigation hooks are unavailable here.
    if (!targetEnvId || !targetThreadId || !rootNavigationRef.isReady()) return;
    const detail: WorkspaceDetail = {
      name: "Thread",
      params: { environmentId: String(targetEnvId), threadId: String(targetThreadId) },
    };
    startOpeningDetail(detail);
    rootNavigationRef.dispatch(selectWorkspaceDetail(detail));
  };

  const canNavigate = Boolean(targetEnvId && targetThreadId);

  // The play button already shows loading, playing and paused; the label only says whose audio it is.
  const queueSuffix = speech.queued > 0 ? ` (+${speech.queued})` : "";
  const barText = `${targetProjectTitle}${queueSuffix}`;

  return (
    <Animated.View
      entering={AUDIO_BAR_ENTERING}
      exiting={AUDIO_BAR_EXITING}
      pointerEvents="box-none"
      className="absolute left-3 right-3 z-50 items-center"
      style={{ top }}
    >
      <View className="w-full max-w-md gap-1.5 rounded-3xl border border-border bg-card px-3 pb-2.5 pt-2 shadow-xl shadow-black/25">
        {/* Project and time on top, controls below: one row is too narrow on small phones. */}
        <Pressable
          disabled={!canNavigate}
          onPress={handleNavigateToThread}
          accessibilityRole={canNavigate ? "button" : undefined}
          accessibilityLabel={canNavigate ? "Zur aktiven Konversation wechseln" : undefined}
          className="flex-row items-center gap-2 px-1 active:opacity-70"
        >
          <View className="size-6 items-center justify-center rounded-full bg-primary/15">
            <SymbolView
              name="speaker.wave.2"
              size={13}
              tintColorClassName="accent-primary"
              type="monochrome"
            />
          </View>
          <Text className="min-w-0 flex-1 text-xs font-t3-bold text-foreground" numberOfLines={1}>
            {barText}
          </Text>
          {isPlaying || isPaused ? <ReadAloudProgressLabel /> : null}
        </Pressable>

        <View className="flex-row items-center justify-between">
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: summaryToggle.enabled }}
            accessibilityLabel={
              summaryToggle.allThreads
                ? "Kurze Updates für alle Threads"
                : "Kurze Updates für diesen Thread"
            }
            accessibilityHint={
              summaryToggle.allThreads
                ? "Liest neue Antworten aller Threads ohne eigene Wahl als kurze Zusammenfassung vor"
                : "Liest neue Antworten dieses Threads als kurze Zusammenfassung vor"
            }
            hitSlop={6}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              summaryToggle.toggle();
            }}
            className={
              summaryToggle.enabled
                ? "h-7 items-center justify-center rounded-full bg-primary px-2.5 active:opacity-75"
                : "h-7 items-center justify-center rounded-full bg-foreground/10 px-2.5 active:opacity-75"
            }
          >
            <Text
              className={
                summaryToggle.enabled
                  ? "text-xs font-t3-bold text-primary-foreground"
                  : "text-xs font-t3-bold text-foreground-muted"
              }
            >
              Kurz
            </Text>
          </Pressable>
          {/* -10 seconds */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="-10 Sekunden"
            accessibilityHint="Lange drücken für den Anfang oder die vorherige Antwort"
            hitSlop={6}
            onPress={() => {
              if (!isLoading) seekBy(-10);
            }}
            onLongPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              skipPrevious();
            }}
            className="size-9 items-center justify-center rounded-full active:bg-foreground/10"
          >
            <SymbolView
              name="gobackward.10"
              size={17}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>

          {/* Play / Pause toggle */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPlaying || isWaitingWithMusic ? "Pause" : "Abspielen"}
            hitSlop={6}
            disabled={isLoading}
            onPress={handleTogglePlayPause}
            className="size-9 items-center justify-center rounded-full bg-primary active:opacity-75"
          >
            {isLoading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : isPlaying || isWaitingWithMusic ? (
              <SymbolView
                name="pause.fill"
                size={13}
                tintColorClassName="accent-primary-foreground"
                type="monochrome"
              />
            ) : (
              <SymbolView
                name="play.fill"
                size={13}
                tintColorClassName="accent-primary-foreground"
                type="monochrome"
              />
            )}
          </Pressable>

          {/* +10 seconds */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="+10 Sekunden"
            accessibilityHint="Lange drücken für die nächste Antwort"
            hitSlop={6}
            onPress={() => {
              if (!isLoading) seekBy(10);
            }}
            onLongPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              skipNext();
            }}
            className="size-9 items-center justify-center rounded-full active:bg-foreground/10"
          >
            <SymbolView
              name="goforward.10"
              size={17}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>

          {/* Stop this answer but keep the session: the next reply plays as it arrives. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Antwort stoppen"
            accessibilityHint="Beendet diese Antwort und wartet auf die nächste"
            hitSlop={6}
            disabled={!hasAnswer}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              stopAnswer();
            }}
            className={
              hasAnswer
                ? "size-9 items-center justify-center rounded-full active:bg-foreground/10"
                : "size-9 items-center justify-center rounded-full opacity-40"
            }
          >
            <SymbolView
              name="stop.fill"
              size={13}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>

          {/* Close / Deactivate button (X) */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Audio deaktivieren"
            hitSlop={6}
            onPress={handleStopAndClose}
            className="size-9 items-center justify-center rounded-full bg-foreground/10 active:opacity-75"
          >
            <SymbolView
              name="xmark"
              size={13}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
        </View>
        {isPlaying || isPaused || isLoading ? <ReadAloudProgressLine /> : null}
      </View>
    </Animated.View>
  );
}

/**
 * Watches an armed thread that is awaiting an assistant reply.
 * Because this is mounted in the global coordinator, it keeps the Effect atom
 * for the thread mounted, maintaining the live SSE connection even when the
 * user navigates away from the thread detail screen or locks the device.
 */
function ArmedThreadAudioWatcher(props: { readonly target: ArmedReadAloudTarget }) {
  const { target } = props;
  const { enqueue } = useReadAloud(target.environmentId);
  const isAudioSessionActive = useIsAudioSessionActive();
  const targetSpec = useMemo(
    () => ({
      environmentId: target.environmentId ?? null,
      threadId: target.threadId as ThreadId,
    }),
    [target.environmentId, target.threadId],
  );
  const threadDetailState = useEnvironmentThread(targetSpec.environmentId, targetSpec.threadId);

  const seenStreamingIdsRef = useRef<Set<string>>(new Set());
  const initialLoadHandledRef = useRef<boolean>(false);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds finished replies of this armed thread into the module-level read-aloud queue
  useEffect(() => {
    const projection = Option.getOrNull(threadDetailState.data);
    const messages = projection?.messages;
    if (!messages) return;

    if (!initialLoadHandledRef.current) {
      initialLoadHandledRef.current = true;
      // Mark all pre-existing completed assistant messages as already handled
      // so activating the audio session NEVER triggers reading old messages!
      for (const msg of messages) {
        if (msg && msg.role === "assistant") {
          if (msg.streaming) {
            seenStreamingIdsRef.current.add(msg.id);
          } else {
            spokenMessageIdsRef.current.add(msg.id);
          }
        }
      }
      return;
    }

    // Only the newest finished reply can be spoken; its turn parts carry the
    // earlier messages of the same turn. Older messages that show up later
    // (reconnect, history) are history and only get recorded.
    let newest: (typeof messages)[number] | null = null;
    for (const msg of messages) {
      if (!msg || msg.role !== "assistant") continue;
      if (msg.streaming) {
        seenStreamingIdsRef.current.add(msg.id);
        continue;
      }
      if (!msg.text || msg.text.trim().length === 0) continue;
      newest = msg;
    }
    for (const msg of messages) {
      if (msg && msg !== newest && msg.role === "assistant" && !msg.streaming) {
        spokenMessageIdsRef.current.add(msg.id);
      }
    }
    if (newest === null || spokenMessageIdsRef.current.has(newest.id)) return;
    spokenMessageIdsRef.current.add(newest.id);

    const msgTimestamp = newest.createdAt ? Date.parse(String(newest.createdAt)) : NaN;
    const isAfterArmed =
      Number.isFinite(msgTimestamp) &&
      target.armedAt !== undefined &&
      msgTimestamp >= target.armedAt - 30_000;
    const wasSeenStreaming = seenStreamingIdsRef.current.has(newest.id);
    if (!wasSeenStreaming && !isAfterArmed && !isAudioSessionActive) return;

    seenStreamingIdsRef.current.delete(newest.id);
    if (!isAudioSessionActive) {
      disarmReadAloudOnNextReply(target.threadId);
    }
    void enqueue({
      key: newest.id,
      text: cleanTextForSpeech(newest.text),
      turnParts: gatherMessageTurnParts(messages).get(newest.id),
      threadId: target.threadId,
      environmentId: target.environmentId ?? undefined,
      title: "Antwort",
      projectTitle: target.projectTitle,
    });
  }, [threadDetailState, target, enqueue, isAudioSessionActive]);

  return null;
}

/**
 * Loads one completed reply's thread once, enqueues the reply and unmounts, so
 * replies from threads nobody armed are still read without keeping every
 * thread's detail stream open.
 */
function CompletedReplyAnnouncer(props: {
  readonly reply: CompletedReply;
  readonly onDone: (runId: string) => void;
}) {
  const { reply, onDone } = props;
  const { enqueue } = useReadAloud(reply.environmentId);
  const project = useAtomValue(
    environmentProjects.projectAtom({
      environmentId: reply.environmentId,
      projectId: reply.projectId,
    }),
  );
  const targetSpec = useMemo(
    () => ({ environmentId: reply.environmentId, threadId: reply.threadId }),
    [reply.environmentId, reply.threadId],
  );
  const threadDetailState = useEnvironmentThread(targetSpec.environmentId, targetSpec.threadId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands one completed reply to the module-level read-aloud queue once its text has loaded
  useEffect(() => {
    if (threadDetailState.status === "deleted") {
      onDone(reply.runId);
      return;
    }
    const messages = Option.getOrNull(threadDetailState.data)?.messages;
    if (!messages) return;
    const message = findRunReply(messages, reply.runStartedAt);
    // Cached detail can predate the run; only a live snapshot proves there is no reply.
    if (message === null && threadDetailState.status !== "live") return;
    if (message !== null) {
      enqueue({
        key: message.id,
        text: cleanTextForSpeech(message.text),
        turnParts: gatherMessageTurnParts(messages).get(message.id),
        threadId: String(reply.threadId),
        environmentId: reply.environmentId,
        title: reply.threadTitle,
        projectTitle: project?.title,
      });
    }
    onDone(reply.runId);
  }, [threadDetailState, reply, enqueue, onDone, project?.title]);

  return null;
}

/**
 * While audio is on, a thread finishing a run anywhere is read aloud. The
 * thread list already carries each thread's latest run, so only the threads
 * that just completed get their detail loaded.
 */
function CompletedReplyWatcher() {
  const shells = useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
  const armedTargets = useArmedReadAloudTargets();
  const seenRunsRef = useRef(new Map<string, string | null>());
  const [pending, setPending] = useState<ReadonlyArray<CompletedReply>>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- diffs live thread shells against the runs already seen to find replies for the read-aloud queue
  useEffect(() => {
    const completed = collectCompletedReplies(seenRunsRef.current, shells);
    // Armed threads keep their own live watcher.
    const armedIds = new Set(armedTargets.map((target) => target.threadId));
    const next = completed.filter((reply) => !armedIds.has(String(reply.threadId)));
    if (next.length > 0) setPending((current) => [...current, ...next]);
  }, [shells, armedTargets]);

  const handleDone = useMemo(
    () => (runId: string) =>
      setPending((current) => current.filter((reply) => reply.runId !== runId)),
    [],
  );

  return (
    <>
      {pending.map((reply) => (
        <CompletedReplyAnnouncer key={reply.runId} reply={reply} onDone={handleDone} />
      ))}
    </>
  );
}

/** Keeps the Live Activity's thread rows in step with the thread list while audio is on. */
function AudioLiveActivityRefresher() {
  const shells = useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the thread rows into the native Live Activity whenever the shells change
  useEffect(() => {
    refreshAudioLiveActivity(shells);
  }, [shells]);
  return null;
}

function GlobalAudioWatchers() {
  const armedTargets = useArmedReadAloudTargets();
  const isSessionActive = useIsAudioSessionActive();

  return (
    <>
      {armedTargets.map((target) => (
        <ArmedThreadAudioWatcher key={target.threadId} target={target} />
      ))}
      {isSessionActive ? <CompletedReplyWatcher /> : null}
    </>
  );
}

/**
 * Global audio player host mounted once at the app root level.
 * Floats the player bar across all screens (Home, Threads, Settings, Modals)
 * without ever unmounting or stopping playback on navigation.
 * Also keeps armed background threads synchronized via GlobalAudioWatchers.
 */
export function GlobalAudioPlayerControl(props: { readonly children: ReactNode }) {
  const { speech } = useReadAloud();
  const isSessionActive = useIsAudioSessionActive();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;
  const sessionRestoredRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the persisted native audio session once preferences have loaded
  useEffect(() => {
    if (sessionRestoredRef.current || !preferences) return;
    sessionRestoredRef.current = true;
    if (preferences.audioSessionActive && !isSessionActive) {
      void startGlobalAudioSession(
        preferences.audioSessionTarget
          ? {
              environmentId:
                (preferences.audioSessionTarget.environmentId as EnvironmentId) ?? undefined,
              threadId: preferences.audioSessionTarget.threadId ?? undefined,
              threadTitle: preferences.audioSessionTarget.threadTitle ?? undefined,
              projectTitle: preferences.audioSessionTarget.projectTitle ?? undefined,
            }
          : undefined,
      );
    }
  }, [preferences, isSessionActive]);

  const routeAllowed = useSyncExternalStore(
    subscribeAudioBarRoute,
    () => audioBarRouteAllowed,
    () => true,
  );
  const visible = isSessionActive || speech.phase !== null;
  const bar = visible && routeAllowed ? <ThreadAudioBar /> : null;

  return (
    <>
      <GlobalAudioWatchers />
      {visible ? <AudioLiveActivityRefresher /> : null}
      <View pointerEvents="box-none" className="flex-1">
        {props.children}
      </View>
      {bar && Platform.OS === "ios" ? (
        <FullWindowOverlay>
          <View pointerEvents="box-none" className="absolute inset-0">
            {bar}
          </View>
        </FullWindowOverlay>
      ) : bar ? (
        <View pointerEvents="box-none" className="absolute inset-0 z-50">
          {bar}
        </View>
      ) : null}
    </>
  );
}
