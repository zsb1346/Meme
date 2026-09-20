import { describe, expect, it } from 'vitest';
import { fallbackPlaybackRate } from './sample-player';

describe('sample player transform fallback', () => {
  it('WASM 失败时固定 rate=1，避免变调连带改变时长', () => {
    expect(fallbackPlaybackRate()).toBe(1);
  });
});
