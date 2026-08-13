/**
 * 密钥轮换脚本：用旧 ENCRYPTION_KEY 解密所有渠道 → 用新 key 重新加密 → 写回 DB。
 * 用法：pnpm --filter @ai-gateway/db exec tsx ../../scripts/rotate-encryption-key.ts
 * 环境：ENCRYPTION_KEY_OLD=<旧key> ENCRYPTION_KEY_NEW=<新key>
 */
import { encrypt, decrypt } from '@ai-gateway/core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 加载 .env
let dir = process.cwd();
for (let i = 0; i < 6; i++) {
  const f = resolve(dir, '.env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
    break;
  }
  dir = resolve(dir, '..');
}

const OLD_KEY = process.env.ENCRYPTION_KEY_OLD;
const NEW_KEY = process.env.ENCRYPTION_KEY_NEW;
if (!OLD_KEY || OLD_KEY.length < 32) {
  console.error('✗ ENCRYPTION_KEY_OLD 未设置或不足 32 字符（必须显式传入旧密钥，无默认值）');
  process.exit(1);
}
if (!NEW_KEY || NEW_KEY.length < 32) {
  console.error('✗ ENCRYPTION_KEY_NEW 未设置或不足 32 字符');
  process.exit(1);
}

async function main(): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client(process.env.DATABASE_URL);
  await client.connect();
  const { rows } = await client.query('SELECT id, name, api_key_enc FROM channels ORDER BY id');
  console.log(
    `找到 ${rows.length} 个渠道，开始轮换 (old=${OLD_KEY.slice(0, 8)}... → new=${NEW_KEY.slice(0, 8)}...)`,
  );
  let ok = 0;
  let fail = 0;
  for (const ch of rows) {
    try {
      const plain = decrypt(ch.api_key_enc, OLD_KEY);
      const newEnc = encrypt(plain, NEW_KEY);
      await client.query('UPDATE channels SET api_key_enc = $1 WHERE id = $2', [newEnc, ch.id]);
      console.log(`  ✓ id=${ch.id} ${ch.name} (明文: ${plain.slice(0, 6)}...)`);
      ok++;
    } catch (e) {
      console.log(`  ✗ id=${ch.id} ${ch.name}: ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`轮换完成: 成功 ${ok} 失败 ${fail}`);
  await client.end();
}
void main();
