import { describe, expect, it } from 'vitest';
import { KIND_MECHANICS } from '@tillgate/ai';
import {
  isChannelExhausted,
  isChannelSwitchable,
  routeFailure,
} from '../src/domain/routing/switchable';

describe('domain/routing/switchable：ErrorKind 全矩阵（词表封闭性表驱动）', () => {
  // 可换渠 kind：渠道/凭据/传输问题
  const switchable: string[] = [
    'network',
    'timeout',
    'upstream_error',
    'overloaded',
    'rate_limited',
    'quota_exhausted',
    'invalid_api_key',
    'insufficient_permissions',
    'empty_completion',
    'invalid_response',
    'invalid_config',
    'unsupported_protocol',
    'task_ops_unavailable',
    'circuit_open',
    'dead_credential',
    'channel_budget_exhausted',
    'rate_limit_exceeded',
  ];
  // 不换渠 kind：4xx 客户端错误（换渠道也一样失败）
  const passthrough: string[] = [
    'invalid_request',
    'context_overflow',
    'content_filtered',
    'model_not_found',
  ];

  it('可换词表逐项判定（新增表项自动获得覆盖）', () => {
    for (const kind of switchable) expect(isChannelSwitchable(kind)).toBe(true);
  });

  it('客户端错误词表不换渠；canceled/server_draining 归兜底臂', () => {
    for (const kind of passthrough) expect(isChannelSwitchable(kind)).toBe(false);
    expect(isChannelSwitchable('canceled')).toBe(false);
    expect(isChannelSwitchable('server_draining')).toBe(false);
  });

  it('null/undefined/未知码不换渠（防御垃圾形状）', () => {
    expect(isChannelSwitchable()).toBe(false);
    expect(isChannelSwitchable(null)).toBe(false);
    expect(isChannelSwitchable('no_such_kind')).toBe(false);
  });

  it('routeFailure：可换 kind → switch_channel（先于状态码判定——429/401 也换渠）', () => {
    expect(routeFailure({ kind: 'rate_limited', status: 429 })).toBe('switch_channel');
    expect(routeFailure({ kind: 'invalid_api_key', status: 401 })).toBe('switch_channel');
    expect(routeFailure({ kind: 'network' })).toBe('switch_channel');
  });

  it('routeFailure：不可换 + 4xx → respond 透传；其余 → next_candidate（v1 兜底臂）', () => {
    expect(routeFailure({ kind: 'invalid_request', status: 400 })).toBe('respond');
    expect(routeFailure({ kind: 'context_overflow', status: 400 })).toBe('respond');
    expect(routeFailure({ kind: 'canceled' })).toBe('next_candidate');
    expect(routeFailure({ kind: 'canceled', status: 499 })).toBe('respond');
    expect(routeFailure({ kind: 'invalid_request', status: 500 })).toBe('next_candidate');
    expect(routeFailure({})).toBe('next_candidate');
  });

  it('全败终结分类：无错误/预算/限流族 = 渠道面竭尽；其余上游故障', () => {
    expect(isChannelExhausted(null)).toBe(true);
    expect(isChannelExhausted()).toBe(true);
    expect(isChannelExhausted('channel_budget_exhausted')).toBe(true);
    expect(isChannelExhausted('rate_limit_exceeded')).toBe(true);
    expect(isChannelExhausted('rate_limited')).toBe(true);
    expect(isChannelExhausted('upstream_error')).toBe(false);
  });

  it('B13 回归：全渠道熔断/死凭据竭尽归渠道面（no_available_channel 503，非 upstream_failed 502）', () => {
    // health.admit 拒绝码 circuit_open/dead_credential
    // 是网关侧保护动作（未发出上游请求），全败时不得误归上游故障 502
    expect(isChannelExhausted('circuit_open')).toBe(true);
    expect(isChannelExhausted('dead_credential')).toBe(true);
  });

  it('健康词表与 ai 机制位派生表不漂移（closed vocabulary 契约）', () => {
    // circuitTrip=true 的 kind 必属可换词表（熔断跳闸的错误必可换渠）
    for (const [kind, m] of Object.entries(KIND_MECHANICS)) {
      if (m.circuitTrip || m.deadCredential) {
        expect(isChannelSwitchable(kind)).toBe(true);
      }
    }
  });
});
