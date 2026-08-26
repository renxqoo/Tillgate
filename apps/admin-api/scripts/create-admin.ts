/**
 * 管理员初始账号创建（bootstrap）——v1 `scripts/seed-admin.ts` 的 v2 正身
 * （identity MIGRATION §8 W1 后续波：v2 侧此前无「建管理员」动词，只有凭据迁移）。
 *
 * 语义（引导最优实践：创建靠命令、密码一次性、幂等）：
 *   - 密码来源优先级：`--password=`（勿入 shell 历史）> env `ADMIN_INITIAL_PASSWORD`
 *     > 现场强随机生成（仅 --apply 时打印一次）；策略与 admin-api 装配一致（8..128）
 *   - 幂等：同邮箱已存在即跳过，**不覆盖已有密码**（改密走登录后 /v1/me/password）；
 *     邮箱被其他身份（如 client 侧账号）占用 → 报错回滚，绝不静默造「登不上」的废号
 *   - id 分配：admins.id 必须落在 ≥1e9 段——identity_passwords.userId 是无 realm 的
 *     扁平主键，与 users.id 同号即串号（2026-08-23 生产迁移裁决；序列不足时推高）
 *   - 事务：admins + identity_credentials + identity_passwords 同事务原子插入；
 *     旧列 admins.password_hash 已随 0089 退役（凭据单一真相在 identity 七表）
 *
 * 用法：cd apps/admin-api && bun scripts/create-admin.ts --email=you@example.com [--apply]
 *   [--role=super_admin|operator|finance|support|viewer] [--display-name=…] [--password=…]
 *   缺省 dry-run（只打印计划）；--apply 落库。env 从 .env 向上查找（DATABASE_URL）。
 *   角色缺省 super_admin（bootstrap 语义不变）；词表 = control-plane domain/rbac。
 */
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closeDb, createDb, admins, identityCredentials, identityPasswords } from '@tillgate/db';
import { assertPasswordPolicy, hashPassword } from '@tillgate/identity';
import { roles as rolesTable } from '@tillgate/db';

/** 现场生成 16 位强密码（大小写+数字；避免易混淆字符与 shell 转义烦恼） */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const chars: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    const char = alphabet[randomInt(alphabet.length)];
    // randomInt 上界即 alphabet.length,越界只能是实现错误;守卫为类型收窄
    if (char === undefined) throw new Error('random password char out of range');
    chars.push(char);
  }
  return chars.join('');
}

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
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
          process.env[key] = m?.[2] ?? '';
        }
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// eslint-disable-next-line max-lines-per-function -- CLI bootstrap 顺序流程(参数→env→守卫→落库→打印,单文件跑完即弃)
async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const email = argValue('email');
  if (email == null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(
      'usage: create-admin.ts --email=you@example.com [--apply] [--display-name=…] ' +
        '[--role=super_admin|operator|finance|support|viewer] [--password=…]',
    );
    process.exit(1);
  }
  const roleCode = argValue('role') ?? 'super_admin';
  const url = process.env.DATABASE_URL;
  if (url == null || url === '') {
    console.error('DATABASE_URL is required (load .env or export it)');
    process.exit(1);
  }
  // split('@') 至少返回一段(可能为空串);邮箱格式已在上方校验非空
  const [localPart] = email.split('@');
  const displayName = argValue('display-name') ?? (localPart ?? '').slice(0, 64);

  const passwordProvided = argValue('password') ?? process.env.ADMIN_INITIAL_PASSWORD;
  const password = passwordProvided ?? generatePassword();
  const generated = passwordProvided == null;
  assertPasswordPolicy(password, { minLength: 8, maxLength: 128 });

  const db = createDb({
    url,
    poolMax: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  const [roleRow] = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(eq(rolesTable.code, roleCode));
  if (roleRow == null) {
    console.error(`role "${roleCode}" not found (roles 表——先确认 0082 种子或自定义角色)`);
    process.exit(1);
  }

  try {
    const [existingAdmin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, email));
    if (existingAdmin !== undefined) {
      console.log(`skip: admin already exists (id=${existingAdmin.id}, ${email})`);
      return;
    }
    if (!apply) {
      console.log(
        `dry-run: would create admin ${email} (display "${displayName}", role ${roleCode}, password ${
          generated ? 'to be generated' : 'from argument/env'
        })`,
      );
      return;
    }
    const hash = await hashPassword(password);
    const created = await db.transaction(async (tx) => {
      // id ≥1e9 段分配（max+1 兜底新库从 1 起步的序列；插显式 id 后同步推高序列）
      const [maxRow] = await tx
        .select({ maxId: sql<number>`coalesce(max(${admins.id}), 0)::bigint` })
        .from(admins);
      const id = Math.max(1_000_000_000, Number(maxRow?.maxId ?? 0) + 1);
      await tx.insert(admins).values({ id, email, displayName, roleId: roleRow.id });
      await tx.execute(sql`select setval(pg_get_serial_sequence('admins', 'id'), ${id})`);
      // 凭据冲突 = 邮箱已被其他身份占用(常见:client 侧同邮箱账号)。静默跳过会造出
      // 「创建成功但永远登不上」的废管理员——抛错回滚整个事务,提示换邮箱
      const cred = await tx
        .insert(identityCredentials)
        .values({ userId: id, identifierKind: 'email', identifierValue: email })
        .onConflictDoNothing({
          target: [identityCredentials.identifierKind, identityCredentials.identifierValue],
        })
        .returning({ id: identityCredentials.id });
      if (cred.length === 0) {
        throw new Error(
          `email ${email} is already bound to another identity (identity_credentials conflict — ` +
            `likely a client-side account with the same email); admin NOT created, transaction rolled back. ` +
            `Use a dedicated admin email.`,
        );
      }
      // 哈希冲突同理必须 fail-loud:identity_passwords 若残留同 user_id 旧行
      // (admins 行曾被单独清除的半状态),静默跳过会造出「创建成功但登不上」的
      // 废号——登录 join 到旧哈希,任何口令都 401(2026-08-27 实证)
      const pwd = await tx
        .insert(identityPasswords)
        .values({ userId: id, passwordHash: hash })
        .onConflictDoNothing({ target: identityPasswords.userId })
        .returning({ userId: identityPasswords.userId });
      if (pwd.length === 0) {
        throw new Error(
          `identity_passwords already has an orphan row for user_id ${id} ` +
            `(admins row was cleared but identity rows survived a prior deletion); ` +
            `admin NOT created, transaction rolled back. Clear the orphan identity rows first.`,
        );
      }
      return id;
    });
    console.log(`created admin id=${created} (${email}, role ${roleCode})`);
    if (generated) {
      console.log(`one-time password (save now, will not be shown again): ${password}`);
      console.log('→ 首次登录后请立即在「账号菜单 → 修改密码」更换');
    }
  } finally {
    await closeDb(db);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
