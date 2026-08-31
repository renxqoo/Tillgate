/**
 * 回归测试（原 2026-08-30 生产事故红测，修复后转绿）——OpenRouter 欠费错误
 * 必须归类 quota_exhausted（可换渠道 + 惩罚箱），不得落 invalid_request
 * （透传终局、零健康痕迹、下个请求仍会撞同一欠费渠道）。
 *
 * 生产形态（115.190.199.161，模型 minimax/minimax-m3:free 经 openrouter 渠道）：
 * openrouter.ai 余额不足时返回 HTTP 402，错误体 code 为 insufficient_credits
 * （字符串）或 402（数字），message 含 "Not enough credits"。openrouter 渠道
 * 以 openai-compatible 协议接入（control-plane 的 openrouter-source.ts），
 * 错误经 OpenAICompatibleAdapter.mapError 分类。
 *
 * 修复点：
 *   1. OPENAI_CODE_KINDS 补 insufficient_credits（字符串 code 形态）；
 *   2. statusKind 兜底矩阵补 402 → quota_exhausted（数字 code / 无 code 形态——
 *      extractVendorCode 只认 string，数字 code 落 status 兜底）。
 */
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';

/** 与生产 openrouter 渠道一致的 openai-compatible 适配器实例 */
const adapter = new OpenAICompatibleAdapter();

describe('红测：OpenRouter 欠费（402 insufficient_credits）应归类 quota_exhausted', () => {
  it('形态 A：402 + error.code="insufficient_credits"（openrouter 现行信封）', () => {
    const e = adapter.mapError(
      402,
      {
        error: {
          code: 'insufficient_credits',
          message: "Payment required: You don't have enough credits to route this request.",
        },
      },
      {},
    );
    // 期望：欠费是渠道面问题（quota_exhausted），不是客户端参数错误
    expect(e.kind).toBe('quota_exhausted');
  });

  it('形态 B：402 + 数字 code（error.code=402，extractVendorCode 不识别的形状）', () => {
    const e = adapter.mapError(
      402,
      { error: { code: 402, message: 'Not enough credits. Please upgrade your plan.' } },
      {},
    );
    expect(e.kind).toBe('quota_exhausted');
  });

  it('形态 C：402 + 无 code，仅 message 语义（兜底矩阵需覆盖 402 语义）', () => {
    const e = adapter.mapError(402, { error: { message: 'Insufficient credits' } }, {});
    expect(e.kind).toBe('quota_exhausted');
  });
});
