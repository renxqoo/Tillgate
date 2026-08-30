/**
 * 欠费路由层行为（2026-08-30 生产事故分析后续）：
 *
 * 【已修复锚点】402 欠费在 ai 分类层修正为 quota_exhausted 后
 *   （statusKind 402 分支 + OPENAI_CODE_KINDS 补 insufficient_credits），
 *   路由层消费正确分类 → switch_channel + 30 分钟惩罚箱。
 *   原 402 红测断言已由 packages/ai/__test__/red-openrouter-credits.test.ts 转绿承载。
 *
 * 【现状锁定（绿）】
 *   - invalid_request + 4xx 透传：换渠救不了参数错误（设计语义）；
 *   - 渠道进货额度耗尽的终局形态（2026-08-30 14:41-14:56 UTC 生产实况）：
 *     预算池均低于单次预留预估 → budget gate 拒绝 → 全渠道竭尽 →
 *     no_available_channel（客户端 503）。「运营充值不足」以 503 呈现，
 *     上下文（upstream_code）经错误信封与 5xx 日志透出（http handler 增强）。
 */
import { describe, expect, it } from 'vitest';
import {
  isChannelExhausted,
  isChannelSwitchable,
  isRequestScopedRejection,
  routeFailure,
} from '../src/domain/routing/switchable';

describe('欠费（402）路由层行为：分类修复后的锚点（原红测已转绿）', () => {
  it('routeFailure：欠费正确分类（quota_exhausted）必须换渠道——402 修复后主路径', () => {
    expect(isChannelSwitchable('quota_exhausted')).toBe(true);
    expect(routeFailure({ kind: 'quota_exhausted', status: 402 })).toBe('switch_channel');
  });

  it('词表现状锁定：invalid_request + 4xx 仍透传（换渠救不了参数错误——设计语义）', () => {
    // 402 已由 ai 分类层修正为 quota_exhausted（statusKind + insufficient_credits 码表），
    // invalid_request 到达路由层时按词表透传是设计现状，非缺陷
    expect(routeFailure({ kind: 'invalid_request', status: 400 })).toBe('respond');
  });
});

describe('现状锁定：渠道进货额度耗尽的终局（生产 2026-08-30 14:41 UTC 实况）', () => {
  it('channel_budget_exhausted 归渠道面竭尽 → no_available_channel（客户端 503）', () => {
    expect(isChannelExhausted('channel_budget_exhausted')).toBe(true);
  });

  it('预算闸拒绝是请求维豁免（不判死模型）——bafa88e 行为锚点', () => {
    expect(isRequestScopedRejection('channel_budget_exhausted')).toBe(true);
  });
});
