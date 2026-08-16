/**
 * 安全审计 E2E 测试共享工具。
 *
 * 这些脚本针对「已真实运行」的服务发真实 HTTP 请求（gateway :8787 / admin-api :8790 /
 * client-api :8791），并通过 psql 直接造/清测试用户（admin-api 无「建用户」接口，
 * 一期是「管理员开通」：先插 users 行 → 再走真实 set-password 接口设密码）。
 *
 * 约定：每个测试脚本自建全新账号（subject 带时间戳 + 随机），finally 里清理，不污染已有数据。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = dirname(fileURLToPath(import.meta.url));

/** 从 monorepo 根 .env 加载环境变量（psql 需要 DATABASE_URL） */
export function loadEnv(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
export const ADMIN_API = 'http://127.0.0.1:8790';
export const CLIENT_API = 'http://127.0.0.1:8791';
export const GATEWAY = 'http://127.0.0.1:8787';

/** 开发库管理员（seed-dev 创建），仅用于「开通新账号」，测试主体永远是新建用户 */
export const ADMIN_EMAIL = 'admin@ai-gateway.local';
export const ADMIN_PASSWORD = 'admin12345';

/** SQL 字符串字面量转义（单引号翻倍 + 包单引号） */
export function q(s: string | number): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 跑一条 psql（返回去掉首尾空白的原始输出） */
export function psql(sql: string): string {
  return execSync(`psql "${DATABASE_URL}" -At -F '|' -c ${JSON.stringify(sql)}`, {
    encoding: 'utf8',
  }).trim();
}

export interface HttpOpts {
  cookie?: string;
  headers?: Record<string, string>;
}
function internalTokenHeader(): Record<string, string> {
  return process.env.INTERNAL_API_TOKEN
    ? { 'x-internal-token': process.env.INTERNAL_API_TOKEN }
    : {};
}

export async function post(
  url: string,
  body: unknown,
  opts: HttpOpts = {},
): Promise<{ status: number; body: unknown; raw: string; headers: Headers }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...internalTokenHeader(),
    ...opts.headers,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed, raw, headers: res.headers };
}

export async function patch(
  url: string,
  body: unknown,
  opts: HttpOpts = {},
): Promise<{ status: number; body: unknown; raw: string; headers: Headers }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...internalTokenHeader(),
    ...opts.headers,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed, raw, headers: res.headers };
}

export async function get(
  url: string,
  opts: HttpOpts = {},
): Promise<{ status: number; body: unknown; raw: string; headers: Headers }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(url, { method: 'GET', headers });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed, raw, headers: res.headers };
}

/** 从 set-cookie 头提取指定 cookie 名 → 返回可直接回传的 "name=value" 串 */
export function cookieFromSetCookie(res: { headers: Headers }, name: string): string {
  const sc = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${name}=([^;]+)`).exec(sc);
  return m ? `${name}=${m[1]}` : '';
}

let adminCookieCache: string | null = null;
/** 管理员登录拿 cookie（缓存复用） */
export async function adminCookie(): Promise<string> {
  if (adminCookieCache) return adminCookieCache;
  const res = await post(`${ADMIN_API}/api/admin/auth/login`, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`管理员登录失败：${res.status} ${res.raw}`);
  adminCookieCache = cookieFromSetCookie(res, 'ag_admin_session');
  if (!adminCookieCache) throw new Error('管理员登录未返回 ag_admin_session cookie');
  return adminCookieCache;
}

let seq = 0;
/** 生成唯一测试 subject */
export function newSubject(prefix = 'secaudit'): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 造一个全新普通用户行（balance 元），返回 id */
export function insertUser(subject: string, balance = '0'): number {
  psql(
    `insert into users (issuer, subject, identity_provider, display_name, status, balance) values (${q('local')}, ${q(subject)}, ${q('local')}, ${q(subject)}, 0, ${q(balance)});`,
  );
  return Number(psql(`select id from users where subject=${q(subject)};`).split('|')[0]);
}

/** 走真实 admin-api 给用户设密码（同时绑定「标准」费率卡） */
export async function setPassword(adminCookieStr: string, userId: number, password: string): Promise<void> {
  const res = await post(
    `${ADMIN_API}/api/admin/users/${userId}/set-password`,
    { password },
    { cookie: adminCookieStr },
  );
  if (res.status !== 200) throw new Error(`set-password 失败：${res.status} ${res.raw}`);
}

/** 普通用户登录，返回 { cookie, userId } */
export async function userLogin(
  username: string,
  password: string,
): Promise<{ cookie: string; userId: number; body: Record<string, any> }> {
  const res = await post(`${CLIENT_API}/api/auth/login`, { username, password });
  if (res.status !== 200) throw new Error(`用户登录失败：${res.status} ${res.raw}`);
  const cookie = cookieFromSetCookie(res, 'ag_session');
  const body = res.body as Record<string, any>;
  return { cookie, userId: body.user?.id, body };
}

/** 用会话 cookie 创建虚拟 Key，返回明文 key */
export async function createKey(userCookie: string, name = 'sec-audit'): Promise<string> {
  const res = await post(`${CLIENT_API}/api/keys`, { name }, { cookie: userCookie });
  if (res.status !== 201) throw new Error(`创建 key 失败：${res.status} ${res.raw}`);
  return (res.body as { key: string }).key;
}

/** 用会话 cookie 创建 App，返回 { clientId, clientSecret } */
export async function createApp(
  userCookie: string,
  name = 'sec-audit-app',
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await post(`${CLIENT_API}/api/apps`, { name }, { cookie: userCookie });
  if (res.status !== 201) throw new Error(`创建 app 失败：${res.status} ${res.raw}`);
  return res.body as { clientId: string; clientSecret: string };
}

/** 清理某个测试用户及其关联数据（绕过账本状态机，仅测试清理用）。
 *  注意删除顺序：request_logs/usage_logs 引用 api_keys → 必须先于 api_keys；
 *  api_keys/apps/transactions/billing_requests 引用 users → 必须先于 users。 */
export function cleanupUser(userId: number): void {
  for (const sql of [
    `delete from request_logs where user_id=${userId};`,
    `delete from usage_logs where user_id=${userId};`,
    `delete from transactions where user_id=${userId};`,
    `delete from billing_requests where user_id=${userId};`,
    `delete from audit_logs where target_id=${q(String(userId))} or admin_id=${userId};`,
    `delete from api_keys where user_id=${userId};`,
    `delete from apps where user_id=${userId};`,
    `delete from user_subscriptions where user_id=${userId};`,
    `delete from users where id=${userId};`,
  ]) {
    try {
      psql(sql);
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/** 报红统一出口：bug 存在时打印并置退出码 1 */
export function red(title: string, detail: string): never {
  console.error(`\n🔴 [BUG 确认] ${title}`);
  console.error(`   ${detail}`);
  console.error(`   → 测试「报红」：断言失败，漏洞真实存在。\n`);
  process.exitCode = 1;
  const e = new Error(title);
  e.name = 'BugConfirmed';
  throw e;
}

/** 是否为「报红确认」的预期异常（而非脚本崩溃） */
export function isBugConfirmed(err: unknown): boolean {
  return err instanceof Error && err.name === 'BugConfirmed';
}

export function green(title: string): void {
  console.log(`  ✅ ${title}`);
}

export const section = (t: string): void => console.log(`\n━━━ ${t} ━━━`);
