/** 白名单守卫与标识归一化：fail-closed 词表 + 归一形态（大小写/分隔符不得分裂账号） */
import { describe, expect, it } from 'vitest';
import {
  assertOAuthSubject,
  assertUserId,
  buildGuards,
  guardChallengeKind,
  guardProvider,
  normalizeIdentifier,
} from '../validation';
import {
  InvalidIdentifierError,
  InvalidInputError,
  InvalidUserIdError,
  UnknownChallengeKindError,
  UnknownIdentifierKindError,
  UnknownProviderError,
} from '../errors';

const guards = buildGuards({
  identifiers: ['email'],
  providers: ['github'],
  challenges: ['email_code'],
  realms: ['user'],
});
const wideGuards = buildGuards({
  identifiers: ['email', 'phone', 'username'],
  providers: ['github', 'google'],
  challenges: ['email_code', 'password_reset'],
  realms: ['user', 'admin'],
});

describe('guardIdentifierKind（fail-closed 白名单）', () => {
  it('白名单外的内置 kind → UnknownIdentifierKindError（带 allowed）', () => {
    expect(() => normalizeIdentifier({ kind: 'phone', value: '13800138000' }, guards)).toThrow(
      UnknownIdentifierKindError,
    );
    try {
      normalizeIdentifier({ kind: 'phone', value: '13800138000' }, guards);
    } catch (error) {
      expect((error as UnknownIdentifierKindError).allowed).toEqual(['email']);
    }
  });

  it('内置词表之外的 kind 一律拒绝（白名单声明了也无效——扩展=改包发版）', () => {
    expect(() => normalizeIdentifier({ kind: 'weird' as never, value: 'x' }, wideGuards)).toThrow(
      UnknownIdentifierKindError,
    );
  });
});

describe('normalizeIdentifier（归一形态）', () => {
  it('email：trim + 小写', () => {
    expect(normalizeIdentifier({ kind: 'email', value: '  User@Example.COM ' }, wideGuards)).toEqual({
      kind: 'email',
      value: 'user@example.com',
    });
  });

  it('email：坏形状拒绝（无域/空格/超长/空串）', () => {
    for (const bad of ['plain', 'a@b', 'a b@c.com', `a@${'x'.repeat(300)}.com`, '']) {
      expect(() => normalizeIdentifier({ kind: 'email', value: bad }, wideGuards)).toThrow(
        InvalidIdentifierError,
      );
    }
  });

  it('phone：去空格/连字符/括号/点，+ 前缀保留', () => {
    expect(normalizeIdentifier({ kind: 'phone', value: '+86 138-0013-8000' }, wideGuards)).toEqual({
      kind: 'phone',
      value: '+8613800138000',
    });
    expect(normalizeIdentifier({ kind: 'phone', value: '(021) 6543.2100' }, wideGuards)).toEqual({
      kind: 'phone',
      value: '02165432100',
    });
    expect(() => normalizeIdentifier({ kind: 'phone', value: '138abc' }, wideGuards)).toThrow(
      InvalidIdentifierError,
    );
    expect(() => normalizeIdentifier({ kind: 'phone', value: '123' }, wideGuards)).toThrow(
      InvalidIdentifierError,
    );
  });

  it('username：字符集 + 3-64 位（大小写敏感）', () => {
    expect(normalizeIdentifier({ kind: 'username', value: ' alice_01 ' }, wideGuards)).toEqual({
      kind: 'username',
      value: 'alice_01',
    });
    expect(() => normalizeIdentifier({ kind: 'username', value: 'ab' }, wideGuards)).toThrow(
      InvalidIdentifierError,
    );
    expect(() => normalizeIdentifier({ kind: 'username', value: 'has space' }, wideGuards)).toThrow(
      InvalidIdentifierError,
    );
  });

  it('value 非字符串 → InvalidIdentifierError（不裸炸 TypeError）', () => {
    expect(() => normalizeIdentifier({ kind: 'email', value: 123 as never }, wideGuards)).toThrow(
      InvalidIdentifierError,
    );
  });
});

describe('guardProvider / guardChallengeKind', () => {
  it('白名单外 → Unknown*Error（带 allowed）；形状非法 → InvalidInputError', () => {
    expect(() => guardProvider('gitlab', wideGuards)).toThrow(UnknownProviderError);
    expect(() => guardProvider('GitHub', wideGuards)).toThrow(InvalidInputError);
    expect(() => guardChallengeKind('sms_code', wideGuards)).toThrow(UnknownChallengeKindError);
    expect(() => guardChallengeKind('Bad Kind', wideGuards)).toThrow(InvalidInputError);
  });
});

describe('assertUserId / assertOAuthSubject', () => {
  it('正整数通过；0/负/小数/字符串/NaN 拒绝', () => {
    expect(assertUserId(1)).toBe(1);
    for (const bad of [0, -1, 1.5, '7', NaN, null, undefined, Infinity]) {
      expect(() => assertUserId(bad as never)).toThrow(InvalidUserIdError);
    }
  });

  it('subject：trim 后 1-255；空/超长/非字符串拒绝', () => {
    expect(assertOAuthSubject('  octocat  ')).toBe('octocat');
    expect(() => assertOAuthSubject('   ')).toThrow(InvalidInputError);
    expect(() => assertOAuthSubject('x'.repeat(256))).toThrow(InvalidInputError);
    expect(() => assertOAuthSubject(42 as never)).toThrow(InvalidInputError);
  });
});
