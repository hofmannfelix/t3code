import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePreparedConnection } from "~/state/session";

export type SpeechMode = "cloud" | "browser";

export interface SpeechState {
  /** Identity of the message currently spoken, `null` when idle. */
  readonly key: string | null;
  readonly mode: SpeechMode | null;
  /** Fraction of the clip played, cloud playback only. */
  readonly progress: number | null;
}

const IDLE: SpeechState = { key: null, mode: null, progress: null };

type Listener = () => void;

const listeners = new Set<Listener>();

let currentSpeech: SpeechState = IDLE;
let audio: HTMLAudioElement | null = null;
let runCounter = 0;

const setSpeech = (next: SpeechState) => {
  currentSpeech = next;
  for (const listener of listeners) listener();
};

const stopCurrent = () => {
  runCounter += 1;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  setSpeech(IDLE);
};

/**
 * One voice at a time across every message: speaking a new message stops the
 * previous one. Cloud synthesis uses the server's configured provider and
 * falls back to the platform's own voices when it is not configured or fails.
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

  const stop = useCallback(() => {
    stopCurrent();
  }, []);

  const speak = useCallback(
    (input: { readonly key: string; readonly text: string }) => {
      const run = ++runCounter;
      stopCurrent();
      const isCurrent = () => run === runCounter;

      const speakWithBrowser = () => {
        if (!isCurrent() || typeof window === "undefined" || !("speechSynthesis" in window)) {
          return;
        }
        const utterance = new SpeechSynthesisUtterance(input.text);
        utterance.addEventListener("end", () => {
          if (isCurrent()) setSpeech(IDLE);
        });
        utterance.addEventListener("error", () => {
          if (isCurrent()) setSpeech(IDLE);
        });
        setSpeech({ key: input.key, mode: "browser", progress: null });
        window.speechSynthesis.speak(utterance);
      };

      const speakWithCloud = async () => {
        // The redaction marker and a real key are both non-empty; only an
        // empty field means no provider is configured.
        if (tts.apiKey.length === 0) {
          speakWithBrowser();
          return;
        }
        const connection = preparedConnection._tag === "Some" ? preparedConnection.value : null;
        if (connection === null) {
          speakWithBrowser();
          return;
        }
        const result = await ttsSynthesize({ environmentId, input: { text: input.text } });
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
        clip.addEventListener("timeupdate", () => {
          if (isCurrent() && clip.duration > 0) {
            setSpeech({
              key: input.key,
              mode: "cloud",
              progress: Math.min(1, clip.currentTime / clip.duration),
            });
          }
        });
        clip.addEventListener("ended", () => {
          if (isCurrent()) setSpeech(IDLE);
        });
        clip.addEventListener("error", onClipError);
        audio = clip;
        setSpeech({ key: input.key, mode: "cloud", progress: 0 });
        void clip.play().catch(() => {
          if (isCurrent() && audio === clip) {
            audio = null;
            speakWithBrowser();
          }
        });
      };

      void speakWithCloud();
    },
    [environmentId, preparedConnection, tts.apiKey.length, ttsSynthesize],
  );

  return { speech, speak, stop };
}
