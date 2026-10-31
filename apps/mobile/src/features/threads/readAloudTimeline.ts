/**
 * A read-aloud reply plays as several clips in one playlist. The timeline maps
 * those clips onto one continuous track so the UI can show a single position
 * and duration and seek across clip boundaries.
 */

/** German TTS voices speak roughly 14–15 characters per second at normal rate. */
const ESTIMATED_CHARS_PER_SECOND = 14.5;

export const estimateSpeechSeconds = (text: string): number =>
  text.trim().length / ESTIMATED_CHARS_PER_SECOND;

export interface TimelineTrack {
  readonly seconds: number;
  /** False while `seconds` is still the text-length estimate. */
  readonly exact: boolean;
}

export interface ReadAloudTimeline {
  /** One entry per playlist track, in playback order. */
  readonly tracks: ReadonlyArray<TimelineTrack>;
  /** Estimated audio that has no track yet, e.g. a device stream still producing segments. */
  readonly pendingSeconds: number;
}

export const timelineDuration = (timeline: ReadAloudTimeline): number =>
  timeline.tracks.reduce((sum, track) => sum + track.seconds, 0) + timeline.pendingSeconds;

export const isTimelineExact = (timeline: ReadAloudTimeline): boolean =>
  timeline.pendingSeconds === 0 && timeline.tracks.every((track) => track.exact);

export const timelinePosition = (
  timeline: ReadAloudTimeline,
  trackIndex: number,
  trackTime: number,
): number => {
  let position = 0;
  for (let index = 0; index < trackIndex && index < timeline.tracks.length; index += 1) {
    position += timeline.tracks[index]!.seconds;
  }
  return position + Math.max(0, trackTime);
};

/**
 * Resolves a whole-reply position to a track and an offset inside it. Only the
 * first `playableTracks` tracks are in the playlist, so seeking past them lands
 * in the last playable one and the player clamps to its real end.
 */
export const locateTimelineTime = (
  timeline: ReadAloudTimeline,
  seconds: number,
  playableTracks: number,
): { readonly index: number; readonly offset: number } => {
  const lastIndex = Math.max(0, Math.min(playableTracks, timeline.tracks.length) - 1);
  let remaining = Math.max(0, seconds);
  let index = 0;
  while (index < lastIndex && remaining >= timeline.tracks[index]!.seconds) {
    remaining -= timeline.tracks[index]!.seconds;
    index += 1;
  }
  return { index, offset: remaining };
};

const readAscii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const readUint32LE = (bytes: Uint8Array, offset: number) =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) +
  bytes[offset + 3]! * 0x1000000;

const wavDurationSeconds = (bytes: Uint8Array): number | null => {
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 12 <= bytes.length) {
      byteRate = readUint32LE(bytes, body + 8);
    } else if (id === "data") {
      if (byteRate === 0) return null;
      // Streamed WAVs write a placeholder size; the bytes on disk are the truth.
      const dataBytes = Math.min(size, bytes.length - body);
      return dataBytes / byteRate;
    }
    offset = body + size + (size % 2);
  }
  return null;
};

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, ReadonlyArray<number>> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

/** Walks MPEG Layer III frames; exact for CBR and VBR without trusting a Xing header. */
const mp3DurationSeconds = (bytes: Uint8Array): number | null => {
  let offset = 0;
  if (readAscii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
    const tagSize =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    offset = 10 + tagSize + (bytes[5]! & 0x10 ? 10 : 0);
  }
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    const b1 = bytes[offset + 1]!;
    const b2 = bytes[offset + 2]!;
    const version = (b1 >> 3) & 0x03;
    const layer = (b1 >> 1) & 0x03;
    const bitrateIndex = b2 >> 4;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    const isFrame =
      bytes[offset] === 0xff &&
      (b1 & 0xe0) === 0xe0 &&
      version !== 1 &&
      layer === 1 &&
      bitrateIndex !== 0 &&
      bitrateIndex !== 15 &&
      sampleRateIndex !== 3;
    if (!isFrame) {
      offset += 1;
      continue;
    }
    const isMpeg1 = version === 3;
    const kbps = (isMpeg1 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[bitrateIndex]!;
    const sampleRate = SAMPLE_RATES[version]![sampleRateIndex]!;
    const samplesPerFrame = isMpeg1 ? 1152 : 576;
    const padding = (b2 >> 1) & 0x01;
    const frameLength = Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sampleRate) + padding;
    seconds += samplesPerFrame / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  return frames > 0 ? seconds : null;
};

/** Duration of a WAV or MP3 clip, `null` when the bytes are neither. */
export const audioDurationSeconds = (bytes: Uint8Array): number | null => {
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WAVE"
  ) {
    return wavDurationSeconds(bytes);
  }
  return mp3DurationSeconds(bytes);
};
