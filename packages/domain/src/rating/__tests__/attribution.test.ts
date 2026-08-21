/**
 * 估算归属映射（streamEstimateAttribution）单一真相锁定：
 * relay 层 terminated 值域 → 估算计费归属值的映射表。归属值同时是
 * ESTIMATE_ATTRIBUTIONS 白名单成员（signal/worker 两端验收）与
 * usage_logs.estimate_reason 报表标签——供应商质量、上游故障率、
 * 网关停机三类单必须可区分（2026-08-21 归属细分决策）。
 */
import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_ATTRIBUTIONS,
  streamEstimateAttribution,
  USER_SIDE_CANCELS,
} from '../types.js';

describe('streamEstimateAttribution（terminated → 估算归属映射）', () => {
  it('正常完成缺 usage：terminated 缺省 → usage_missing_completed', () => {
    expect(streamEstimateAttribution(undefined)).toBe('usage_missing_completed');
  });

  it('用户侧取消三态归一 → client_disconnect（历史口径不变）', () => {
    for (const reason of USER_SIDE_CANCELS) {
      expect(streamEstimateAttribution(reason)).toBe('client_disconnect');
    }
  });

  it('上游故障截断三态 + 未知终止 → upstream_error_partial（部分交付计费）', () => {
    expect(streamEstimateAttribution('upstream_error')).toBe('upstream_error_partial');
    expect(streamEstimateAttribution('upstream_disconnected')).toBe('upstream_error_partial');
    expect(streamEstimateAttribution('upstream_truncated')).toBe('upstream_error_partial');
    // 防御性兜底：任何非用户侧终止都不是「完成」——未知值不得回落 usage_missing_completed
    expect(streamEstimateAttribution('some_future_reason')).toBe('upstream_error_partial');
  });

  it('闲置超时 → inactivity_timeout（网关侧掐流，处置方与供应商故障不同）', () => {
    expect(streamEstimateAttribution('inactivity')).toBe('inactivity_timeout');
  });

  it('网关停机切流 → server_draining（平台自身行为，可独立补偿/报表）', () => {
    expect(streamEstimateAttribution('server_draining')).toBe('server_draining');
  });

  it('全部产出值必须属于 ESTIMATE_ATTRIBUTIONS 白名单（否则结算死信）', () => {
    const terminalValues = [
      undefined,
      ...USER_SIDE_CANCELS,
      'upstream_error',
      'upstream_disconnected',
      'upstream_truncated',
      'inactivity',
      'server_draining',
      'some_future_reason',
    ];
    for (const terminated of terminalValues) {
      expect(ESTIMATE_ATTRIBUTIONS).toContain(streamEstimateAttribution(terminated));
    }
  });
});
