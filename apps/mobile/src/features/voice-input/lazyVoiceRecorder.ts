import {
  throwIfVoiceTranscriptionAborted,
  type VoiceRecorder,
} from "@t3tools/client-runtime/voice-input";

type Subscription = { remove(): void };

export interface VoiceRecordingInput {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
}

export interface NativeVoiceRecorder<TStatus, TRecorderState> {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
  getStatus(): TRecorderState;
  addListener(
    eventName: "recordingStatusUpdate",
    listener: (status: TStatus) => void,
  ): Subscription;
  getAvailableInputs(): ReadonlyArray<VoiceRecordingInput>;
  setInput(uid: string): void | Promise<void>;
  getCurrentInput?(): Promise<VoiceRecordingInput>;
  cancelInputSelection?(): void;
  release(): void;
}

export interface LazyVoiceRecorder<TRecorderState> extends VoiceRecorder {
  getStatus(): TRecorderState | null;
  release(): void;
}

/** Construct lazily: cold startup blocks JS for tens of milliseconds and most composers never record. */
export function createLazyVoiceRecorder<TStatus, TRecorderState>(input: {
  readonly create: () => NativeVoiceRecorder<TStatus, TRecorderState>;
  readonly onStatus: (status: TStatus) => void;
  readonly selectInput?: (inputs: ReadonlyArray<VoiceRecordingInput>) => VoiceRecordingInput | null;
  /** The input the route actually uses once preparation settles, null when it cannot be read. */
  readonly onInputResolved?: (input: VoiceRecordingInput | null) => void;
}): LazyVoiceRecorder<TRecorderState> {
  let recorder: NativeVoiceRecorder<TStatus, TRecorderState> | null = null;
  let subscription: Subscription | null = null;
  let retired: NativeVoiceRecorder<TStatus, TRecorderState> | null = null;
  let retiredUri: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  let abandonInputSelection: (() => void) | null = null;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending = Promise.allSettled([pending, promise]).then(() => undefined);
    return promise;
  };

  return {
    get uri() {
      if (recorder) return recorder.uri;
      return retired ? retired.uri : retiredUri;
    },
    prepareToRecordAsync(signal) {
      if (!recorder) {
        recorder = input.create();
        subscription = recorder.addListener("recordingStatusUpdate", input.onStatus);
      }
      const prepared = recorder;
      // Reads the route after selection: iOS may refuse a preferred input, so report what it chose.
      const reportInput = () => {
        const report = input.onInputResolved;
        if (!report) return;
        const current = prepared.getCurrentInput?.();
        if (!current) return report(null);
        void current.then(report, () => report(null));
      };
      const selectInput = async () => {
        if (!input.selectInput) return;
        let selected: VoiceRecordingInput | null;
        try {
          selected = input.selectInput(prepared.getAvailableInputs());
        } catch {
          return;
        }
        if (!selected) return;
        const uid = selected.uid;
        // Expo never settles a canceled coroutine function's promise, so stop waiting on abort.
        const abandoned = Promise.withResolvers<void>();
        const abandon = () => {
          prepared.cancelInputSelection?.();
          abandoned.resolve();
        };
        signal?.addEventListener("abort", abandon, { once: true });
        abandonInputSelection = abandon;
        try {
          await Promise.race([
            new Promise<void>((resolve) => resolve(prepared.setInput(uid))).catch(() => {}),
            abandoned.promise,
          ]);
          if (signal) throwIfVoiceTranscriptionAborted(signal);
        } finally {
          signal?.removeEventListener("abort", abandon);
          if (abandonInputSelection === abandon) abandonInputSelection = null;
        }
      };
      return track(
        prepared.prepareToRecordAsync().then(async () => {
          if (signal) throwIfVoiceTranscriptionAborted(signal);
          await selectInput();
          reportInput();
        }),
      );
    },
    record(options) {
      if (!recorder) throw new Error("Voice recorder is not prepared.");
      recorder.record(options);
    },
    stop() {
      return recorder ? track(recorder.stop()) : Promise.resolve();
    },
    getStatus() {
      return recorder ? recorder.getStatus() : null;
    },
    release() {
      const released = recorder;
      if (!released) return;
      abandonInputSelection?.();
      recorder = null;
      subscription?.remove();
      subscription = null;
      retired = released;
      void pending.then(() => {
        if (retired === released) {
          retiredUri = released.uri;
          retired = null;
        }
        released.release();
      });
    },
  };
}
