/**
 * 挑战域测试:码哈希 HMAC 已知向量、参数覆盖界、payload 域、恢复码哈希、
 * 通道映射;配置解析 fail-fast(坏配置同步即抛)。
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CHALLENGE_BOUNDS,
  boundedOverride,
  channelFor,
  codeHashOf,
  randomCode,
  recoveryCodeHashOf,
  serializePayload,
} from '../src/domain/challenge.js';
import { resolveConfig, type IdentityConfigInput } from '../src/domain/config.js';
import { TEST_CONFIG } from '../src/testing/harness.js';
import { assertSessionTtlSec } from '../src/domain/session.js';

const PEPPER = 'test-pepper-0123456789abcdef';

/** 捕获目录业务错误并断言码(message 是目录固定文案) */
function catchCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const business = error as { code?: string };
    if (typeof business.code === 'string') return business.code;
    throw error;
  }
  throw new Error('expected identity business error, nothing thrown');
}

describe('码哈希(B13:HMAC pepper,同码不同行哈希不同)', () => {
  it('HMAC-SHA256 已知向量', () => {
    const expected = createHmac('sha256', PEPPER).update('123456:challenge-a').digest('hex');
    expect(codeHashOf('123456', 'challenge-a', PEPPER)).toBe(expected);
    expect(codeHashOf('123456', 'challenge-b', PEPPER)).not.toBe(expected);
  });

  it('恢复码哈希与挑战码同一 pepper 口径', () => {
    const expected = createHmac('sha256', PEPPER).update('ABCDEFGHJK').digest('hex');
    expect(recoveryCodeHashOf('ABCDEFGHJK', PEPPER)).toBe(expected);
  });

  it('随机码:位数与前导零', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(randomCode(6)).toMatch(/^[0-9]{6}$/);
    }
  });
});

describe('参数覆盖界(v1 语义:值在界内用值,越界拒)', () => {
  it('未给用缺省', () => {
    expect(boundedOverride(undefined, 300_000, 'ttlMs', 1_000, 86_400_000)).toBe(300_000);
  });

  it('越界拒绝(表驱动)', () => {
    const [ttlMin, ttlMax] = CHALLENGE_BOUNDS.ttlMs;
    const [cdMin, cdMax] = CHALLENGE_BOUNDS.cooldownMs;
    const [maMin, maMax] = CHALLENGE_BOUNDS.maxAttempts;
    for (const [value, min, max] of [
      [999, ttlMin, ttlMax],
      [86_400_001, ttlMin, ttlMax],
      [-1, cdMin, cdMax],
      [3_600_001, cdMin, cdMax],
      [0, maMin, maMax],
      [101, maMin, maMax],
      [1.5, maMin, maMax],
    ] as const) {
      expect(catchCode(() => boundedOverride(value, 1, 'x', min, max))).toBe(
        'identity.invalid_input',
      );
    }
    expect(boundedOverride(0, 60_000, 'cooldownMs', cdMin, cdMax)).toBe(0);
  });
});

describe('payload 域', () => {
  it('null 透传,≤4KB 可序列化通过,超限拒,循环引用拒', () => {
    expect(serializePayload(null)).toBeNull();
    expect(serializePayload({ a: 1 })).toEqual({ a: 1 });
    expect(serializePayload({ big: 'x'.repeat(4080) })).toMatchObject({ big: expect.any(String) });
    expect(catchCode(() => serializePayload({ big: 'x'.repeat(4100) }))).toBe(
      'identity.invalid_input',
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(catchCode(() => serializePayload(circular))).toBe('identity.invalid_input');
  });
});

describe('投递通道映射', () => {
  it('email→email,phone→sms,username→null', () => {
    expect(channelFor('email')).toBe('email');
    expect(channelFor('phone')).toBe('sms');
    expect(channelFor('username')).toBeNull();
  });
});

describe('会话 TTL 界', () => {
  it('60..2592000 整数,越界拒', () => {
    expect(assertSessionTtlSec(86_400)).toBe(86_400);
    expect(() => assertSessionTtlSec(59)).toThrow();
    expect(() => assertSessionTtlSec(2_592_001)).toThrow();
    expect(() => assertSessionTtlSec(1.5)).toThrow();
  });
});

describe('配置解析 fail-fast(v1 security「坏配置 createIdentity 同步即抛」随迁)', () => {
  const bad: Array<[string, Partial<IdentityConfigInput>]> = [
    ['空标识词表', { identifiers: [] }],
    ['词表外标识', { identifiers: ['email', 'carrier'] }],
    ['空挑战词表', { challengeKinds: [] }],
    ['词表重复', { realms: ['user', 'user'] }],
    ['词表形状非法', { providers: ['GitHub'] }],
    [
      '挑战数字位数越界',
      { challenge: { digits: 5, ttlMs: 300_000, cooldownMs: 60_000, maxAttempts: 5 } },
    ],
    ['挑战越界', { challenge: { digits: 6, ttlMs: 100, cooldownMs: 60_000, maxAttempts: 5 } }],
    [
      '冷却越界',
      { challenge: { digits: 6, ttlMs: 300_000, cooldownMs: 9_999_999, maxAttempts: 5 } },
    ],
    ['错次越界', { challenge: { digits: 6, ttlMs: 300_000, cooldownMs: 60_000, maxAttempts: 0 } }],
    ['pepper 太短', { codePepper: 'short' }],
    ['totp 步长越界', { totp: { issuer: 't', stepSec: 3, windowSteps: 1, recoveryCount: 10 } }],
    ['totp 恢复码数越界', { totp: { issuer: 't', stepSec: 30, windowSteps: 1, recoveryCount: 0 } }],
    [
      'session realm 未声明',
      { sessions: { root: { issuer: 'i', secret: 's'.repeat(20), ttlSec: 60 } } },
    ],
    ['session 密钥太短', { sessions: { user: { issuer: 'i', secret: 'short', ttlSec: 86_400 } } }],
    [
      'session ttl 越界',
      { sessions: { user: { issuer: 'i', secret: 's'.repeat(20), ttlSec: 10 } } },
    ],
    ['realm 无 session 配置', { realms: ['user', 'admin', 'service'] }],
    // oauth 快照内容校验已迁至解析期(动词调用)——见 application-oauth.test.ts
    ['oauth 非 getter', { oauth: { github: { clientId: 'a', clientSecret: 'b' } } as never }],
    ['state ttl 越界', { oauthStateTtlSec: 10 }],
    ['redirect 白名单空', { oauthRedirectAllowlist: [] }],
    ['redirect 非绝对 URL', { oauthRedirectAllowlist: ['/relative/cb'] }],
    ['redirect 带 query', { oauthRedirectAllowlist: ['https://cb?x=1'] }],
    ['redirect 带 fragment', { oauthRedirectAllowlist: ['https://cb#f'] }],
    ['redirect 非 http(s)', { oauthRedirectAllowlist: ['ftp://cb'] }],
    [
      'redirect 重复项',
      {
        oauthRedirectAllowlist: ['https://cb', 'https://cb'],
      },
    ],
  ];
  for (const [name, patch] of bad) {
    it(name, () => {
      expect(() => resolveConfig({ ...TEST_CONFIG, ...patch } as IdentityConfigInput)).toThrow();
    });
  }

  it('合法配置解析通过且词表全集', () => {
    const resolved = resolveConfig(TEST_CONFIG);
    expect([...resolved.guards.realms].toSorted()).toEqual(['admin', 'user']);
    expect(resolved.config.oauthStateTtlSec).toBe(600);
  });
});
