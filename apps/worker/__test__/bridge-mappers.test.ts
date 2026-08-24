/**
 * 装配桥接映射直击（bridge-mappers.ts 拆出后无单测——0% 覆盖拖累包门禁，
 * 2026-08-25 补齐）：toBillingEvent 四分支词表直译 + toChannelCandidate 字段搬运。
 * 纯函数无 IO，表驱动逐分支锁定（铁律 16：错误码表/词表用表驱动遍历断言）。
 */
import { describe, expect, it } from 'vitest';
import { toBillingEvent, toChannelCandidate } from '../src/bridge-mappers';
import type { BillingSignal } from '@tillgate/inference';

describe('toBillingEvent：蛇形信号 → 点分事件（四分支穷举）', () => {
  it.each([
    [
      { type: 'upstream_started', requestId: 'r1', leaseOwner: 'w1', leaseMs: 60_000 },
      { type: 'upstream.started', requestId: 'r1', leaseOwner: 'w1', leaseMs: 60_000 },
    ],
    [
      { type: 'lease_renewed', requestId: 'r1', leaseOwner: 'w2', leaseMs: 30_000 },
      { type: 'lease.renewed', requestId: 'r1', leaseOwner: 'w2', leaseMs: 30_000 },
    ],
    [
      {
        type: 'request_succeeded',
        requestId: 'r1',
        receipt: { requestId: 'r1', amount: '0.1' },
      },
      {
        type: 'request.succeeded',
        requestId: 'r1',
        receipt: { requestId: 'r1', amount: '0.1' },
      },
    ],
    [
      { type: 'request_failed', requestId: 'r1', reason: 'upstream_error' },
      { type: 'request.failed', requestId: 'r1', reason: 'upstream_error' },
    ],
  ])('%s → %s', (signal, expected) => {
    expect(toBillingEvent(signal as BillingSignal)).toEqual(expected);
  });
});

describe('toChannelCandidate：渠道行 → 候选形状（字段逐一搬运）', () => {
  it('全量字段直传；baseUrl 取 override 优先', () => {
    const candidate = toChannelCandidate({
      channelId: 7,
      channelName: 'openai-main',
      providerName: 'OpenAI',
      providerProtocol: 'openai-compatible',
      providerVendor: 'openai',
      baseUrlOverride: 'https://override.example.test',
      providerBaseUrl: 'https://api.openai.com',
      apiKeyEnc: 'enc:v1:xxx',
      priority: 1,
      weight: 100,
      rpmLimit: 600,
      tpmLimit: null,
      upstreamBudget: '1000',
    });
    expect(candidate).toEqual({
      channelId: 7,
      channelName: 'openai-main',
      providerName: 'OpenAI',
      protocol: 'openai-compatible',
      vendor: 'openai',
      baseUrl: 'https://override.example.test',
      apiKeyEnc: 'enc:v1:xxx',
      priority: 1,
      weight: 100,
      rpmLimit: 600,
      tpmLimit: null,
      upstreamBudget: '1000',
    });
  });
  it('无 override → baseUrl 回落供应商地址', () => {
    const candidate = toChannelCandidate({
      channelId: 8,
      channelName: 'deepseek',
      providerName: null,
      providerProtocol: 'openai-compatible',
      providerVendor: null,
      baseUrlOverride: null,
      providerBaseUrl: 'https://api.deepseek.com',
      apiKeyEnc: 'enc:v1:yyy',
      priority: 2,
      weight: 50,
      rpmLimit: null,
      tpmLimit: null,
      upstreamBudget: '0',
    });
    expect(candidate.baseUrl).toBe('https://api.deepseek.com');
    expect(candidate.providerName).toBeNull();
    expect(candidate.vendor).toBeNull();
  });
});
