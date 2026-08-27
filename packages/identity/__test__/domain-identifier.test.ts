/**
 * 标识域测试:归一化矩阵、词表白名单、
 * userId/subject 断言、注入片段与控制字符拒绝。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_IDENTIFIER_KINDS,
  VOCAB_RE,
  assertOAuthSubject,
  assertUserId,
  guardChallengeKind,
  guardIdentifierKind,
  guardProvider,
  guardRealm,
  isUuidLike,
  normalizeDisplayEmail,
  normalizeIdentifier,
  type ValidationGuards,
} from '../src/domain/identifier.js';
import { resolveConfig } from '../src/domain/config.js';
import { TEST_CONFIG } from '../src/testing/harness.js';

const { guards } = resolveConfig(TEST_CONFIG);

/** 捕获目录业务错误并断言码(message 是目录固定文案,动态事实在 context) */
function catchCode(fn: () => unknown): { code: string; context: Record<string, unknown> } {
  try {
    fn();
  } catch (error) {
    const business = error as { code?: string; context?: Record<string, unknown> };
    if (typeof business.code === 'string') {
      return { code: business.code, context: business.context ?? {} };
    }
    throw error;
  }
  throw new Error('expected identity business error, nothing thrown');
}

describe('标识归一化矩阵(表驱动)', () => {
  const cases: Array<{ kind: string; raw: string; expected: string | null }> = [
    { kind: 'email', raw: '  User@Example.COM ', expected: 'user@example.com' },
    { kind: 'email', raw: 'not-an-email', expected: null },
    { kind: 'email', raw: 'a@b', expected: null },
    { kind: 'email', raw: "a' OR '1'='1@example.com", expected: null },
    { kind: 'email', raw: 'a\x00b@example.com', expected: null },
    { kind: 'phone', raw: '+86 138-0013.(8000)', expected: '+8613800138000' },
    { kind: 'phone', raw: '13800138000', expected: '13800138000' },
    { kind: 'phone', raw: 'abc', expected: null },
    { kind: 'phone', raw: '123', expected: null },
    { kind: 'username', raw: ' alice_dev ', expected: 'alice_dev' },
    { kind: 'username', raw: 'ab', expected: null },
    { kind: 'username', raw: 'a'.repeat(65), expected: null },
    { kind: 'username', raw: 'has space', expected: null },
  ];
  for (const { kind, raw, expected } of cases) {
    it(`${kind} '${raw}' → ${expected ?? '拒绝'}`, () => {
      if (expected == null) {
        expect(() => normalizeIdentifier({ kind, value: raw }, guards)).toThrow();
      } else {
        expect(normalizeIdentifier({ kind, value: raw }, guards)).toEqual({
          kind,
          value: expected,
        });
      }
    });
  }

  it('value 非字符串不 TypeError(统一 invalid_identifier)', () => {
    expect(
      catchCode(() =>
        normalizeIdentifier({ kind: 'email', value: 123 as unknown as string }, guards),
      ).code,
    ).toBe('identity.invalid_identifier');
  });
});

describe('词表白名单(fail-closed)', () => {
  it('白名单外内置 kind → unknown_identifier_kind(带 allowed)', () => {
    const narrow: ValidationGuards = { ...guards, identifierKinds: new Set(['email']) };
    try {
      guardIdentifierKind('phone', narrow);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('identity.unknown_identifier_kind');
      expect((error as { context?: { allowed?: string[] } }).context?.allowed).toEqual(['email']);
    }
  });

  it('内置词表之外一律拒绝(即使白名单声明)', () => {
    const wide: ValidationGuards = {
      ...guards,
      identifierKinds: new Set(['email', 'carrier-pigeon']),
    };
    expect(catchCode(() => guardIdentifierKind('carrier-pigeon' as never, wide)).code).toBe(
      'identity.unknown_identifier_kind',
    );
    expect(BUILTIN_IDENTIFIER_KINDS).toEqual(['email', 'phone', 'username']);
  });

  it('provider/challengeKind/realm 词表 + 形状', () => {
    expect(guardProvider('github', guards)).toBe('github');
    expect(catchCode(() => guardProvider('gitlab', guards)).code).toBe('identity.unknown_provider');
    expect(catchCode(() => guardProvider('Bad Name', guards)).code).toBe('identity.invalid_input');
    expect(guardChallengeKind('user_login_code', guards)).toBe('user_login_code');
    expect(catchCode(() => guardChallengeKind('user_reset_code', guards)).code).toBe(
      'identity.unknown_challenge_kind',
    );
    expect(guardRealm('admin', guards)).toBe('admin');
    expect(catchCode(() => guardRealm('root', guards)).code).toBe('identity.unknown_realm');
    expect(VOCAB_RE.test('a-b_2')).toBe(true);
    expect(VOCAB_RE.test('A')).toBe(false);
    expect(VOCAB_RE.test('a')).toBe(false);
  });
});

describe('userId / subject / display email 断言', () => {
  it('userId 矩阵:0/负/小数/字符串/NaN 拒,正整数过', () => {
    expect(assertUserId(1)).toBe(1);
    for (const bad of [0, -1, 1.5, '3', Number.NaN]) {
      expect(catchCode(() => assertUserId(bad)).code).toBe('identity.invalid_user_id');
    }
  });

  it('subject:trim 后 1-255', () => {
    expect(assertOAuthSubject('  12345  ')).toBe('12345');
    expect(catchCode(() => assertOAuthSubject('')).code).toBe('identity.invalid_subject');
    expect(catchCode(() => assertOAuthSubject('x'.repeat(256))).code).toBe(
      'identity.invalid_subject',
    );
    expect(catchCode(() => assertOAuthSubject(42 as unknown as string)).code).toBe(
      'identity.invalid_input',
    );
  });

  it('display email:轻校验,空→null,超长拒', () => {
    expect(normalizeDisplayEmail(null)).toBeNull();
    expect(normalizeDisplayEmail('  ')).toBeNull();
    expect(normalizeDisplayEmail('UP@Example.com')).toBe('up@example.com');
    expect(() => normalizeDisplayEmail('x'.repeat(256))).toThrow();
  });

  it('uuid 形状大小写不限', () => {
    expect(isUuidLike('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
    expect(isUuidLike('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')).toBe(true);
    expect(isUuidLike('not-a-uuid')).toBe(false);
  });
});
