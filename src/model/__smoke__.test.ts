import { describe, it, expect } from 'vitest';
import { hzToMidi, midiToHz, playbackRateForSemitones } from '../engine/pitch';

describe('smoke', () => {
  it('test harness works', () => {
    expect(true).toBe(true);
  });

  it('imports pure engine module (pitch)', () => {
    // A4 = 440Hz → MIDI 69
    expect(hzToMidi(440)).toBeCloseTo(69, 6);
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    // +12 半音 → 2 倍速
    expect(playbackRateForSemitones(12)).toBeCloseTo(2, 6);
  });
});
