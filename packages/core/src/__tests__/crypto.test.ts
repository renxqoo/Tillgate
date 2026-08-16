import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../crypto.js';

/**
 * 加密轮换（双 key 窗）语义：
 *   - 单 key 常态：v1 密文，当前 key 可解
 *   - 窗口期：新密文 enc:v2（当前 key）；存量 v1 用 OLD 解密
 *   - 收窗后：OLD 移除，v2 用当前 key，v1 已全部迁移
 */
const K1 = 'old-encryption-key-32-chars-minimum!!';
const K2 = 'new-encryption-key-32-chars-minimum!!';

describe('AES-GCM 双 key 轮换窗', () => {
  it('单 key 常态：v1 加解密往返', () => {
    const packed = encrypt('secret-upstream-key', K1);
    expect(packed.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(packed, K1)).toBe('secret-upstream-key');
  });

  it('窗口期：新写 v2（新 key）；存量 v1 用 OLD 解密', () => {
    const legacy = encrypt('legacy-value', K1); // v1
    const fresh = encrypt('fresh-value', K2, 2); // 窗口期新密文
    expect(fresh.startsWith('enc:v2:')).toBe(true);
    expect(decrypt(legacy, K2, K1)).toBe('legacy-value');
    expect(decrypt(fresh, K2, K1)).toBe('fresh-value');
  });

  it('收窗后：v2 用当前 key 解密（OLD 已移除）', () => {
    const migrated = encrypt('migrated', K2, 2);
    expect(decrypt(migrated, K2)).toBe('migrated');
  });

  it('v1 在窗口期用错误 OLD → GCM 认证失败（不静默解出垃圾）', () => {
    const legacy = encrypt('legacy-value', K1);
    expect(() => decrypt(legacy, K2, 'wrong-old-key-32-chars-minimum!!!')).toThrow();
  });

  it('篡改密文 → 认证失败', () => {
    const packed = encrypt('x', K1);
    const tampered = packed.slice(0, -4) + '0000';
    expect(() => decrypt(tampered, K1)).toThrow();
  });
});
