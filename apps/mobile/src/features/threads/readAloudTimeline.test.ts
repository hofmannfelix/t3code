import { describe, expect, it } from "vite-plus/test";

import {
  audioDurationSeconds,
  isTimelineExact,
  locateTimelineTime,
  timelineDuration,
  timelinePosition,
  type ReadAloudTimeline,
} from "./readAloudTimeline";

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const uint32LE = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const uint16LE = (value: number) => [value & 0xff, (value >> 8) & 0xff];

const wav = (pcmBytes: number, options?: { readonly declaredDataBytes?: number }) =>
  new Uint8Array([
    ...ascii("RIFF"),
    ...uint32LE(36 + pcmBytes),
    ...ascii("WAVE"),
    ...ascii("fmt "),
    ...uint32LE(16),
    ...uint16LE(1),
    ...uint16LE(1),
    ...uint32LE(24_000),
    ...uint32LE(48_000),
    ...uint16LE(2),
    ...uint16LE(16),
    ...ascii("data"),
    ...uint32LE(options?.declaredDataBytes ?? pcmBytes),
    ...Array.from({ length: pcmBytes }, () => 0),
  ]);

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames of 1152 samples.
const mp3Frames = (count: number) => {
  const frame = [0xff, 0xfb, 0x90, 0x00, ...Array.from({ length: 413 }, () => 0)];
  return Array.from({ length: count }, () => frame).flat();
};

describe("audioDurationSeconds", () => {
  it("reads WAV duration from the format and data chunks", () => {
    expect(audioDurationSeconds(wav(96_000))).toBe(2);
  });

  it("trusts the bytes on disk over a streamed WAV's placeholder size", () => {
    expect(audioDurationSeconds(wav(24_000, { declaredDataBytes: 0xffffffff }))).toBe(0.5);
  });

  it("counts MP3 frames after an ID3 tag", () => {
    const id3 = [...ascii("ID3"), 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5];
    const seconds = audioDurationSeconds(new Uint8Array([...id3, ...mp3Frames(10)]));
    expect(seconds).toBeCloseTo((10 * 1152) / 44_100, 6);
  });

  it("returns null for bytes that are not audio", () => {
    expect(audioDurationSeconds(new Uint8Array(ascii("not audio at all")))).toBeNull();
  });
});

describe("timeline", () => {
  const timeline: ReadAloudTimeline = {
    tracks: [
      { seconds: 2, exact: true },
      { seconds: 5, exact: false },
      { seconds: 3, exact: true },
    ],
    pendingSeconds: 0,
  };

  it("sums tracks and pending audio into one duration", () => {
    expect(timelineDuration(timeline)).toBe(10);
    expect(timelineDuration({ ...timeline, pendingSeconds: 4 })).toBe(14);
  });

  it("is exact only when no estimate remains", () => {
    expect(isTimelineExact(timeline)).toBe(false);
    const allExact = {
      tracks: timeline.tracks.map((t) => ({ ...t, exact: true })),
      pendingSeconds: 0,
    };
    expect(isTimelineExact(allExact)).toBe(true);
    expect(isTimelineExact({ ...allExact, pendingSeconds: 1 })).toBe(false);
  });

  it("maps a track position onto the whole reply and back", () => {
    expect(timelinePosition(timeline, 1, 1.5)).toBe(3.5);
    expect(locateTimelineTime(timeline, 3.5, 3)).toEqual({ index: 1, offset: 1.5 });
    expect(locateTimelineTime(timeline, 7, 3)).toEqual({ index: 2, offset: 0 });
  });

  it("keeps seeks inside the tracks the playlist already has", () => {
    expect(locateTimelineTime(timeline, 9, 2)).toEqual({ index: 1, offset: 7 });
    expect(locateTimelineTime(timeline, -4, 3)).toEqual({ index: 0, offset: 0 });
  });
});
