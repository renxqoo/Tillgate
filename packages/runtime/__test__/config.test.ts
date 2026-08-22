import { describe, expect, it } from 'vitest';
import { secretSchema, strictBooleanSchema } from '../src/config/env-schemas';

describe('secretSchema（密钥三道门）', () => {
  it('拒绝已知弱密钥、短密钥和低多样性密钥', () => {
    const schema = secretSchema('TEST_SECRET', 16);
    expect(() => schema.parse('passwordpassword')).toThrow();
    expect(() => schema.parse('short')).toThrow();
    expect(() => schema.parse('aaaaaaaaaaaaaaaa')).toThrow();
    expect(schema.parse('strong-secret-1234')).toBe('strong-secret-1234');
  });
});

describe('strictBooleanSchema', () => {
  it('布尔值只接受 true/false，字符串 false 不得变成 true', () => {
    const schema = strictBooleanSchema(true);
    expect(schema.parse('false')).toBe(false);
    expect(schema.parse('true')).toBe(true);
    expect(schema.parse(false)).toBe(false);
    expect(schema.parse(true)).toBe(true);
    expect(() => schema.parse('yes')).toThrow();
  });

  it('缺省值生效（未设置时取装配默认）', () => {
    expect(strictBooleanSchema(true).parse(undefined)).toBe(true);
    expect(strictBooleanSchema(false).parse(undefined)).toBe(false);
  });
});
