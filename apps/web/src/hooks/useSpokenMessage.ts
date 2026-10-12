import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePreparedConnection } from "~/state/session";
import { toastManager } from "~/components/ui/toast";

export type SpeechMode = "cloud" | "browser";
export type SpeechSource = "manual" | "auto";

export type SpeechPhase = "loading" | "playing";

export interface SpeechState {
  /** Identity of the message currently spoken, `null` when idle. */
  readonly key: string | null;
  readonly phase: SpeechPhase | null;
  readonly mode: SpeechMode | null;
  readonly source: SpeechSource | null;
  /** Fraction of the clip played, cloud playback only. */
  readonly progress: number | null;
  /** Number of replies waiting in the auto-read queue. */
  readonly queued: number;
}

const IDLE: SpeechState = {
  key: null,
  phase: null,
  mode: null,
  source: null,
  progress: null,
  queued: 0,
};

type Listener = () => void;

interface ReadItem {
  readonly key: string;
  readonly text: string;
  readonly source: SpeechSource;
}

/** Set by the hook on every render; the module-level queue plays through it. */
let enqueueCounter = 0;
let playThroughCurrentDeps: ((item: ReadItem) => void) | null = null;

const listeners = new Set<Listener>();

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

let currentSpeech: SpeechState = IDLE;
let audio: HTMLAudioElement | null = null;
let readQueue: Array<{ key: string; dedupeKey: string; text: string; source: SpeechSource }> = [];
let runCounter = 0;
/** Unix ms of the last "nothing could play" toast; a failure cascade stays quiet. */
let lastFailureToastAt = 0;

const setSpeech = (next: SpeechState) => {
  currentSpeech = next;
  for (const listener of listeners) listener();
};

const canUseBrowserSpeech = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Stopping is a take-over: a pending auto-read queue dies with it. */
const stopCurrent = () => {
  runCounter += 1;
  readQueue = [];
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  }
  if (canUseBrowserSpeech()) {
    window.speechSynthesis.cancel();
  }
  setSpeech(IDLE);
};

const playNextFromQueue = () => {
  // The player registers after the first commit; queued items wait for it.
  if (playThroughCurrentDeps === null) return;
  const next = readQueue.shift();
  setSpeech({ ...IDLE, queued: readQueue.length, phase: "loading", key: next?.key ?? null });
  if (next) playThroughCurrentDeps?.({ key: next.key, text: next.text, source: next.source });
};

/**
 * One voice at a time across every message: speaking a new message stops the
 * previous one and drops the queue. Cloud synthesis uses the server's
 * configured provider and falls back to the platform's own voices when it is
 * not configured or fails. When even that fallback produces nothing (Electron's
 * speech synthesis can no-op silently), a toast says so instead of failing
 * quietly, and an auto-read queue is dropped rather than cascading failures.
 */
export function useSpokenMessage(environmentId: EnvironmentId) {
  const tts = useEnvironmentSettings(environmentId, (settings) => settings.tts);
  const preparedConnection = usePreparedConnection(environmentId);
  const ttsSynthesize = useAtomCommand(serverEnvironment.ttsSynthesize, {
    label: "speak message",
    reportFailure: false,
  });

  const speech = useSyncExternalStore(
    useCallback((listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []),
    () => currentSpeech,
    () => IDLE,
  );

  const speak = useCallback((input: { readonly key: string; readonly text: string }) => {
    stopCurrent();
    const chunks = chunkReply(input.text);
    const lead = chunks[0];
    if (lead === undefined) return;
    playThroughCurrentDeps?.({ key: input.key, text: lead, source: "manual" as const });
    // The rest of the reply queues up so playback never waits on synthesis.
    for (let index = 1; index < chunks.length; index++) {
      const text = chunks[index];
      if (text === undefined) continue;
      readQueue.push({
        key: input.key,
        dedupeKey: `${input.key}#${index}`,
        text,
        source: "auto" as const,
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
      source: "auto" as const,
    });
    if (currentSpeech.key === null) playNextFromQueue();
  }, []);

  // Fresh closure after every commit; calls only happen from user events or
  // effects that run after this one.
  const hasApiKey = tts.apiKey.length > 0;

  const notifyFailure = () => {
    // A dropped queue already announced itself; a rapid cascade would only stack toasts.
    const now = Date.now();
    if (now - lastFailureToastAt < 15_000) return;
    lastFailureToastAt = now;
    toastManager.add({
      type: "error",
      title: "Read aloud unavailable",
      description: hasApiKey
        ? "Cloud TTS failed and this app's built-in voices did not play. Check the provider settings under Integrations → Read aloud."
        : "This app's built-in voices did not play and no cloud TTS provider is configured. Set one under Integrations → Read aloud.",
    });
  };

  const announceExhausted = (item: ReadItem) => {
    notifyFailure();
    if (item.source === "auto") readQueue = [];
    setSpeech({ ...IDLE, queued: 0 });
  };

  useEffect(() => {
    playThroughCurrentDeps = (item: ReadItem) => {
      const run = ++runCounter;
      const isCurrent = () => run === runCounter;

      const speakWithBrowser = () => {
        if (!isCurrent()) return;
        if (!canUseBrowserSpeech()) {
          announceExhausted(item);
          return;
        }
        const utterance = new SpeechSynthesisUtterance(item.text);
        let started = false;
        // Electron's speech synthesis can no-op without firing end or error;
        // a start that never arrives is the only reliable failure signal.
        const startWatchdog = setTimeout(() => {
          if (started || !isCurrent()) return;
          window.speechSynthesis.cancel();
          announceExhausted(item);
        }, 2_000);
        utterance.addEventListener("start", () => {
          started = true;
          clearTimeout(startWatchdog);
          setSpeech({
            key: item.key,
            phase: "playing",
            mode: "browser",
            source: item.source,
            progress: null,
            queued: readQueue.length,
          });
        });
        utterance.addEventListener("end", () => {
          clearTimeout(startWatchdog);
          if (!isCurrent()) return;
          if (item.source === "auto") playNextFromQueue();
          else setSpeech(IDLE);
        });
        utterance.addEventListener("error", () => {
          clearTimeout(startWatchdog);
          if (!isCurrent()) return;
          announceExhausted(item);
        });
        setSpeech({
          key: item.key,
          phase: "loading",
          mode: "browser",
          source: item.source,
          progress: null,
          queued: readQueue.length,
        });
        window.speechSynthesis.speak(utterance);
      };

      const speakWithCloud = async () => {
        // The redaction marker and a real key are both non-empty; only an
        // empty field means no provider is configured.
        if (!hasApiKey) {
          speakWithBrowser();
          return;
        }
        const connection = preparedConnection._tag === "Some" ? preparedConnection.value : null;
        if (connection === null) {
          speakWithBrowser();
          return;
        }
        const result = await ttsSynthesize({ environmentId, input: { text: item.text } });
        if (!isCurrent() || result._tag !== "Success") {
          if (isCurrent()) speakWithBrowser();
          return;
        }
        const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
        if (url === null) {
          speakWithBrowser();
          return;
        }
        const clip = new Audio(url);
        const onClipError = () => {
          if (!isCurrent()) return;
          clip.removeEventListener("error", onClipError);
          speakWithBrowser();
        };
        clip.addEventListener("playing", () => {
          if (!isCurrent()) return;
          setSpeech({
            key: item.key,
            phase: "playing",
            mode: "cloud",
            source: item.source,
            progress: Math.min(1, clip.currentTime / clip.duration),
            queued: readQueue.length,
          });
        });
        clip.addEventListener("timeupdate", () => {
          if (isCurrent() && clip.duration > 0) {
            setSpeech({
              key: item.key,
              phase: "playing",
              mode: "cloud",
              source: item.source,
              progress: Math.min(1, clip.currentTime / clip.duration),
              queued: readQueue.length,
            });
          }
        });
        clip.addEventListener("ended", () => {
          if (!isCurrent()) return;
          if (item.source === "auto") playNextFromQueue();
          else setSpeech(IDLE);
        });
        clip.addEventListener("error", onClipError);
        audio = clip;
        setSpeech({
          key: item.key,
          phase: "loading",
          mode: "cloud",
          source: item.source,
          progress: 0,
          queued: readQueue.length,
        });
        void clip.play().catch(() => {
          if (isCurrent() && audio === clip) {
            audio = null;
            speakWithBrowser();
          }
        });
      };

      void speakWithCloud();
    };
  });

  return { speech, speak, stop, enqueue };
}
