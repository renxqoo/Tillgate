/**
 * 存量管理员凭据迁移（identity MIGRATION §8 W1——apps 切换单元执行,P2 兑现）。
 *
 * admins.password_hash（v1 格式 saltHex:hashHex:N:r:p，同参 scrypt）→
 * identity_passwords（v2 格式 scrypt:N:r:p:saltHex:hashHex）机械转换（同参重排段序，
 * 可逆；identity G1 裁决）。同时补 identity_credentials（email 标识行,userId=adminId）。
 *
 * 幂等：identifier 行按唯一键 ON CONFLICT DO NOTHING；密码行已有即跳过（不覆盖——
 * 迁移后经 identity 改过的密码优先）。admins 列本脚本不删（退役 DDL 归后续波,
 * 冻结只读）。
 *
 * 用法：cd apps/admin-api && bun scripts/migrate-admin-credentials.ts [--apply]
 *   缺省 dry-run（只打印计划）；--apply 落库。env 从 .env 向上查找（DATABASE_URL）。
 * 锚点回填说明：admins.session_invalid_before 历史值大多为 null（v1 仅 admin 改邮箱
 * 单点写入且无读者,B01）；存量 v1 JWT 与 v2 签名密钥/口径不同本就全部失效——
 * 无锚点回填必要,空表起步即语义等价。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closeDb, createDb, admins, identityCredentials, identityPasswords } from '@tokenlens/db';

/** v1 `saltHex:hashHex:N:r:p` → v2 `scrypt:N:r:p:saltHex:hashHex`（段序重排,可逆）;
 * 已是 v2 格式（scrypt: 前缀,如 v2 seed 直写）原样直通——幂等不破坏 */
function convertHash(legacy: string): string {
  if (legacy.startsWith('scrypt:')) return legacy;
  const parts = legacy.split(':');
  if (parts.length !== 5) {
    throw new Error(`unexpected legacy password hash format (expected 5 segments): ${legacy.slice(0, 16)}…`);
  }
  const [salt, hash, n, r, p] = parts as [string, string, string, string, string];
  for (const num of [n, r, p]) {
    if (!/^\d+$/.test(num!)) {
      throw new Error(`unexpected scrypt parameter segment: ${num}`);
    }
  }
  return `scrypt:${n}:${r}:${p}:${salt}:${hash}`;
}

function loadEnv(): void {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        const key = m?.[1];
        if (m != null && key !== undefined && process.env[key] === undefined) {
          process.env[key] = m[2]!;
        }
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (url == null || url === '') {
    console.error('DATABASE_URL is required (load .env or export it)');
    process.exit(1);
  }
  const db = createDb({ url, poolMax: 2, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 5_000, maxUses: 10_000 });
  try {
    const rows = await db.select({ id: admins.id, email: admins.email, passwordHash: admins.passwordHash }).from(admins);
    let migrated = 0;
    let skipped = 0;
    for (const row of rows) {
      const existing = await db
        .select({ userId: identityPasswords.userId })
        .from(identityPasswords)
        .where(eq(identityPasswords.userId, row.id))
        .limit(1);
      if (existing.length > 0) {
        skipped += 1;
        console.log(`skip admin ${row.id} (${row.email}): identity_passwords already present`);
        continue;
      }
      let converted: string;
      try {
        converted = convertHash(row.passwordHash);
      } catch (error) {
        // 占位/不可解析哈希（e2e 夹具行等）:告警跳过——该行本无真实凭据语义
        console.warn(`skip admin ${row.id} (${row.email}): unparseable hash (${(error as Error).message})`);
        continue;
      }
      console.log(
        `${apply ? 'migrate' : 'plan'} admin ${row.id} (${row.email}): ${row.passwordHash.slice(0, 12)}… -> ${converted.slice(0, 20)}…`,
      );
      if (apply) {
        await db.transaction(async (tx) => {
          await tx
            .insert(identityCredentials)
            .values({ userId: row.id, identifierKind: 'email', identifierValue: row.email })
            .onConflictDoNothing({ target: [identityCredentials.identifierKind, identityCredentials.identifierValue] });
          await tx
            .insert(identityPasswords)
            .values({ userId: row.id, passwordHash: converted })
            .onConflictDoNothing({ target: identityPasswords.userId });
        });
      }
      migrated += 1;
    }
    // 一致性哨兵：密码行数 vs 资料行数（漂移 = 有密码行但无 admins 行——人工裁决）
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(identityPasswords)
      .where(
        sql`${identityPasswords.userId} in (select ${admins.id} from ${admins})`,
      );
    console.log(
      `${apply ? 'applied' : 'dry-run'}: ${migrated} to migrate, ${skipped} already present; password rows covering admins: ${countRow?.count ?? 0}/${rows.length}`,
    );
  } finally {
    await closeDb(db);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
