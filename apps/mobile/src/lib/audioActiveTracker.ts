let audioSessionOrPlaybackActivePredicate: (() => boolean) | null = null;

export function registerAudioPlaybackActivePredicate(fn: () => boolean): () => void {
  audioSessionOrPlaybackActivePredicate = fn;
  return () => {
    if (audioSessionOrPlaybackActivePredicate === fn) {
      audioSessionOrPlaybackActivePredicate = null;
    }
  };
}

export function isAudioSessionOrPlaybackActive(): boolean {
  return audioSessionOrPlaybackActivePredicate ? audioSessionOrPlaybackActivePredicate() : false;
}
