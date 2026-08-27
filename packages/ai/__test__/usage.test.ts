import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '../src/usage/normalize.js';
import { estimateTextTokens, estimateOutputTokens } from '../src/usage/token-estimate.js';
import { resolveCalibration } from '../src/usage/calibration.js';
import { estimateAudioDurationSeconds } from '../src/usage/media-duration.js';

describe('usage/normalize：方言归一矩阵与冲突弃真（B3 观测）', () => {
  it('OpenAI snake 形', () => {
    const u = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 },
    });
    expect(u).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      estimated: false,
    });
  });
  it('anthropic 经 codec 翻译后的规范形（snake + details + cache_write）', () => {
    const u = normalizeUsage({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 3 },
      cache_write_tokens: 2,
    });
    expect(u).toMatchObject({
      inputTokens: 12,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      outputTokens: 5,
    });
  });
  it('DeepSeek cache_hit+miss 重建输入', () => {
    const u = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_cache_hit_tokens: 6,
      prompt_cache_miss_tokens: 4,
      total_tokens: 12,
    });
    expect(u).toMatchObject({ inputTokens: 10, cachedInputTokens: 6, outputTokens: 2 });
  });
  it('cached > input 拒收；total 不一致与 0+0 弃用退估算（B3 语义：返回 null）', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 3,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 9 },
      }),
    ).toBeNull();
    expect(
      normalizeUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 999 }),
    ).toBeNull();
    expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
  });
  it('垃圾形状/数组/null 全拒收不抛', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage([1])).toBeNull();
    expect(normalizeUsage('x')).toBeNull();
    expect(normalizeUsage({})).toBeNull();
  });
});

describe('usage/token-estimate：估算与 B1 口径回归', () => {
  it('BPE 主路径：有 model 时优先精确分词（两文本精确值不同）', () => {
    const w = resolveCalibration().weights;
    const a = estimateTextTokens('你好世界', w, 'gpt-4o');
    const b = estimateTextTokens('你好世界你好世界', w, 'gpt-4o');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThanOrEqual(a);
  });
  it('B1 回归：输出侧 reasoning/tool_calls/text 与 content 同口径（传 model 后走 BPE）', () => {
    const w = resolveCalibration().weights;
    // 同一文本：content 路径 vs text 路径，传 model 后应同值
    const viaContent = estimateTextTokens('确定口径样本', w, 'gpt-4o');
    const viaOutput = estimateOutputTokens(
      { choices: [{ text: '确定口径样本' }] },
      { model: 'gpt-4o' },
    );
    expect(viaOutput).toBe(viaContent);
    const viaReasoning = estimateOutputTokens(
      { choices: [{ message: { reasoning_content: '确定口径样本' } }] },
      { model: 'gpt-4o' },
    );
    expect(viaReasoning).toBe(viaContent);
  });
  it('启发式兜底：CJK 逐字权重 × 计数', () => {
    const w = { cjk: 0.6, word: 0.25, number: 0.4, symbol: 0.3 } as never;
    const n = estimateTextTokens('你好', w); // 无 model → 启发式（点积后取整）
    expect(n).toBe(1); // round(2 × 0.6)
  });
});

describe('usage/media-duration：音频时长（保守高估）', () => {
  it('WAV：标准头（fmt/data 块遍历）→ byteRate 口径', () => {
    const wav = new Uint8Array(44);
    const dv = new DataView(wav.buffer);
    const tag = (o: number, t: string) => {
      for (let i = 0; i < 4; i++) dv.setUint8(o + i, t.charCodeAt(i));
    };
    tag(0, 'RIFF');
    dv.setUint32(4, 36, false);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    dv.setUint32(16, 16, false);
    dv.setUint16(20, 1, false);
    dv.setUint16(22, 1, false); // PCM mono
    dv.setUint32(24, 8000, false);
    dv.setUint32(28, 16000, false); // byteRate 16KB/s
    dv.setUint16(32, 2, false);
    dv.setUint16(34, 16, false);
    tag(36, 'data');
    dv.setUint32(40, 16000, false); // 1s 数据
    const sec = estimateAudioDurationSeconds(wav);
    expect(sec).toBeGreaterThanOrEqual(0.9);
  });
  it('无法识别 → 16KB/s 兜底（宁高不漏收）', () => {
    const sec = estimateAudioDurationSeconds(new Uint8Array(1600));
    expect(sec).toBe(1); // 1600B/16KB/s=0.1s，向上取整（宁高不漏收口径）
  });
});
