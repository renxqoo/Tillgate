import { createHash, randomBytes } from 'node:crypto';

/**
 * 一次性密钥生成工具（requirements 4.8 充值码 / 4.2 虚拟 Key / App secret）。
 *
 * 安全设计（data-model §1.2）：
 *   - 明文只在创建/生成时下发一次
 *   - 落库只存 SHA-256 哈希（防反查 / 防重放）
 *   - 鉴权/兑换时对输入明文再次哈希后比对（常数时间由 DB 唯一索引保证命中唯一）
 *
 * 纯函数、无 I/O，便于单测。
 */

/** SHA-256 → 64 位 hex 字符串 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 生成充值码明文。
 * 格式：RC-<32 base32 字符>（去掉易混字符 0/O/I/1），带前缀便于人眼识别为充值码。
 * 熵：32 字符 × 5 bit = 160 bit，远超暴力破解阈值。
 */
const BASE32_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
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
  return 'RC-' + out.slice(0, 32);
}

/**
 * 生成虚拟 Key 明文（ag_ 前缀，requirements 4.2 / api-contract §1）。
 * 格式：ag_<40 hex>（160 bit 熵）。
 */
export function generateApiKey(): string {
  return 'ag_' + randomBytes(20).toString('hex');
}

/**
 * 生成 App client_id / client_secret（requirements 4.2）。
 * - client_id：app_<16hex>，对外公共标识
 * - client_secret：<48hex>，仅下发一次，落库哈希
 */
export function generateClientId(): string {
  return 'app_' + randomBytes(8).toString('hex');
}
export function generateClientSecret(): string {
  return randomBytes(24).toString('hex');
}

/**
 * 生成展示用 Key 脱敏预览：保留前缀 + 末 4 位（data-model §3.3）。
 * 例：ag_abc...xyz → ag_****xyz（保持 8 位固定长度便于对齐）。
 */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return plaintext.slice(0, 3) + '****' + plaintext.slice(-4);
}
