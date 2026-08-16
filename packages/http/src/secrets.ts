import { createHash, randomBytes } from 'node:crypto';
import { encrypt } from '@ai-gateway/core';

/**
 * 一次性密钥生成与哈希组件（requirements 4.8 充值码 / 4.2 虚拟 Key / App secret）。
 *
 * 安全设计（data-model §1.2）：
 *   - 明文只在创建/生成时下发一次
 *   - 落库只存 SHA-256 哈希（防反查 / 防重放）
 *   - 鉴权/兑换时对输入明文再次哈希后比对
 *
 * 纯函数、无 I/O，便于单测。
 */

/**
 * 用「当前」加密世代落库（加密版本选择的单一入口）：
 *   - 常态（未设 oldKey）→ v1（v1 即当前 key）
 *   - 密钥轮换窗（oldKey 已设置）→ 新密文一律写 v2（用当前 key）
 * 解密侧由 core.decrypt 按 v1/v2 前缀自动选 key；此处只决定「新写入用哪代」。
 */
export function encryptCurrent(plaintext: string, encryptionKey: string, oldKey?: string | null): string {
  return encrypt(plaintext, encryptionKey, oldKey ? 2 : 1);
}

/** SHA-256 → 64 位 hex 字符串 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 生成充值码明文。
 * 格式：RC-<32 base32 字符>（Crockford 字符集，去掉易混字符 0/O/I/1），带前缀便于人眼识别。
 * 熵：32 字符 × 5 bit = 160 bit。
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

/** 生成虚拟 Key 明文：ag_<40 hex>（160 bit 熵，requirements 4.2 / api-contract §1） */
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
 * 虚拟 Key 脱敏预览：保留前缀 3 位 + 末 4 位（data-model §3.3）。
 * 例：ag_abcdef0123456789xyz → ag_****9xyz
 */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return plaintext.slice(0, 3) + '****' + plaintext.slice(-4);
}

/**
 * 上游渠道 Key 脱敏（无固定前缀，多展示一位头部便于区分供应商）。
 * 例：sk-abcdef0123xyz → sk-a****3xyz
 */
export function maskUpstreamKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return plaintext.slice(0, 4) + '****' + plaintext.slice(-4);
}
