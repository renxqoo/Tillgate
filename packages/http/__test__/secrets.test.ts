import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  generateClientId,
  generateClientSecret,
  generateRedeemCode,
  maskKey,
  maskUpstreamKey,
  sha256Hex,
} from '../src/security/secrets';

/** v1 secrets.test 全部迁移；generateApiKey 改必填前缀（B5 零写死修正） */

describe('sha256Hex', () => {
  it('标准向量', () => {
    // sha256('') = e3b0c442...
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('长度恒为 64 hex 且确定', () => {
    expect(sha256Hex('anything')).toHaveLength(64);
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
  });
});

describe('generateRedeemCode', () => {
  it('RC- 前缀 + 32 base32 字符（Crockford 字符集）', () => {
    const c = generateRedeemCode();
    expect(c.startsWith('RC-')).toBe(true);
    const body = c.slice(3);
    expect(body).toHaveLength(32);
    expect(body).toMatch(/^[0-9A-HJ-NP-TV-Z]+$/);
  });
  it('每次生成都不同（随机）', () => {
    expect(generateRedeemCode()).not.toBe(generateRedeemCode());
  });
});

describe('generateApiKey（前缀必填注入）', () => {
  it('<prefix> + 40 hex（160 bit 熵）', () => {
    const k = generateApiKey('ag_');
    expect(k.startsWith('ag_')).toBe(true);
    expect(k.slice(3)).toHaveLength(40);
    expect(k.slice(3)).toMatch(/^[0-9a-f]+$/);
  });
  it('部署自定义前缀原样生效', () => {
    expect(generateApiKey('tk-').startsWith('tk-')).toBe(true);
  });
});

describe('generateClientId / generateClientSecret', () => {
  it('client_id: app_ 前缀 + 16 hex', () => {
    const id = generateClientId();
    expect(id.startsWith('app_')).toBe(true);
    expect(id.slice(4)).toHaveLength(16);
  });
  it('client_secret: 48 hex', () => {
    expect(generateClientSecret()).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('maskKey（虚拟 Key，前 3 + 后 4）', () => {
  it('标准 ag_ key', () => {
    expect(maskKey('ag_abcdef0123456789xyz')).toBe('ag_****9xyz');
  });
  it('短输入（≤8）→ ****', () => {
    expect(maskKey('short')).toBe('****');
    expect(maskKey('12345678')).toBe('****');
  });
  it('刚好 9 字符 → 正常脱敏（边界）', () => {
    expect(maskKey('123456789')).toBe('123****6789');
  });
});

describe('maskUpstreamKey（上游渠道 Key，前 4 + 后 4）', () => {
  it('标准 sk- key', () => {
    expect(maskUpstreamKey('sk-abcdef0123456789xyz')).toBe('sk-a****9xyz');
  });
  it('短输入 → ****', () => {
    expect(maskUpstreamKey('short')).toBe('****');
  });
});
