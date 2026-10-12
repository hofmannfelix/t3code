import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlayer,
} from "expo-audio";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Alert } from "react-native";

import { usePreparedConnection } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export interface ReadAloudSpeech {
  readonly key: string | null;
  readonly phase: "loading" | "playing" | null;
  readonly source: "manual" | "auto" | null;
  readonly queued: number;
}

interface ReadItem {
  readonly key: string;
  readonly text: string;
  readonly source: "manual" | "auto";
}

interface QueueEntry extends ReadItem {
  readonly dedupeKey: string;
}

interface ThreadFeedMessageEntry {
  readonly type: "message";
  readonly message: {
    readonly id: string;
    readonly role: string;
    readonly streaming: boolean;
    readonly text: string;
  };
}

const IDLE: ReadAloudSpeech = { key: null, phase: null, source: null, queued: 0 };

const START_WATCHDOG_MS = 5_000;
/** A request that takes this long means the connection is down; fail visibly. */
const SYNTHESIZE_TIMEOUT_MS = 20_000;

type Listener = () => void;

const listeners = new Set<Listener>();

let currentSpeech: ReadAloudSpeech = IDLE;
let readQueue: Array<QueueEntry> = [];
let player: AudioPlayer | null = null;
let playerSubscription: { remove: () => void } | null = null;
let runCounter = 0;
let lastFailureAt = 0;
let enqueueCounter = 0;
let playThroughCurrentDeps: ((item: ReadItem) => void) | null = null;

const setSpeech = (next: ReadAloudSpeech) => {
  currentSpeech = next;
  for (const listener of listeners) listener();
};

const releasePlayer = () => {
  playerSubscription?.remove();
  playerSubscription = null;
  player?.release();
  player = null;
};

/** Stopping is a take-over: a pending auto-read queue dies with it. */
const stopCurrent = () => {
  runCounter += 1;
  readQueue = [];
  releasePlayer();
  setSpeech(IDLE);
};

const playNextFromQueue = () => {
  if (playThroughCurrentDeps === null) return;
  const next = readQueue.shift();
  setSpeech({ ...IDLE, queued: readQueue.length, phase: "loading", key: next?.key ?? null });
  if (next) playThroughCurrentDeps({ key: next.key, text: next.text, source: next.source });
};

const announceExhausted = (item: ReadItem, message: string) => {
  const now = Date.now();
  // A dropped queue already announced itself; a cascade would stack alerts.
  if (now - lastFailureAt >= 15_000) {
    lastFailureAt = now;
    Alert.alert("Read aloud unavailable", message);
  }
  if (item.source === "auto") readQueue = [];
  setSpeech({ ...IDLE, queued: 0 });
};

/**
 * Exponential lead: the first sentence plays in ~1-2s, then chunks of 2, 4
 * and 8 sentences, then the rest in one request. Every chunk covers more
 * playback time than its synthesis takes, so playback never waits, and a
 * long reply costs at most five provider calls.
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

/**
 * Read-aloud for the phone: the paired server synthesizes the reply with its
 * configured provider, the clip is fetched over the connection, and
 * expo-audio plays it. One voice at a time; auto-read replies queue up, a
 * manual read takes over and clears the queue, and failures surface through
 * an alert instead of failing silently.
 */
export function useReadAloud(environmentId: EnvironmentId) {
  const preparedConnection = usePreparedConnection(environmentId);
  const ttsSynthesize = useAtomCommand(serverEnvironment.ttsSynthesize, {
    label: "speak message",
    reportFailure: false,
  });

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

  const speak = useCallback((item: { readonly key: string; readonly text: string }) => {
    stopCurrent();
    const chunks = chunkReply(item.text);
    const lead = chunks[0];
    if (lead === undefined) return;
    setSpeech({
      key: item.key,
      phase: "loading",
      source: "manual",
      queued: readQueue.length,
    });
    for (let index = 1; index < chunks.length; index++) {
      const text = chunks[index];
      if (text === undefined) continue;
      readQueue.push({
        key: item.key,
        dedupeKey: `${item.key}#${index}`,
        text,
        source: "auto",
      });
    }
    if (currentSpeech.key === null) playNextFromQueue();
  }, []);

  const stop = useCallback(() => {
    stopCurrent();
  }, []);

  const enqueue = useCallback((item: { readonly key: string; readonly text: string }) => {
    enqueueCounter += 1;
    readQueue.push({
      key: item.key,
      dedupeKey: `${item.key}#${enqueueCounter}`,
      text: item.text,
      source: "auto",
    });
    if (currentSpeech.key === null) playNextFromQueue();
  }, []);

  // Fresh closure after every commit; the queue plays through it.
  useEffect(() => {
    playThroughCurrentDeps = (item: ReadItem) => {
      const run = ++runCounter;
      const isCurrent = () => run === runCounter;
      if (httpBaseUrl === null) {
        announceExhausted(item, "This environment is not connected right now.");
        return;
      }
      const startPlayback = async () => {
        // Voice input deactivates the audio session after recordings, and the
        // silent switch would mute us: read-aloud is explicitly requested, so
        // it overrides both (like a played video would).
        try {
          await setAudioModeAsync({
            allowsRecording: false,
            interruptionMode: "duckOthers",
            playsInSilentMode: true,
            shouldPlayInBackground: false,
          });
          await setIsAudioActiveAsync(true);
        } catch {
          // Still attempt playback; expo-audio often works regardless.
        }
        if (!isCurrent()) return;
        try {
          const result = await Promise.race([
            ttsSynthesize({
              environmentId,
              input: { text: item.text },
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("synthesize-timeout")), SYNTHESIZE_TIMEOUT_MS);
            }),
          ]);
          if (!isCurrent()) return;
          if (result._tag !== "Success") {
            announceExhausted(
              item,
              "The server could not synthesize this reply. Check the read-aloud settings on your Mac.",
            );
            return;
          }
          const clipUri = `${httpBaseUrl}${result.value.relativeUrl}`;
          const clipPlayer = createAudioPlayer({ uri: clipUri });
          player = clipPlayer;
          let started = false;
          // A start that never arrives is the only reliable failure signal on
          // device; the watchdog turns it into a visible message.
          const startWatchdog = setTimeout(() => {
            if (started || !isCurrent()) return;
            releasePlayer();
            announceExhausted(item, "The reply clip did not start playing.");
          }, START_WATCHDOG_MS);
          playerSubscription = clipPlayer.addListener("playbackStatusUpdate", (status) => {
            if (!isCurrent()) return;
            // Remote clips need preparation before play() takes effect.
            if (!started && status.isLoaded) clipPlayer.play();
            if (status.playing && !started) {
              started = true;
              clearTimeout(startWatchdog);
              setSpeech({
                key: item.key,
                phase: "playing",
                source: item.source,
                queued: readQueue.length,
              });
            }
            if (status.didJustFinish) {
              clearTimeout(startWatchdog);
              releasePlayer();
              if (item.source === "auto") playNextFromQueue();
              else setSpeech(IDLE);
            }
          });
          setSpeech({
            key: item.key,
            phase: "loading",
            source: item.source,
            queued: readQueue.length,
          });
          clipPlayer.play();
        } catch {
          if (!isCurrent()) return;
          announceExhausted(
            item,
            "flexbook did not answer. Check the connection (the thread header shows it) and try again.",
          );
        }
      };
      void startPlayback();
    };
  }, [environmentId, httpBaseUrl, ttsSynthesize]);

  return { speech, speak, stop, enqueue };
}

/**
 * Announces newly finished assistant replies of one thread to the shared
 * queue while auto-read is on. History stays silent: only replies that
 * complete while this feed is mounted are spoken, and switching threads
 * silences the old conversation's backlog.
 */
export function useReadAloudAutoAnnounce(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly feed?: ReadonlyArray<unknown>;
}) {
  const { environmentId, threadId, feed } = input;
  const { enqueue, stop } = useReadAloud(environmentId);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const autoRead =
    settings?.tts?.autoReadAloud ?? DEFAULT_SERVER_SETTINGS.tts.autoReadAloud ?? false;

  const announcedIdsRef = useRef<Set<string>>(new Set());
  const isFirstPassRef = useRef(true);
  const lastThreadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastThreadKeyRef.current === threadId) return;
    lastThreadKeyRef.current = threadId;
    announcedIdsRef.current = new Set();
    isFirstPassRef.current = true;
    stop();
  }, [threadId, stop]);

  useEffect(() => {
    if (!Array.isArray(feed)) return;
    const newlyFinished: Array<{ readonly key: string; readonly text: string }> = [];
    for (const entry of feed) {
      if (!isMessageEntry(entry)) continue;
      const message = entry.message;
      // Streaming rows are left unseen: their completion is the announcement.
      if (message.role !== "assistant" || message.streaming) continue;
      if (message.text.trim().length === 0) continue;
      if (announcedIdsRef.current.has(message.id)) continue;
      announcedIdsRef.current.add(message.id);
      if (!isFirstPassRef.current) newlyFinished.push({ key: message.id, text: message.text });
    }
    isFirstPassRef.current = false;
    if (autoRead) {
      for (const item of newlyFinished) enqueue(item);
    }
  }, [feed, autoRead, enqueue]);
}

function isMessageEntry(entry: unknown): entry is ThreadFeedMessageEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "message" &&
    typeof (entry as { message?: unknown }).message === "object"
  );
}
