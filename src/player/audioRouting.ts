/**
 * A video's sound goes through Web Audio, so "what I hear" and "what the
 * room hears" are separate:
 *
 *   <video> ─► MediaElementSource ─┬─► Gain (MY volume) ─► speakers
 *                                  └─► MediaStreamDestination ─► a share's audio track
 *
 * Measured in Chrome (research/2026-10-01/S2-capture-spike.md): with my gain
 * at 0 the room still hears full audio, and `element.volume` does not touch
 * the graph — but `element.muted = true` SILENCES the source node, the room
 * included. So mute is `gain = 0` here, and the element is never muted.
 *
 * `createMediaElementSource` may be called only ONCE per element, ever, so
 * the routing is created once per element and kept in a WeakMap.
 */

type AudioRoute = {
  context: AudioContext;
  /** My volume, 0..1 (mute = 0). */
  setVolume(volume: number): void;
  /** Full-level audio for peers; created on first use. */
  streamTrack(): MediaStreamTrack;
};

const routes = new WeakMap<HTMLMediaElement, AudioRoute>();
let sharedContext: AudioContext | null = null;

/** One context for the app: browsers cap how many may exist. */
function audioContext(): AudioContext {
  sharedContext ??= new AudioContext();
  return sharedContext;
}

/**
 * The element's route, created on first call. Call it from a user gesture
 * (a play click): an AudioContext made without one starts suspended, and a
 * routed element is silent until it runs.
 */
function audioRouteFor(element: HTMLMediaElement): AudioRoute {
  const existing = routes.get(element);
  if (existing) return existing;
  const context = audioContext();
  const source = context.createMediaElementSource(element);
  const gain = context.createGain();
  source.connect(gain).connect(context.destination);
  element.muted = false;
  element.volume = 1;
  let destination: MediaStreamAudioDestinationNode | null = null;
  const route: AudioRoute = {
    context,
    setVolume(volume) {
      gain.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)), context.currentTime, 0.015);
    },
    streamTrack() {
      if (!destination) {
        destination = context.createMediaStreamDestination();
        source.connect(destination);
      }
      return destination.stream.getAudioTracks()[0];
    },
  };
  routes.set(element, route);
  return route;
}

/** Resume the shared context (it can suspend when the tab is hidden). */
async function resumeAudio(): Promise<void> {
  if (sharedContext && sharedContext.state !== 'running') await sharedContext.resume().catch(() => {});
}

export { audioRouteFor, resumeAudio };
export type { AudioRoute };
