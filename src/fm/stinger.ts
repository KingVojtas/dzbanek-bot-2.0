/** Station chime length. A short rising bell, not a song. */
export const CHIME_SECONDS = 1.2;
/** Quiet between two spoken parts of a break. */
export const BREAK_GAP_SECONDS = 0.5;

const RATE = 48_000;
/** s16le stereo: one frame is two channels of 16-bit samples. */
const FRAME = 4;

/**
 * A rising four-note bell, as s16le 48 kHz stereo PCM.
 * Each note attacks quickly and decays. A soft second harmonic sits under it.
 * The peak is about -6 dBFS, and the end fades so the clip does not click.
 */
export function stationChime(): Buffer {
  const frames = Math.round(CHIME_SECONDS * RATE);
  const notes = [
    { hz: 523.25, at: 0 },
    { hz: 659.25, at: 0.22 },
    { hz: 783.99, at: 0.44 },
    { hz: 1046.5, at: 0.66 },
  ];
  const noteSeconds = 0.72;
  const raw = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE;
    let sample = 0;
    for (const note of notes) {
      const age = t - note.at;
      if (age < 0 || age > noteSeconds) continue;
      const attack = 0.006;
      const env = age < attack ? age / attack : Math.exp(-(age - attack) / 0.16);
      const fundamental = Math.sin(2 * Math.PI * note.hz * age);
      const harmonic = Math.sin(2 * Math.PI * note.hz * 2 * age);
      sample += env * (fundamental + 0.22 * harmonic);
    }
    const fade = 0.04;
    if (t > CHIME_SECONDS - fade) sample *= Math.max(0, (CHIME_SECONDS - t) / fade);
    raw[i] = sample;
  }

  let peak = 0;
  for (const sample of raw) peak = Math.max(peak, Math.abs(sample));
  // -6 dBFS against a full-scale 16-bit sample. Stay under the rail.
  const target = 32_767 * 10 ** (-6 / 20);
  const gain = peak > 0 ? target / peak : 0;
  const pcm = Buffer.alloc(frames * FRAME);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.max(-32_767, Math.min(32_767, (raw[i] ?? 0) * gain)));
    pcm.writeInt16LE(sample, i * FRAME);
    pcm.writeInt16LE(sample, i * FRAME + 2);
  }
  return pcm;
}

/** Half a second of silence, in the same PCM format as a DJ clip. */
export function breakGap(): Buffer {
  return Buffer.alloc(Math.round(BREAK_GAP_SECONDS * RATE) * FRAME);
}
