// @vitest-environment jsdom
import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ClipStatus = {
  readonly isLoaded?: boolean;
  readonly playing?: boolean;
  readonly didJustFinish?: boolean;
  readonly currentTime?: number;
};

const harness = vi.hoisted(() => {
  const playlists: Array<{
    readonly sources: Array<{ uri: string }>;
    readonly uri: string;
    currentTime: number;
    readonly play: ReturnType<typeof vi.fn>;
    readonly pause: ReturnType<typeof vi.fn>;
    readonly seekTo: ReturnType<typeof vi.fn>;
    readonly clear: ReturnType<typeof vi.fn>;
    readonly release: ReturnType<typeof vi.fn>;
    readonly add: ReturnType<typeof vi.fn>;
    emit: (status: ClipStatus) => void;
  }> = [];
  const alerts: Array<{ readonly title: string; readonly message: string }> = [];
  const behavior = { synthesis: "resolve" as "resolve" | "hang" };
  const device = {
    config: null as null | {
      readonly apiKey: string;
      readonly model: string;
      readonly voice: string;
    },
    segments: [] as Array<string>,
    streamCalls: 0,
  };
  const downloads: Array<{ readonly url: string; readonly uri: string }> = [];
  const settingsAtom = { _tag: "settingsAtom" };
  let autoReadAloud = true;

  const createAudioPlaylist = vi.fn((config: { sources: Array<{ uri: string }> }) => {
    const listeners = new Set<(status: ClipStatus) => void>();
    const pl = {
      sources: [...config.sources],
      currentTime: 0,
      get uri() {
        return pl.sources[0]?.uri ?? "";
      },
      add: vi.fn((source: { uri: string }) => {
        pl.sources.push(source);
      }),
      play: vi.fn(),
      pause: vi.fn(),
      seekTo: vi.fn(async (seconds: number) => {
        pl.currentTime = seconds;
      }),
      clear: vi.fn(() => {
        pl.sources.length = 0;
      }),
      release: vi.fn(),
      addListener: vi.fn((_event: string, listener: (status: ClipStatus) => void) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      }),
      emit: (status: ClipStatus) => {
        if (typeof status.currentTime === "number") pl.currentTime = status.currentTime;
        for (const listener of listeners) listener(status);
      },
    };
    playlists.push(pl);
    return pl;
  });

  const ttsSynthesize = vi.fn((_input: { environmentId: string; input: { text: string } }) => {
    if (behavior.synthesis === "hang") return new Promise(() => {});
    return Promise.resolve({
      _tag: "Success",
      value: { relativeUrl: "/api/tts-audio/token-1", expiresAt: 0 },
    });
  });
  const setAudioModeAsync = vi.fn(async () => undefined);
  const setIsAudioActiveAsync = vi.fn(async () => undefined);
  const downloadFileAsync = vi.fn(async (url: string) => {
    const uri = `file:///cache/download-${downloads.length + 1}.wav`;
    downloads.push({ url, uri });
    return { uri };
  });

  return {
    players: playlists,
    playlists,
    alerts,
    behavior,
    device,
    downloads,
    createAudioPlayer: createAudioPlaylist,
    createAudioPlaylist,
    ttsSynthesize,
    setAudioModeAsync,
    setIsAudioActiveAsync,
    downloadFileAsync,
    settingsAtom,
    get autoReadAloud() {
      return autoReadAloud;
    },
    set autoReadAloud(val: boolean) {
      autoReadAloud = val;
    },
  };
});

vi.mock("expo-audio", () => ({
  createAudioPlayer: harness.createAudioPlaylist,
  createAudioPlaylist: harness.createAudioPlaylist,
  setAudioModeAsync: harness.setAudioModeAsync,
  setIsAudioActiveAsync: harness.setIsAudioActiveAsync,
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => null,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Alert: {
    alert: (title: string, message?: string) =>
      harness.alerts.push({ title, message: message ?? "" }),
  },
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => ({
    _tag: "Some",
    value: { httpBaseUrl: "http://server.test:8923/" },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    ttsSynthesize: harness.ttsSynthesize,
    settingsValueAtom: () => harness.settingsAtom,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: (input: unknown) => unknown) => command,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    if (atom === harness.settingsAtom) {
      return { tts: { autoReadAloud: harness.autoReadAloud } };
    }
    return { _tag: "Success", value: { readAloudAutoSpeak: harness.autoReadAloud } };
  },
}));
vi.mock("expo-file-system", () => ({
  File: Object.assign(
    class {
      uri: string;
      constructor(uri: string) {
        this.uri = uri;
      }
      delete() {}
    },
    {
      downloadFileAsync: harness.downloadFileAsync,
    },
  ),
  Directory: class {
    uri: string;
    constructor(source: unknown) {
      this.uri = (source as { uri?: string })?.uri ?? "";
    }
  },
  Paths: { cache: "file:///cache" },
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
}));
vi.mock("./deviceTts", () => ({
  getDeviceTtsConfig: () => harness.device.config,
  streamWavSegments: vi.fn(async function* () {
    harness.device.streamCalls += 1;
    for (const uri of harness.device.segments) {
      yield uri;
      await Promise.resolve();
    }
  }),
}));

import {
  armReadAloudOnNextReply,
  disarmReadAloudOnNextReply,
  getArmedReadAloudTargets,
  isReadAloudArmedOnNextReply,
  SYNTHESIZE_TIMEOUT_MS,
  useReadAloud,
  useReadAloudAutoAnnounce,
} from "./useReadAloud";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// Module-level singleton state (queue, player, failure cooldown) is shared
// across tests on purpose: each test leaves the queue drained and idle.
let roots: Array<Root> = [];

function renderReadAloud() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  let current!: ReturnType<typeof useReadAloud>;
  function Probe() {
    current = useReadAloud("env-1" as EnvironmentId);
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return {
    speech: () => current.speech,
    speak: () => current.speak,
    pause: () => current.pause,
    resume: () => current.resume,
    seekBy: () => current.seekBy,
    stop: () => current.stop,
  };
}

// Playback runs through untracked promise chains (audio session, RPC race),
// so tests flush a few microtask hops before asserting.
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

function spokenTexts(): Array<string> {
  return harness.ttsSynthesize.mock.calls.map(
    (call) => (call[0] as { input: { text: string } }).input.text,
  );
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

describe("useReadAloud", () => {
  beforeEach(() => {
    roots = [];
    harness.playlists.length = 0;
    harness.alerts.length = 0;
    harness.behavior.synthesis = "resolve";
    harness.device.config = null;
    harness.device.segments = [];
    harness.device.streamCalls = 0;
    harness.downloads.length = 0;
    harness.downloadFileAsync.mockClear();
    harness.createAudioPlaylist.mockClear();
    harness.ttsSynthesize.mockClear();
    harness.setAudioModeAsync.mockClear();
    harness.setIsAudioActiveAsync.mockClear();
  });

  afterEach(() => {
    for (const root of roots) root.unmount();
    roots = [];
    vi.useRealTimers();
  });

  it("plays the lead sentence, then hands over to the queued rest", async () => {
    const view = renderReadAloud();
    await act(async () => {
      view.speak()({ key: "msg-1", text: "One. Two. Three." });
    });
    await flush();

    // The lead chunk starts synthesis and playback; the queue waits for it
    // instead of doubling up while the lead loads.
    expect(harness.ttsSynthesize).toHaveBeenCalledTimes(1);
    expect(normalize(spokenTexts()[0]!)).toBe("Thread T3 Code: One.");
    expect(harness.players).toHaveLength(1);
    expect(harness.downloads[0]!.url).toBe("http://server.test:8923/api/tts-audio/token-1");
    expect(harness.players[0]!.uri).toBe("file:///cache/download-1.wav");
    expect(view.speech()).toMatchObject({ key: "msg-1", phase: "loading" });

    // Remote clips need preparation before play() takes effect.
    harness.players[0]!.emit({ isLoaded: true });
    expect(harness.players[0]!.play).toHaveBeenCalled();

    act(() => {
      harness.players[0]!.emit({ playing: true });
    });
    expect(view.speech()).toMatchObject({ key: "msg-1", phase: "playing" });

    act(() => {
      harness.players[0]!.emit({ didJustFinish: true });
    });
    await flush();
    expect(harness.ttsSynthesize).toHaveBeenCalledTimes(2);
    expect(normalize(spokenTexts()[1]!)).toBe("Two. Three.");
    expect(harness.players).toHaveLength(2);

    act(() => {
      harness.players[1]!.emit({ isLoaded: true, playing: true, didJustFinish: true });
    });
    await flush();
    // Queue drained -> back to idle.
    expect(view.speech()).toMatchObject({ key: null, phase: null, queued: 0 });
    expect(harness.players[1]!.release).toHaveBeenCalled();
  });

  it("fails visibly with an alert when synthesis never answers", async () => {
    vi.useFakeTimers();
    harness.behavior.synthesis = "hang";
    const view = renderReadAloud();

    await act(async () => {
      view.speak()({ key: "msg-1", text: "Hello." });
    });
    await flush();
    // Nothing is playing while the request hangs, but the timeout is armed.
    expect(harness.players).toHaveLength(0);
    expect(view.speech()).toMatchObject({ key: "msg-1", phase: "loading" });

    act(() => {
      vi.advanceTimersByTime(SYNTHESIZE_TIMEOUT_MS);
    });
    await flush();
    expect(harness.alerts).toEqual([
      {
        title: "Read aloud unavailable",
        message: "The server did not answer. Check the connection and try again.",
      },
    ]);
    expect(view.speech()).toMatchObject({ key: null, phase: null });
  });

  it("device streaming plays queued segments with exactly one Gemini stream and AVQueuePlayer", async () => {
    harness.device.config = {
      apiKey: "test-gemini-key",
      model: "gemini-2.5-flash",
      voice: "Puck",
    };
    harness.device.segments = [
      "file:///tmp/gemini-stream-segment-1.wav",
      "file:///tmp/gemini-stream-segment-2.wav",
    ];

    const view = renderReadAloud();
    await act(async () => {
      view.speak()({
        key: "msg-device-1",
        text: "Direct device speech with seamless AVQueuePlayer.",
      });
    });
    await flush();

    // Exactly one Gemini stream started
    expect(harness.device.streamCalls).toBe(1);
    // Server TTS not used
    expect(harness.ttsSynthesize).not.toHaveBeenCalled();

    // Exactly one AudioPlaylist created
    expect(harness.players).toHaveLength(1);
    const pl = harness.players[0]!;
    expect(pl.sources[0]?.uri).toBe("file:///tmp/gemini-stream-segment-1.wav");

    // Second segment appended to playlist
    expect(pl.add).toHaveBeenCalledWith({
      uri: "file:///tmp/gemini-stream-segment-2.wav",
    });

    // Loading phase before audio plays
    expect(view.speech()).toMatchObject({ key: "msg-device-1", phase: "loading" });

    // When player starts playing
    act(() => {
      pl.emit({ isLoaded: true, playing: true });
    });
    expect(view.speech()).toMatchObject({ key: "msg-device-1", phase: "playing" });

    // Stream completes and playback finishes
    act(() => {
      pl.emit({ didJustFinish: true });
    });
    await flush();

    // Playlist released, state returned to idle
    expect(pl.release).toHaveBeenCalled();
    expect(view.speech()).toMatchObject({ key: null, phase: null, queued: 0 });
  });

  it("server clips resolve the url without a double slash, then play locally", async () => {
    const view = renderReadAloud();
    await act(async () => {
      view.speak()({ key: "msg-server-1", text: "Testing url resolution." });
    });
    await flush();

    expect(harness.downloads[0]!.url).toBe("http://server.test:8923/api/tts-audio/token-1");
    expect(harness.players[0]!.uri).toBe("file:///cache/download-1.wav");

    act(() => {
      harness.players[0]!.emit({ isLoaded: true, playing: true, didJustFinish: true });
    });
    await flush();
    expect(view.speech()).toMatchObject({ key: null, phase: null });
  });

  it("prefixes spoken text with the resolved project title", async () => {
    const view = renderReadAloud();
    await act(async () => {
      view.speak()({
        key: "msg-project-1",
        text: "Der Build ist fertig.",
        projectTitle: "Super App",
      });
    });
    await flush();

    expect(normalize(spokenTexts()[0]!)).toBe("Thread Super App: Der Build ist fertig.");

    act(() => {
      harness.players[0]!.emit({ isLoaded: true, playing: true, didJustFinish: true });
    });
    await flush();
    expect(view.speech()).toMatchObject({ key: null, phase: null, queued: 0 });
  });

  it("stops cleanly while loading and does not keep the queue", async () => {
    const view = renderReadAloud();
    await act(async () => {
      view.speak()({ key: "msg-1", text: "Sentence one. Sentence two." });
    });
    await flush();
    expect(view.speech()).toMatchObject({ key: "msg-1", phase: "loading" });

    act(() => {
      view.stop()();
    });
    await flush();
    expect(view.speech()).toMatchObject({ key: null, phase: null, queued: 0 });
  });

  it("supports pause, resume, seekBy, and stop", async () => {
    const view = renderReadAloud();
    await act(async () => {
      view.speak()({ key: "msg-controls", text: "Controlling playback." });
    });
    await flush();

    const pl = harness.players[0]!;
    act(() => {
      pl.emit({ isLoaded: true, playing: true, currentTime: 20 });
    });
    expect(view.speech()).toMatchObject({ key: "msg-controls", phase: "playing" });

    // Pause
    act(() => {
      view.pause()();
    });
    expect(pl.pause).toHaveBeenCalled();
    expect(view.speech()).toMatchObject({ key: "msg-controls", phase: "paused" });

    // Seek by -10s
    act(() => {
      view.seekBy()(-10);
    });
    expect(pl.seekTo).toHaveBeenCalledWith(10);

    // Seek by +10s
    pl.currentTime = 10;
    act(() => {
      view.seekBy()(10);
    });
    expect(pl.seekTo).toHaveBeenCalledWith(20);

    // Seek backwards beyond 0 clamps to 0
    pl.currentTime = 5;
    act(() => {
      view.seekBy()(-15);
    });
    expect(pl.seekTo).toHaveBeenCalledWith(0);

    // Resume
    act(() => {
      view.resume()();
    });
    expect(pl.play).toHaveBeenCalled();
    expect(view.speech()).toMatchObject({ key: "msg-controls", phase: "playing" });

    // Stop terminates and clears session
    act(() => {
      view.stop()();
    });
    expect(pl.release).toHaveBeenCalled();
    expect(view.speech()).toMatchObject({ key: null, phase: null, queued: 0 });
  });
});

function renderAutoAnnounce(initialProps: {
  threadId: string;
  feed?: ReadonlyArray<unknown>;
  turnTexts?: ReadonlyMap<string, string>;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  let currentProps = initialProps;
  function Probe(p: {
    threadId: string;
    feed?: ReadonlyArray<unknown>;
    turnTexts?: ReadonlyMap<string, string>;
  }) {
    useReadAloudAutoAnnounce({
      environmentId: "env-1" as EnvironmentId,
      threadId: p.threadId,
      feed: p.feed,
      turnTexts: p.turnTexts,
    });
    return null;
  }

  act(() => {
    root.render(<Probe {...currentProps} />);
  });

  return {
    rerender: (nextProps: {
      threadId: string;
      feed?: ReadonlyArray<unknown>;
      turnTexts?: ReadonlyMap<string, string>;
    }) => {
      currentProps = nextProps;
      act(() => {
        root.render(<Probe {...currentProps} />);
      });
    },
  };
}

describe("useReadAloudAutoAnnounce", () => {
  beforeEach(() => {
    roots = [];
    harness.playlists.length = 0;
    harness.alerts.length = 0;
    harness.behavior.synthesis = "resolve";
    harness.device.config = null;
    harness.device.segments = [];
    harness.device.streamCalls = 0;
    harness.downloads.length = 0;
    harness.autoReadAloud = true;
    harness.downloadFileAsync.mockClear();
    harness.createAudioPlaylist.mockClear();
    harness.ttsSynthesize.mockClear();
    harness.setAudioModeAsync.mockClear();
    harness.setIsAudioActiveAsync.mockClear();
  });

  afterEach(() => {
    for (const root of roots) root.unmount();
    roots = [];
    vi.useRealTimers();
  });

  it("silences historical messages when opening a thread, even if feed loads asynchronously", async () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const harnessView = renderAutoAnnounce({ threadId: "thread-1", feed: [] });
    await flush();

    // Feed loads with existing assistant messages from the past
    harnessView.rerender({
      threadId: "thread-1",
      feed: [
        {
          type: "message",
          createdAt: pastTime,
          message: {
            id: "msg-old-1",
            role: "assistant",
            streaming: false,
            text: "This is an old message from minutes ago.",
            createdAt: pastTime,
            updatedAt: pastTime,
          },
        },
      ],
    });
    await flush();

    // No playback or synthesis triggered for historical message
    expect(harness.ttsSynthesize).not.toHaveBeenCalled();
    expect(harness.players).toHaveLength(0);
  });

  it("announces newly finished assistant reply that streamed while in thread", async () => {
    const harnessView = renderAutoAnnounce({ threadId: "thread-1", feed: [] });
    await flush();

    // Message begins streaming
    harnessView.rerender({
      threadId: "thread-1",
      feed: [
        {
          type: "message",
          message: {
            id: "msg-live",
            role: "assistant",
            streaming: true,
            text: "Generating...",
          },
        },
      ],
    });
    await flush();
    expect(harness.ttsSynthesize).not.toHaveBeenCalled();

    // Stream completes
    harnessView.rerender({
      threadId: "thread-1",
      feed: [
        {
          type: "message",
          message: {
            id: "msg-live",
            role: "assistant",
            streaming: false,
            text: "Die Antwort ist fertig.",
          },
        },
      ],
    });
    await flush();

    // The newly finished message IS announced
    expect(harness.ttsSynthesize).toHaveBeenCalledTimes(1);
    expect(spokenTexts()[0]).toContain("Die Antwort ist fertig.");
  });

  it("silences old messages when switching to a different thread", async () => {
    const harnessView = renderAutoAnnounce({
      threadId: "thread-1",
      feed: [],
    });
    await flush();

    // User switches to thread-2 with existing history
    const pastTime = new Date(Date.now() - 30_000).toISOString();
    harnessView.rerender({
      threadId: "thread-2",
      feed: [
        {
          type: "message",
          createdAt: pastTime,
          message: {
            id: "msg-thread-2-old",
            role: "assistant",
            streaming: false,
            text: "Alte Nachricht in Thread 2.",
            createdAt: pastTime,
            updatedAt: pastTime,
          },
        },
      ],
    });
    await flush();

    expect(harness.ttsSynthesize).not.toHaveBeenCalled();
  });

  it("speaks automatically when armed via armReadAloudOnNextReply, even with autoRead disabled", async () => {
    // Disable general auto-read
    harness.autoReadAloud = false;
    const harnessView = renderAutoAnnounce({
      threadId: "thread-arm-test",
      feed: [],
      turnTexts: new Map([["msg-armed-reply", "Vollständiger Turn Text zum Vorlesen."]]),
    });
    await flush();

    // Arm for next reply on this thread
    armReadAloudOnNextReply("thread-arm-test");
    expect(isReadAloudArmedOnNextReply("thread-arm-test")).toBe(true);

    // Assistant begins streaming
    harnessView.rerender({
      threadId: "thread-arm-test",
      feed: [
        {
          type: "message",
          message: {
            id: "msg-armed-reply",
            role: "assistant",
            streaming: true,
            text: "Generating reply...",
          },
        },
      ],
      turnTexts: new Map([["msg-armed-reply", "Vollständiger Turn Text zum Vorlesen."]]),
    });
    await flush();
    expect(harness.ttsSynthesize).not.toHaveBeenCalled();

    // Stream finishes
    harnessView.rerender({
      threadId: "thread-arm-test",
      feed: [
        {
          type: "message",
          message: {
            id: "msg-armed-reply",
            role: "assistant",
            streaming: false,
            text: "Kurzer Text.",
          },
        },
      ],
      turnTexts: new Map([["msg-armed-reply", "Vollständiger Turn Text zum Vorlesen."]]),
    });
    await flush();

    // Synthesis should be called with the full turn text
    expect(harness.ttsSynthesize).toHaveBeenCalledTimes(1);
    expect(spokenTexts()[0]).toContain("Vollständiger Turn Text zum Vorlesen.");

    // Should be disarmed now
    expect(isReadAloudArmedOnNextReply("thread-arm-test")).toBe(false);
  });

  it("keeps active playback running when switching to another thread or opening the same thread", async () => {
    const view = renderReadAloud();
    act(() => {
      view.speak()({
        key: "msg-active",
        text: "Playing globally.",
        threadId: "thread-active",
        environmentId: "env-1" as EnvironmentId,
        title: "Active Thread",
      });
    });
    await flush();

    const pl = harness.players[0]!;
    expect(pl.play).toHaveBeenCalled();
    act(() => {
      pl.emit({ isLoaded: true, playing: true });
    });
    expect(view.speech()).toMatchObject({
      key: "msg-active",
      phase: "playing",
      threadId: "thread-active",
      title: "Active Thread",
    });

    // Mount auto announce for another thread (thread-2)
    const harnessView = renderAutoAnnounce({
      threadId: "thread-2",
      feed: [],
    });
    await flush();

    // Active speech must NOT be stopped or released!
    expect(pl.release).not.toHaveBeenCalled();
    expect(view.speech().phase).toBe("playing");
    expect(view.speech().threadId).toBe("thread-active");

    // Switching back to thread-active also must NOT stop or re-initialize playback
    harnessView.rerender({
      threadId: "thread-active",
      feed: [],
    });
    await flush();

    expect(pl.release).not.toHaveBeenCalled();
    expect(view.speech().phase).toBe("playing");
  });

  it("arms with thread details and disarms cleanly for background synchronization", () => {
    armReadAloudOnNextReply({
      threadId: "thread-42",
      environmentId: "env-test" as EnvironmentId,
      threadTitle: "My Test Thread",
    });

    expect(isReadAloudArmedOnNextReply("thread-42")).toBe(true);
    const targets = getArmedReadAloudTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      threadId: "thread-42",
      environmentId: "env-test",
      threadTitle: "My Test Thread",
    });

    disarmReadAloudOnNextReply("thread-42");
    expect(isReadAloudArmedOnNextReply("thread-42")).toBe(false);
    expect(getArmedReadAloudTargets()).toHaveLength(0);
  });

  it("provides referentially stable snapshots from getArmedReadAloudTargets until changed", () => {
    const initial = getArmedReadAloudTargets();
    expect(getArmedReadAloudTargets()).toBe(initial);

    armReadAloudOnNextReply("thread-stability-1");
    const afterArm = getArmedReadAloudTargets();
    expect(afterArm).not.toBe(initial);
    expect(getArmedReadAloudTargets()).toBe(afterArm);

    disarmReadAloudOnNextReply("thread-stability-1");
    const afterDisarm = getArmedReadAloudTargets();
    expect(afterDisarm).not.toBe(afterArm);
    expect(getArmedReadAloudTargets()).toBe(afterDisarm);
  });
});
