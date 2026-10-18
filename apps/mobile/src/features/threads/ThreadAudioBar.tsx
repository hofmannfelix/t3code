import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import * as Option from "effect/Option";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { appNavigationRef } from "../../lib/appNavigation";
import { useThreadDetail } from "../../state/use-thread-detail";
import { cleanTextForSpeech } from "@t3tools/shared/textForSpeech";
import {
  useReadAloud,
  useArmedReadAloudTargets,
  disarmReadAloudOnNextReply,
  type ArmedReadAloudTarget,
} from "./useReadAloud";

const AUDIO_BAR_ENTERING = FadeInUp.duration(200).reduceMotion(ReduceMotion.System);
const AUDIO_BAR_EXITING = FadeOutUp.duration(160).reduceMotion(ReduceMotion.System);

export function ThreadAudioBar(props?: {
  readonly environmentId?: EnvironmentId;
  readonly top?: number;
}) {
  const insets = useSafeAreaInsets();
  const defaultTop = insets.top + (Platform.OS === "ios" ? 44 : 56) + 8;
  const top = props?.top ?? defaultTop;

  const { speech, pause, resume, seekBy, stop } = useReadAloud(props?.environmentId);
  const phase = speech.phase;

  // Render nothing when there is no active speech session.
  if (phase === null) {
    return null;
  }

  const isPlaying = phase === "playing";
  const isPaused = phase === "paused";
  const isLoading = phase === "loading";

  const handleTogglePlayPause = () => {
    if (isPlaying) {
      pause();
    } else if (isPaused) {
      resume();
    }
  };

  const handleNavigateToThread = () => {
    if (speech.environmentId && speech.threadId && appNavigationRef.isReady()) {
      appNavigationRef.navigate("Thread", {
        environmentId: speech.environmentId,
        threadId: speech.threadId,
      });
    }
  };

  const statusLabel = isLoading ? "Laden..." : isPaused ? "Pausiert" : "Vorlesen";
  const canNavigate = Boolean(speech.environmentId && speech.threadId);

  return (
    <Animated.View
      entering={AUDIO_BAR_ENTERING}
      exiting={AUDIO_BAR_EXITING}
      pointerEvents="box-none"
      className="absolute left-3 right-3 z-50 items-center"
      style={{ top }}
    >
      <View className="w-full max-w-md flex-row items-center justify-between rounded-full border border-black/10 bg-white/98 px-3.5 py-1.5 shadow-xl shadow-black/25 backdrop-blur-xl dark:border-white/20 dark:bg-zinc-800/98 dark:shadow-black/70">
        {/* Left status / speaker indicator (tappable to jump to thread) */}
        <Pressable
          disabled={!canNavigate}
          onPress={handleNavigateToThread}
          accessibilityRole={canNavigate ? "button" : undefined}
          accessibilityLabel={canNavigate ? "Zur aktiven Konversation wechseln" : undefined}
          className="flex-1 flex-row items-center gap-2 pl-1 pr-2 active:opacity-70"
        >
          <View className="size-6 items-center justify-center rounded-full bg-primary/15">
            <SymbolView
              name="speaker.wave.2"
              size={13}
              tintColorClassName="accent-primary"
              type="monochrome"
            />
          </View>
          <Text className="text-xs font-t3-bold text-foreground" numberOfLines={1}>
            {statusLabel}
            {speech.projectTitle ? ` • ${speech.projectTitle}` : ""}
            {speech.title ? ` • ${speech.title}` : ""}
          </Text>
        </Pressable>

        {/* Right audio controls */}
        <View className="flex-row items-center gap-1.5">
          {/* -10 seconds */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="-10 Sekunden"
            hitSlop={6}
            onPress={() => seekBy(-10)}
            className="size-8 items-center justify-center rounded-full active:bg-foreground/10"
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
            accessibilityLabel={isPlaying ? "Pause" : "Abspielen"}
            hitSlop={6}
            disabled={isLoading}
            onPress={handleTogglePlayPause}
            className="size-8 items-center justify-center rounded-full bg-primary active:opacity-75"
          >
            {isLoading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : isPlaying ? (
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
            hitSlop={6}
            onPress={() => seekBy(10)}
            className="size-8 items-center justify-center rounded-full active:bg-foreground/10"
          >
            <SymbolView
              name="goforward.10"
              size={17}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>

          {/* Stop button: terminates session completely and hides bar */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Audio beenden"
            hitSlop={6}
            onPress={stop}
            className="ml-1 size-8 items-center justify-center rounded-full bg-danger active:opacity-80"
          >
            <SymbolView
              name="stop.fill"
              size={12}
              tintColorClassName="accent-danger-foreground"
              type="monochrome"
            />
          </Pressable>
        </View>
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
  const { speak } = useReadAloud(target.environmentId);
  const threadDetailState = useThreadDetail({
    environmentId: target.environmentId,
    threadId: target.threadId as ThreadId,
  });

  const lastSeenSpokenMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    const projection = Option.getOrNull(threadDetailState.data);
    if (!projection?.messages) return;

    const messages = projection.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg = messages[index];
      if (msg && msg.role === "assistant") {
        if (!msg.streaming && msg.text && msg.text.trim().length > 0) {
          if (lastSeenSpokenMessageIdRef.current !== msg.id) {
            lastSeenSpokenMessageIdRef.current = msg.id;
            disarmReadAloudOnNextReply(target.threadId);
            void speak({
              key: msg.id,
              text: cleanTextForSpeech(msg.text),
              threadId: target.threadId,
              environmentId: target.environmentId ?? undefined,
              title: target.threadTitle ?? "Antwort",
            });
          }
          break;
        }
      }
    }
  }, [threadDetailState, target, speak]);

  return null;
}

function GlobalAudioWatchers() {
  const armedTargets = useArmedReadAloudTargets();

  return (
    <>
      {armedTargets.map((target) => (
        <ArmedThreadAudioWatcher key={target.threadId} target={target} />
      ))}
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
  const visible = speech.phase !== null;
  const bar = visible ? <ThreadAudioBar /> : null;

  return (
    <>
      <GlobalAudioWatchers />
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
