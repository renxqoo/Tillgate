import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_ATTRIBUTIONS,
  USER_SIDE_CANCELS,
  isAttributedEstimate,
  streamEstimateAttribution,
} from '../src/domain/usage/attribution';

describe('domain/usage/attribution：估算归属词表与流式归属单一真相', () => {
  it('词表封闭性：用户取消三态归一 + 完成缺 usage + 部分交付细分', () => {
    expect([...ESTIMATE_ATTRIBUTIONS]).toEqual([
      'client_disconnect',
      'request_cancelled',
      'aborted',
      'usage_missing_completed',
      'usage_missing_nonstream',
      'upstream_error_partial',
      'inactivity_timeout',
      'server_draining',
    ]);
    expect([...USER_SIDE_CANCELS]).toEqual(['client_disconnect', 'request_cancelled', 'aborted']);
  });

  it('terminated 矩阵：undefined=完成缺 usage；用户侧三态归一 client_disconnect', () => {
    expect(streamEstimateAttribution(undefined)).toBe('usage_missing_completed');
    expect(streamEstimateAttribution('client_disconnect')).toBe('client_disconnect');
    expect(streamEstimateAttribution('request_cancelled')).toBe('client_disconnect');
    expect(streamEstimateAttribution('aborted')).toBe('client_disconnect');
  });

  it('terminated 矩阵：inactivity/server_draining 分标签；未知值防御性归 upstream_error_partial', () => {
    expect(streamEstimateAttribution('inactivity')).toBe('inactivity_timeout');
    expect(streamEstimateAttribution('server_draining')).toBe('server_draining');
    expect(streamEstimateAttribution('upstream_truncated')).toBe('upstream_error_partial');
    expect(streamEstimateAttribution('future_unknown_reason')).toBe('upstream_error_partial');
  });

  it('isAttributedEstimate：白名单外的估算收据一律拒绝（不开后门）', () => {
    expect(
      isAttributedEstimate({ usage: { estimated: true }, estimatedFor: 'client_disconnect' }),
    ).toBe(true);
    expect(isAttributedEstimate({ usage: { estimated: true }, estimatedFor: 'nope' })).toBe(false);
    expect(isAttributedEstimate({ usage: { estimated: true } })).toBe(false);
    expect(isAttributedEstimate({ usage: { estimated: false } })).toBe(false);
  });
});
