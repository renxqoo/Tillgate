import { describe, expect, it } from 'vitest';
import { generateRedeemCode, maskUpstreamKey } from '../src/security/secrets';

/** api-key/app 生成器与 sha256Hex/maskKey 已随消费者迁入 @tillgate/accounts(C5/D3);
 *  本文件只留 http 仍持有的兑换码与上游 Key 脱敏。 */

describe('generateRedeemCode', () => {
  it('RC- 前缀 + 32 base32 字符(Crockford 字符集)', () => {
    const c = generateRedeemCode();
    expect(c.startsWith('RC-')).toBe(true);
    const body = c.slice(3);
    expect(body).toHaveLength(32);
    expect(body).toMatch(/^[0-9A-HJ-NP-TV-Z]+$/);
  });
  it('每次生成都不同(随机)', () => {
    expect(generateRedeemCode()).not.toBe(generateRedeemCode());
  });
});

describe('maskUpstreamKey(上游渠道 Key,前 4 + 后 4)', () => {
  it('标准 sk- key', () => {
    expect(maskUpstreamKey('sk-abcdef0123456789xyz')).toBe('sk-a****9xyz');
  });
  it('短输入 → ****', () => {
    expect(maskUpstreamKey('short')).toBe('****');
  });
});
