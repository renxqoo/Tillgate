import { describe, expect, it } from 'vitest';
import {
  admissionTokenUpperBound,
  clampForwardedOutputLimit,
  conservativeInputTokenUpperBound,
  maxOutputTokensFor,
} from '../src/domain/model/output-cap';

const config = { defaultMax: 4_096, exposureCap: 32_768 };

describe('domain/model/output-cap：输出上界口径（mct > mt > 缺省；×n；封顶）', () => {
  it('max_completion_tokens 优先于 max_tokens，缺省用 defaultMax', () => {
    expect(
      maxOutputTokensFor('chat', { max_completion_tokens: 100, max_tokens: 200 }, config),
    ).toBe(100);
    expect(maxOutputTokensFor('chat', { max_tokens: 200 }, config)).toBe(200);
    expect(maxOutputTokensFor('chat', {}, config)).toBe(4_096);
  });

  it('n 倍数参与上界并封顶 exposureCap（「预估敞口 ≥ 实际输出」）', () => {
    expect(maxOutputTokensFor('chat', { max_tokens: 100, n: 3 }, config)).toBe(300);
    expect(maxOutputTokensFor('chat', { max_tokens: 10_000, n: 8 }, config)).toBe(32_768);
    // 非正 n / 非整数 n 按 1 处理
    expect(maxOutputTokensFor('chat', { max_tokens: 100, n: 0 }, config)).toBe(100);
    expect(maxOutputTokensFor('chat', { max_tokens: 100, n: -2 }, config)).toBe(100);
  });

  it('embeddings 与模态族输出上界为 0（v1 口径）', () => {
    expect(maxOutputTokensFor('embeddings', { max_tokens: 500 }, config)).toBe(0);
    expect(maxOutputTokensFor('modality', { max_tokens: 500 }, config)).toBe(0);
  });

  it('钳制：声明超口径压到口径内（mct/mt 各自压），未声明任何上限才注入 mct', () => {
    expect(clampForwardedOutputLimit({ max_tokens: 9_000 }, 4_096)).toEqual({
      max_tokens: 4_096,
    });
    expect(clampForwardedOutputLimit({ max_completion_tokens: 9_000 }, 4_096)).toEqual({
      max_completion_tokens: 4_096,
    });
    expect(clampForwardedOutputLimit({}, 4_096)).toEqual({ max_completion_tokens: 4_096 });
  });

  it('钳制的 perCompletion 已含 n 分摊：n=4 时每完成压到 cap/4', () => {
    expect(clampForwardedOutputLimit({ max_tokens: 2_000, n: 4 }, 4_096)).toEqual({
      max_tokens: 1_024,
      n: 4,
    });
  });

  it('无需改动时返回原引用（不拷贝）；cap/n 派生为 0 时不注入垃圾', () => {
    const body = { max_tokens: 100 };
    expect(clampForwardedOutputLimit(body, 4_096)).toBe(body);
    expect(clampForwardedOutputLimit({ max_tokens: 100, n: 4 }, 3)).toBeInstanceOf(Object);
    expect(Object.keys(clampForwardedOutputLimit({ n: 4 }, 3))).toEqual(['n']);
  });

  it('准入预占口径 = 输入上界 + 输出上界（与 billing 敞口同式；仅 chat 族计输出）', () => {
    const cap = { defaultMax: 4_096, exposureCap: 32_768 };
    const body = { model: 'm', messages: [{}] };
    const input = conservativeInputTokenUpperBound(body);
    // chat：无声明 max_tokens → 缺省 4096
    expect(admissionTokenUpperBound('chat', body, cap)).toBe(input + 4_096);
    // chat：声明 max_tokens=100 → 100
    const capped = { ...body, max_tokens: 100 };
    expect(admissionTokenUpperBound('chat', capped, config)).toBe(
      conservativeInputTokenUpperBound(capped) + 100,
    );
    // chat：×n 封顶 exposureCap
    expect(admissionTokenUpperBound('chat', { ...body, max_tokens: 100, n: 9 }, cap)).toBe(
      conservativeInputTokenUpperBound({ ...body, max_tokens: 100, n: 9 }) + 900,
    );
    expect(admissionTokenUpperBound('chat', { ...body, max_tokens: 32_768, n: 8 }, cap)).toBe(
      conservativeInputTokenUpperBound({ ...body, max_tokens: 32_768, n: 8 }) + 32_768,
    );
    // embeddings / modality：输出维恒 0（只押输入）
    expect(admissionTokenUpperBound('embeddings', body, cap)).toBe(input);
    expect(admissionTokenUpperBound('modality', body, cap)).toBe(input);
  });

  it('输入保守上界 = JSON UTF-8 字节数（每 token ≥1 字节——安全上界）', () => {
    const bytes = conservativeInputTokenUpperBound({ messages: [{ role: 'user', content: 'hi' }] });
    expect(bytes).toBeGreaterThan(20);
    // 循环引用等序列化失败兜底 0（估算降级，不抛不崩）
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(conservativeInputTokenUpperBound(cyclic)).toBe(0);
  });
});
