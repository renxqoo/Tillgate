import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalVoucherStorage } from './voucher-storage.js';

/**
 * B:vouchers —— 凭证存储白名单单测（实弹脚本 24 已覆盖穿越攻击面，这里锁实现语义）：
 *   - save 生成 key（uuid.ext 形态），load 往返一致
 *   - 穿越形态（../、绝对路径、反斜杠、多段）→ null（不存在）
 */

const dir = mkdtempSync(join(tmpdir(), 'voucher-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createLocalVoucherStorage（B:vouchers）', () => {
  it('save → load 往返；key 白名单外一律 null', async () => {
    const storage = createLocalVoucherStorage(dir);
    const key = await storage.save(Buffer.from('voucher-bytes'), 'image/png');
    expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);

    const loaded = await storage.load(key);
    expect(loaded?.mimeType).toBe('image/png');
    expect(Buffer.from(loaded!.data).toString()).toBe('voucher-bytes');

    const evil = [
      '..%2F..%2Fetc%2Fpasswd',
      '../../etc/passwd',
      '/etc/passwd',
      'a/../../etc/passwd',
      '..\\..\\windows\\win.ini',
      'x'.repeat(36) + '.png/../../../etc/passwd',
      '',
    ];
    for (const k of evil) {
      expect(await storage.load(k), `key=${k}`).toBeNull();
    }
  });
});
