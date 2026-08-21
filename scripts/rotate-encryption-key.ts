/**
 * 渠道上游 Key 加密轮换（双 key 窗设计，事务化）。
 *
 * 流程（运维照做）：
 *   1. 生成新密钥（openssl rand -hex 32）。编辑 .env：
 *        ENCRYPTION_KEY_OLD=<现在的 ENCRYPTION_KEY>   ← 打开双 key 窗
 *        ENCRYPTION_KEY=<新密钥>
 *   2. 重启 gateway + admin-api（新写入走 enc:v2，存量 v1 用 OLD 解密，服务不中断）。
 *   3. 运行本脚本：把 channels.api_key_enc 存量 enc:v1 行事务化重加密为 v2
 *      （每批 FOR UPDATE SKIP LOCKED，可与业务并发；幂等可重跑）。
 *   4. 脚本报「全部完成」后，从 .env 移除 ENCRYPTION_KEY_OLD 并重启（收窗）。
 *
 * 安全：密钥只从 env 读取；任何输出不含密钥/明文片段。
 */
import { Pool } from 'pg';
import { decrypt, encrypt } from '@ai-gateway/core';
import { loadRootEnvFile } from '@ai-gateway/http';

loadRootEnvFile();

const NEW_KEY = process.env.ENCRYPTION_KEY;
const OLD_KEY = process.env.ENCRYPTION_KEY_OLD;

if (!NEW_KEY || !OLD_KEY) {
  console.error(
    '需要同时设置 ENCRYPTION_KEY（新）与 ENCRYPTION_KEY_OLD（旧）——双 key 窗未打开。\n' +
      '按脚本头部流程先改 .env 并重启服务，再运行本脚本。',
  );
  process.exit(1);
}
if (NEW_KEY === OLD_KEY) {
  console.error('ENCRYPTION_KEY 与 ENCRYPTION_KEY_OLD 相同：无需轮换。');
  process.exit(1);
}

const BATCH = 100;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
});

async function main(): Promise<void> {
  let migrated = 0;
  let failed = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string; api_key_enc: string }>(
        `select id, api_key_enc from channels
          where api_key_enc like 'enc:v1:%'
          order by id
          limit $1
          for update skip locked`,
        [BATCH],
      );
      if (rows.length === 0) {
        await client.query('commit');
        break;
      }
      for (const row of rows) {
        try {
          const plain = decrypt(row.api_key_enc, NEW_KEY, OLD_KEY);
          const reEncrypted = encrypt(plain, NEW_KEY, 2);
          await client.query('update channels set api_key_enc = $2, updated_at = now() where id = $1', [
            row.id,
            reEncrypted,
          ]);
          migrated += 1;
        } catch (e) {
          failed += 1;
          console.error(`  ✗ channel id=${row.id} 重加密失败：${(e as Error).message}`);
        }
      }
      await client.query('commit');
      console.log(`  批次完成（累计迁移 ${migrated}${failed ? `，失败 ${failed}` : ''}）`);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const { rows: left } = await pool.query<{ count: string }>(
    `select count(*)::text as count from channels where api_key_enc like 'enc:v1:%'`,
  );
  const remaining = Number(left[0]?.count ?? 0);
  console.log(`轮换完成：迁移 ${migrated} 行，失败 ${failed} 行，剩余 v1 ${remaining} 行。`);
  if (remaining === 0 && failed === 0) {
    console.log('✔ 全部迁移完成：现在可以从 .env 移除 ENCRYPTION_KEY_OLD 并重启服务（收窗）。');
  } else {
    console.error('仍有 v1/失败行：请检查失败原因后重跑本脚本（幂等）。');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`脚本异常：${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
