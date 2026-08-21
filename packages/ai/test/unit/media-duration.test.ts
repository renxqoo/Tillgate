import { describe, expect, it } from 'vitest';
import { estimateAudioDurationSeconds } from '../../src/usage/media-duration';

/** 构造最小 WAV（RIFF/fmt/data 头，byteRate=16000，dataSize=320000 → 20s） */
function wav(byteRate: number, dataSize: number): Uint8Array {
  const buf = new Uint8Array(44 + dataSize);
  const v = new DataView(buf.buffer);
  const tag = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, byteRate, true);
  v.setUint32(28, byteRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataSize, true);
  return buf;
}

describe('estimateAudioDurationSeconds', () => {
  it('WAV：RIFF 头精确时长（320000B ÷ 32000B/s = 10s）', () => {
    expect(estimateAudioDurationSeconds(wav(16000, 320000))).toBe(10);
  });

  it('WAV：非整秒向上取整', () => {
    expect(estimateAudioDurationSeconds(wav(16000, 320001))).toBe(11);
    expect(estimateAudioDurationSeconds(wav(8000, 100))).toBe(1);
  });

  it('无法识别 → 保守兜底不小于 1 秒', () => {
    expect(estimateAudioDurationSeconds(new Uint8Array(16384))).toBe(1);
    expect(estimateAudioDurationSeconds(new Uint8Array(163850))).toBe(11); // ~10s@16KB/s 向上取整
    expect(estimateAudioDurationSeconds(new Uint8Array(8))).toBe(1);
  });
});
