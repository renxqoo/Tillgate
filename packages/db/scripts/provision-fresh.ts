/**
 * 空库前置 provision（fresh database bootstrap）——迁移链 0055/0056/0057 前向引用
 * （identity_session_anchors 建表在 0076、ledger_operations 建表在 0059）的解决：
 * 把这两个全幂等迁移文件（IF NOT EXISTS / 条件约束 / drop-then-create 触发器）的 DDL
 * 先行执行，空库即可完整走完整条 journal——0055/0056 回填在新库为 0 行，
 * 链推进到 0059/0076 时重放 = 零操作（在已初始化库上重跑本脚本同样零操作）。
 *
 * 空库完整初始化顺序（两步，.env 的 DATABASE_URL 指向目标空库）：
 *   1. bun packages/db/scripts/provision-fresh.ts
 *   2. cd packages/db && bun --env-file=../../.env drizzle-kit migrate
 * （原第 3 步 seed-dev.ts 已退役删除：管理员 →
 *  apps/admin-api/scripts/create-admin.ts，费率卡 → 管理台创建）
 *
 * env 从 .env（cwd 向上查找 monorepo 根）读 DATABASE_URL，缺失即报错退出
 * （无默认连接串，不写死）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db, type DbTx } from '../src/index.js';

/** 前置执行的幂等迁移文件（顺序即执行顺序；内容与 journal 内文件同源，不复制改写） */
const PROVISION_FILES = [
  '../migrations/0059_wallet_ledger_operations_convergence.sql',
  '../migrations/0076_identity_tables.sql',
  // 0059 的 create or replace function 是「替换」而非幂等——重放会把
  // wallet_assert_account_coherent 倒回旧版（0069/0095 的后续版本被覆盖，
  // 表现为每次 up -d 后透支地板/负余额结算神秘失效）。provision 末尾必须
  // 追加「最新触发改版迁移」重放函数终态；后续再改此函数时同步更新此处。
  '../migrations/0095_wallet_debit_floor.sql',
  // 0097：预扣策略端点 ACL 绑定（幂等 INSERT——NOT EXISTS 守卫，空库 provision 同样收口）
  '../migrations/0097_billing_reservation_policy_admin.sql',
] as const;

function loadEnvFile(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        const key = m?.[1];
        if (m != null && key && process.env[key] === undefined) {
          process.env[key] = m[2] ?? '';
        }
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** 单文件按 statement-breakpoint 切分后同事务执行（末条语句无分号也可执行） */
async function applyMigrationFile(tx: DbTx, file: string): Promise<number> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), file);
  const statements = readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await tx.execute(sql.raw(stmt));
  }
  return statements.length;
}

async function main(): Promise<void> {
  loadEnvFile();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('✗ DATABASE_URL 未设置（.env；v2 无默认连接串，零写死裁决 B2/D5）');
    process.exit(1);
  }
  const db: Db = createDb({
    url,
    poolMax: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  try {
    for (const file of PROVISION_FILES) {
      const count = await db.transaction((tx) => applyMigrationFile(tx, file));
      console.log(
        `✓ provision ${dirname(file).split('/').pop()}/${file.split('/').pop()}（${count} 条语句，幂等）`,
      );
    }
    console.log('provision 完成——接下来跑 drizzle-kit migrate 即可从空库走完整条迁移链');
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
