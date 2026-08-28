/**
 * 一次性密钥生成与哈希组件(只做生成与哈希;加密由 runtime createCipher 的
 * enc:v1 信封承担,http 不得依赖 runtime)。
 *
 * 安全设计:
 *   - 明文只在创建/生成时下发一次
 *   - 落库只存哈希(防反查 / 防重放)
 *   - 鉴权/兑换时对输入明文再次哈希后比对
 *
 * 纯函数、无 I/O(node:crypto 随机数除外),便于单测。
 */

import { randomBytes } from 'node:crypto';

/** Crockford 字符集(去掉易混字符 0/O/I/1) */
const BASE32_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 生成充值码明文:RC-<32 base32 字符>,熵 32 × 5 bit = 160 bit */
export function generateRedeemCode(): string {
  const bytes = randomBytes(20); // 160 bit
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_CROCKFORD[(value << (5 - bits)) & 31];
  return `RC-${out.slice(0, 32)}`;
}

/**
 * 上游渠道 Key 脱敏(无固定前缀,多展示一位头部便于区分供应商)。
 * 例:sk-abcdef0123xyz → sk-a****3xyz
 */
export function maskUpstreamKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return `${plaintext.slice(0, 4)}****${plaintext.slice(-4)}`;
}
