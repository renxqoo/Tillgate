/**
 * live-fire 种子与查询装置:dev 库(tillgate-v5)内配置 mock 渠道目录、
 * 造测试用户/密钥、经 admin-api 真实路径注资;integration_settings.smtp 行
 * 快照换本地 sink(结束还原);全部行带 rt- 前缀/rt-fire issuer 便于清理。
 */
import { createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '@tillgate/db';
import { createCipher } from '@tillgate/runtime';
import { http } from './h.ts';
import { URLS } from './stack.ts';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number, o: any) => Promise<Buffer>;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plain, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 512 * 1024 * 1024 });
  return `scrypt:32768:8:1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

const PRICE = { input: '2.1', output: '8.4', cache: '0.42' };

/** (external, real_model, 绑定渠道[chaos=只挂混沌厂商], 备注) */
export const MODELS: Array<{
  ext: string;
  real: string;
  ch: string[];
  chOverride?: Record<string, Record<string, string>>;
}> = [
  { ext: 'rt-base', real: 'rt-base', ch: ['openmock:10', 'deepmock:5', 'moonmock:3'] },
  { ext: 'rt-mini', real: 'rt-mini', ch: ['openmock:10'] },
  { ext: 'rt-exact', real: 'rt-base#f=usage100x40', ch: ['openmock:10'] },
  { ext: 'rt-perframe', real: 'rt-base#f=perframe,usage100x50', ch: ['openmock:10'] },
  { ext: 'rt-zero', real: 'rt-base#f=zerousage', ch: ['openmock:10'] },
  { ext: 'rt-nousage', real: 'rt-base#f=nousage', ch: ['openmock:10'] },
  { ext: 'rt-slowstream', real: 'rt-base#f=slow400,chunks10', ch: ['openmock:10'] },
  { ext: 'rt-wrongmodel', real: 'rt-base#f=wrongmodel', ch: ['openmock:10'] },
  { ext: 'rt-nchoice', real: 'rt-base#f=n3', ch: ['openmock:10'] },
  { ext: 'rt-nodone', real: 'rt-base#f=nodone', ch: ['openmock:10'] },
  { ext: 'rt-big', real: 'rt-base#f=bigbody64,chunks2', ch: ['openmock:10'] },
  { ext: 'rt-429', real: 'rt-base#f=s429', ch: ['chaosmock:10'] },
  { ext: 'rt-500', real: 'rt-base#f=s500', ch: ['chaosmock:10'] },
  { ext: 'rt-401up', real: 'rt-base#f=s401', ch: ['chaosmock:10'] },
  { ext: 'rt-403up', real: 'rt-base#f=s403', ch: ['chaosmock:10'] },
  { ext: 'rt-400up', real: 'rt-base#f=s400', ch: ['chaosmock:10'] },
  { ext: 'rt-hang', real: 'rt-base#f=hang', ch: ['chaosmock:10'] },
  { ext: 'rt-ttfb', real: 'rt-base#f=ttfb3000', ch: ['chaosmock:10'] },
  { ext: 'rt-reset', real: 'rt-base#f=reset', ch: ['chaosmock:10'] },
  { ext: 'rt-reset0', real: 'rt-base#f=reset0', ch: ['chaosmock:10'] },
  { ext: 'rt-garbage', real: 'rt-base#f=garbage', ch: ['moonmock:10'] },
  { ext: 'rt-neg', real: 'rt-base#f=negusage', ch: ['chaosmock:10'] },
  { ext: 'rt-huge', real: 'rt-base#f=hugeusage', ch: ['chaosmock:10'] },
  { ext: 'rt-empty', real: 'rt-base#f=empty', ch: ['chaosmock:10'] },
  { ext: 'rt-redir', real: 'rt-base#f=redir', ch: ['chaosmock:10'] },
  { ext: 'rt-failover', real: 'rt-base', ch: ['chaosmock:10', 'openmock:5'] },
  { ext: 'rt-rpmlim', real: 'rt-base#f=chunks1', ch: ['openmock-rpm:10'] },
  { ext: 'rt-ssrf', real: 'rt-base', ch: ['ssrf:10'] },
];

export interface Seeded {
  db: Db;
  providerIds: Record<string, number>;
  channelIds: Record<string, number>;
  modelIds: Record<string, number>;
}

async function one<T>(db: Db, q: any): Promise<T> {
  const r = await db.execute(q);
  return r[0] as T;
}

export async function seedCatalog(): Promise<Seeded> {
  const db = createDb({
    url: process.env.DATABASE_URL as string,
    poolMax: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  const cipher = createCipher(process.env.ENCRYPTION_KEY as string);

  // 起跑全量清理:上一 run(尤其 --no-cleanup 调试)残留的 rt 用户/账单/钱包/Redis 状态
  // 会形成「毒账单」(用户已删 → usage_logs FK 拒插)甚至打崩 worker——从零起跑是硬前提
  await cleanup(db);

  // 幂等重种:先清旧 rt- 目录(replica 模式旁路 FK/触发器,残留引用不再卡重跑)
  await execStatements(
    db,
    `    set session_replication_role = replica;
    delete from usage_logs where channel_id in (select id from channels where name like 'rt-ch-%')
      or user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test');
    delete from model_channels where channel_id in (select id from channels where name like 'rt-ch-%')
      or mapping_id in (select id from model_mappings where external_name like 'rt-%');
    delete from model_mappings where external_name like 'rt-%';
    delete from channels where name like 'rt-ch-%';
    delete from providers where name like 'rt-%';
    set session_replication_role = default;`,
  );

  const providerIds: Record<string, number> = {};
  const channelIds: Record<string, number> = {};

  // 4 个 mock 厂商(独立端口=熔断隔离) + 2 个特殊 provider(openmock-rpm 限速渠道 / ssrf 靶子)
  const providerDefs: Array<[string, string]> = [
    ['openmock', `${URLS.mock}/openmock`],
    ['deepmock', `${URLS.mock.replace(/:\d+$/, ':8891')}/deepmock`],
    ['moonmock', `${URLS.mock.replace(/:\d+$/, ':8892')}/moonmock`],
    ['chaosmock', `${URLS.mock.replace(/:\d+$/, ':8893')}/chaosmock`],
    ['openmock-rpm', `${URLS.mock}/openmock`],
    ['ssrf', 'http://127.0.0.1:2525'],
  ];
  for (const [vendor, baseUrl] of providerDefs) {
    const p = await one<{ id: string }>(
      db,
      sql`
      insert into providers (name, protocol, vendor, base_url) values (${`rt-${vendor}`}, 'openai-compatible', 'openai', ${baseUrl}) returning id`,
    );
    providerIds[vendor] = Number(p.id);
    const apiKey = `sk-mock-${vendor === 'openmock-rpm' ? 'openmock' : vendor}-k1`;
    const c = await one<{ id: string }>(
      db,
      sql`
      insert into channels (provider_id, name, api_key_enc, upstream_budget, rpm_limit)
      values (${p.id}, ${`rt-ch-${vendor}`}, ${cipher.encrypt(apiKey)}, '1000000', ${vendor === 'openmock-rpm' ? 3 : null}) returning id`,
    );
    channelIds[vendor] = Number(c.id);
  }

  const modelIds: Record<string, number> = {};
  for (const m of MODELS) {
    const r = await one<{ id: string }>(
      db,
      sql`
      insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price)
      values (${m.ext}, ${m.real}, ${PRICE.input}, ${PRICE.output}, ${PRICE.cache}) returning id`,
    );
    modelIds[m.ext] = Number(r.id);
    for (const link of m.ch) {
      const [vendor, prio] = link.split(':');
      await db.execute(sql`
        insert into model_channels (mapping_id, channel_id, priority, weight)
        values (${modelIds[m.ext]}, ${channelIds[vendor]}, ${Number(prio)}, 1)`);
    }
  }
  return { db, providerIds, channelIds, modelIds };
}

/** 建测试用户(直插 users + identity 两表,issuer='rt-fire';随机后缀防跨 run 撞唯一键) */
export async function mkUser(
  db: Db,
  tag: string,
  password = 'Rt!Passw0rd#42',
): Promise<{ id: number; email: string }> {
  const email = `rt-${tag}-${Math.floor(Math.random() * 1e6).toString(36)}@fire.test`;
  const u = await one<{ id: string }>(
    db,
    sql`
    insert into users (issuer, subject, identity_provider, email, display_name)
    values ('rt-fire', ${email}, 'local', ${email}, ${`rt-${tag}`}) returning id`,
  );
  const id = Number(u.id);
  await db.execute(
    sql`insert into identity_credentials (user_id, identifier_kind, identifier_value) values (${id}, 'email', ${email})`,
  );
  await db.execute(
    sql`insert into identity_passwords (user_id, password_hash) values (${id}, ${await hashPassword(password)})`,
  );
  return { id, email };
}

/** 直插平台密钥(sha256 落库,明文只此一次返回) */
export async function mkKey(
  db: Db,
  userId: number,
  name: string,
  opts: { rpm?: number; tpm?: number } = {},
): Promise<string> {
  const raw = `sk_rt${Array.from(randomBytes(20))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  await db.execute(sql`
    insert into api_keys (key_hash, key_preview, user_id, name, rpm_limit, tpm_limit)
    values (${createHash('sha256').update(raw).digest('hex')}, ${raw.slice(0, 8) + '…'}, ${userId}, ${name}, ${opts.rpm ?? null}, ${opts.tpm ?? null})`);
  return raw;
}

// ---- admin-api 真实路径注资 ----
let adminToken = '';

export async function adminLogin(): Promise<string> {
  const r = await http(`${URLS.admin}/v1/auth/login`, {
    body: { email: 'rt-admin@fire.test', password: 'Rt!AdminPass#7' },
  });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${r.text.slice(0, 200)}`);
  adminToken = (r.json() as any).token;
  return adminToken;
}

export async function fund(userId: number, amount: string, opId: string): Promise<string> {
  const r = await http(`${URLS.admin}/v1/users/${userId}/adjust`, {
    body: { amount, remark: 'live-fire' },
    headers: { authorization: `Bearer ${adminToken}`, 'operation-id': opId },
  });
  if (r.status !== 200) throw new Error(`fund failed: ${r.status} ${r.text.slice(0, 200)}`);
  return String((r.json() as any).balanceAfter);
}

// ---- 查询助手 ----
export async function wallet(db: Db, userId: number) {
  const r = await db.execute(sql`
    select balance::text, in_flight::text from wallet_accounts where user_id = ${userId} and kind = 'user'`);
  const row = r[0] as { balance: string; in_flight: string } | undefined;
  return row ?? { balance: '0', in_flight: '0' };
}

export async function billOf(db: Db, requestId: string) {
  const r = await db.execute(sql`
    select status, reserved_amount::text, receipt from billing_requests where request_id = ${requestId}`);
  return (r[0] as any) ?? null;
}

export async function usageRow(db: Db, requestId: string) {
  const r = await db.execute(sql`
    select amount::text, payg_amount::text, input_tokens, output_tokens, status
    from usage_logs where request_id = ${requestId}`);
  return (r[0] as any) ?? null;
}

export async function usageSum(db: Db, userId: number): Promise<string> {
  const r = await db.execute(sql`
    select coalesce(sum(amount), 0)::text as total from usage_logs
    where user_id = ${userId} and status = 0`);
  return String((r[0] as any).total);
}

export async function billCount(db: Db, userId: number): Promise<number> {
  const r = await db.execute(
    sql`select count(*)::int as n from billing_requests where user_id = ${userId}`,
  );
  return Number((r[0] as any).n);
}

// ---- SMTP 集成行:快照 → 换 sink → 还原 ----
let smtpSnapshot: { key: string; enabled: boolean; config: unknown } | null | undefined;

export async function swapSmtpToSink() {
  const db = createDb({
    url: process.env.DATABASE_URL as string,
    poolMax: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  const prev = await db.execute(
    sql`select key, enabled, config from integration_settings where key = 'smtp'`,
  );
  smtpSnapshot = (prev[0] as any) ?? null;
  const cipher = createCipher(process.env.ENCRYPTION_KEY as string);
  const config = {
    host: '127.0.0.1',
    port: '2525',
    user: 'sink@fire.test',
    pass: cipher.encrypt('sink-pass'),
  };
  await db.execute(sql`
    insert into integration_settings (key, enabled, config) values ('smtp', true, ${config}::jsonb)
    on conflict (key) do update set enabled = true, config = excluded.config`);
  await closeDb(db).catch(() => {});
}

export async function restoreSmtp() {
  if (smtpSnapshot === undefined) return;
  const db = createDb({
    url: process.env.DATABASE_URL as string,
    poolMax: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  if (smtpSnapshot == null) {
    await db.execute(sql`delete from integration_settings where key = 'smtp'`);
  } else {
    await db.execute(sql`
      update integration_settings set enabled = ${smtpSnapshot.enabled}, config = ${{ ...(smtpSnapshot.config as object) }}::jsonb where key = 'smtp'`);
  }
  await closeDb(db).catch(() => {});
}

/** 多语句块逐条执行(Bun SQL 的 unsafe 走扩展协议,不支持 simple 协议多语句;文本内无含 ; 的字面量) */
async function execStatements(db: Db, text: string): Promise<void> {
  for (const stmt of text.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await db.execute(sql.raw(trimmed));
  }
}

// ---- 清理:rt- 目录/用户/钱包。session_replication_role=replica 旁路全部触发器
// (账本不可变/一致性约束会拦带活跃授权的删除——测试数据整体撤离需要无痕通道) ----
export async function cleanup(db: Db) {
  await execStatements(
    db,
    `    set session_replication_role = replica;
    delete from usage_logs where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test')
      or channel_id in (select id from channels where name like 'rt-ch-%');
    delete from billing_reservations where billing_request_id in (
      select request_id from billing_requests where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test'));
    delete from billing_requests where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test')
      or user_id not in (select id from users); -- P1 毒账单场景的用户已被删(孤儿行兜底)
    delete from model_channels where channel_id in (select id from channels where name like 'rt-ch-%')
      or mapping_id in (select id from model_mappings where external_name like 'rt-%');
    delete from model_mappings where external_name like 'rt-%';
    delete from channels where name like 'rt-ch-%';
    delete from providers where name like 'rt-%';
    delete from wallet_authorizations where account_id in (
      select id from wallet_accounts where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test'));
    delete from wallet_transactions where id in (
      select distinct l.transaction_id from wallet_legs l
      join wallet_accounts a on a.id = l.account_id
      where a.user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test'));
    delete from wallet_legs where account_id in (
      select id from wallet_accounts where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test'));
    delete from wallet_legs where transaction_id not in (select id from wallet_transactions);
    delete from wallet_accounts where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test');
    delete from api_keys where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test');
    delete from identity_passwords where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test');
    delete from identity_credentials where user_id in (select id from users where issuer = 'rt-fire' or email like 'rt-%@fire.test')
      or identifier_value like 'rt-%@fire.test' or identifier_value = 'rt-admin@fire.test';
    delete from identity_challenges where identifier_value like 'rt-%@fire.test';
    delete from notify_outbox where payload::text like '%billing_dead%';
    delete from users where issuer = 'rt-fire' or email like 'rt-%@fire.test';
    delete from admins where email = 'rt-admin@fire.test';
    delete from rate_card_coefficients where rate_card_id in (select id from rate_cards where name = 'rt-half');
    delete from rate_cards where name = 'rt-half';
    set session_replication_role = default;`,
  );
  // Redis 守卫键清障(锁 600s;窗口计数自然过期)
  const pass = (() => {
    try {
      return new URL(process.env.REDIS_URL as string).password;
    } catch {
      return 'root123';
    }
  })();
  for (const pattern of ['auth:*', 'authfail:*', 'client-api:*', 'inference:health:*']) {
    Bun.spawnSync([
      'bash',
      '-c',
      `redis-cli -a ${pass} --scan --pattern '${pattern}' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1`,
    ]);
  }
}
