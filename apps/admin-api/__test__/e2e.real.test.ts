import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, createDb, ping, admins, type Db } from '@tokenlens/db';
import { assembleAdminApi } from '../src/assembly';
import { loadAdminApiConfig } from '../src/config';

/**
 * 端到端(真实进程,默认门禁按 *.real.test.ts 排除):spawn `bun src/index.ts` 起真服务器
 * (真实 PG 池 + 真实秘密键),identity facade 签发真 admin-realm JWT,全链路驱动六域:
 * 控制面建/改/退役、渠道资金进货幂等(重放回执/异参 409)、模型绑定、费率卡、fx/用户/
 * tracing/审计读侧、错误码信封、SIGTERM 优雅停机。
 * 数据卫生:全部行以 e2e- 前缀命名并就地退役/删除;资金动词只在 404 路径与 e2e 自建渠道上发生。
 */

let db: Db | null = null;
let child: ChildProcess | null = null;
let port = 0;
let token = '';
/** 进货行 admin_id 外键指向 admins——令牌 subject 必须是真实管理员 */
let adminId = 0;
const base = () => `http://127.0.0.1:${port}`;

const E2E_SECRET = 'e2e-real-jwt-secret-0123456789-abcdef';
const E2E_ENC = 'e2e-real-encryption-key-0123456789';
const E2E_PEPPER = 'e2e-real-pepper-0123456789';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const chosen = address.port;
      server.close(() => resolve(chosen));
    });
  });
}

async function waitReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base()}/livez`);
      if (res.status === 200) return;
    } catch {
      // 尚未监听——继续轮询
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('admin-api e2e: server did not become ready in time');
}

async function call(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.idempotencyKey !== undefined) headers.set('idempotency-key', init.idempotencyKey);
  const res = await fetch(`${base()}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') return;
  const candidate = createDb({
    url,
    poolMax: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
    maxUses: 100,
  });
  try {
    await ping(candidate);
    db = candidate;
  } catch {
    await closeDb(candidate);
    return;
  }

  // 真实管理员属主(进货行/审计行 admin_id 外键);无管理员数据则整体跳过
  const adminRows = await db.select({ id: admins.id }).from(admins).orderBy(admins.id).limit(1);
  if (adminRows.length === 0) {
    await closeDb(db);
    db = null;
    return;
  }
  adminId = adminRows[0]!.id;

  // 真实令牌:同配置 identity facade 签发(admin realm;无锚点行 = 全有效)
  process.env.ADMIN_JWT_SECRET = E2E_SECRET;
  process.env.ENCRYPTION_KEY = E2E_ENC;
  process.env.IDENTITY_CODE_PEPPER = E2E_PEPPER;
  const config = loadAdminApiConfig();
  const assembly = assembleAdminApi(config);
  token = await assembly.identity.sessions.sign({
    realm: 'admin',
    subjectId: adminId,
    ttlSec: 600,
  });
  await closeDb(assembly.db);

  port = await freePort();
  // --conditions=development:bun 运行时默认不应用 exports 的 development 条件
  // (vitest 解析器会)——不加会解析到 packages/*/dist 陈旧构建产物
  child = spawn('bun', ['--conditions=development', 'src/index.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      ADMIN_API_PORT: String(port),
      OTEL_TRACES_MODE: 'off',
      LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });
  await waitReady();
}, 60_000);

afterAll(async () => {
  if (child !== null) {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
  }
  if (db !== null) await closeDb(db);
});

describe('admin-api 端到端(真实进程 + 真实 PG)', () => {
  it('探针与会话门', async () => {
    if (child === null) return;
    const live = await fetch(`${base()}/livez`);
    expect(live.status).toBe(200);
    const ready = await (await fetch(`${base()}/readyz`)).json();
    expect(ready).toEqual({ status: 'ok', dependencies: { postgres: 'up' } });
    const unauthorized = await fetch(`${base()}/v1/providers`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { code: 'http.unauthorized' } });
  });

  it('控制面六域全链:providers→channels→channel-funds(幂等)→models→rate-cards', async () => {
    if (child === null) return;
    const stamp = Date.now();

    // providers 建/查/改
    const provider = await call('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `e2e-p-${stamp}`, baseUrl: 'http://127.0.0.1:9/v1' }),
    });
    expect(provider.status).toBe(201);
    const providerId = provider.body.id as number;
    const listed = await call(`/v1/providers?q=e2e-p-${stamp}`);
    expect(listed.status).toBe(200);
    expect((listed.body.rows as unknown[]).length).toBe(1);
    const patched = await call(`/v1/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 1 }),
    });
    expect(patched.status).toBe(200);

    // channels 建/改
    const channel = await call('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId,
        name: `e2e-ch-${stamp}`,
        apiKey: 'sk-e2e-test',
        models: [`e2e-m-${stamp}`],
      }),
    });
    expect(channel.status).toBe(201);
    const channelId = channel.body.id as number;
    await call(`/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamThreshold: '1' }),
    }).then((res) => expect(res.status).toBe(200));

    // channel-funds:进货幂等(同键同参重放/异参 409)+ 调账 + 流水
    const opKey = `e2e-rc-${stamp}`;
    const recharge = await call('/v1/channel-funds/recharge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      idempotencyKey: opKey,
      body: JSON.stringify({ channelId, amount: '10' }),
    });
    expect(recharge.status).toBe(200);
    expect(recharge.body).toMatchObject({ ok: true, balanceAfter: '10', replayed: false });
    const replay = await call('/v1/channel-funds/recharge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      idempotencyKey: opKey,
      body: JSON.stringify({ channelId, amount: '10' }),
    });
    expect(replay.body).toMatchObject({ balanceAfter: '10', replayed: true });
    const conflict = await call('/v1/channel-funds/recharge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      idempotencyKey: opKey,
      body: JSON.stringify({ channelId, amount: '5' }),
    });
    expect(conflict.status).toBe(409);
    // 渠道资金幂等档案归 control-plane(operations store 自有目录);用户资金动词才是 billing.*
    expect(conflict.body).toMatchObject({ error: { code: 'control_plane.operation_conflict' } });
    const adjusted = await call('/v1/channel-funds/adjust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId, amount: '-3' }),
    });
    expect(adjusted.body).toMatchObject({ balanceAfter: '7' });
    const funds = await call(`/v1/channel-funds?channelId=${channelId}`);
    const fundRows = funds.body.rows as Array<Record<string, unknown>>;
    expect(fundRows.length).toBeGreaterThanOrEqual(2);
    expect(fundRows.some((r) => r.type === 'recharge' && r.amount === '10')).toBe(true);

    // models 建 + 绑定渠道 + 退役
    const model = await call('/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalName: `e2e-m-${stamp}`,
        realModel: `e2e-real-${stamp}`,
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.1',
      }),
    });
    expect(model.status).toBe(201);
    const mappingId = model.body.id as number;
    const bound = await call(`/v1/models/${mappingId}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ channelId }] }),
    });
    expect(await bound.body).toMatchObject({ ok: true, bound: 1 });

    // rate-cards 建 + 健康自检 + 删除
    const card = await call('/v1/rate-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `e2e-rc-${stamp}`, coefficient: '0.900' }),
    });
    expect(card.status).toBe(201);
    const cardId = card.body.id as number;
    const health = await call(`/v1/rate-cards/${cardId}/health`);
    expect(health.body).toMatchObject({ hasGlobalCoefficient: true, coefficient: '0.900' });

    // fx/tracing 读侧(真实存储)
    expect((await call('/v1/fx/catalog')).status).toBe(200);
    const traces = await call('/v1/tracing/recent');
    expect(traces.status).toBe(200);
    expect(traces.body).toMatchObject({ page: 1 });
    expect((await call('/v1/tracing/stats')).status).toBe(200);

    // 审计桥:best-effort 写入经 observability 落 audit_logs(轮询容错旁路时序)
    await vi.waitFor(
      async () => {
        const audit = await call('/v1/audit-logs?sort_by=id');
        const actions = (audit.body.rows as Array<{ action: string }>).map((r) => r.action);
        expect(actions).toContain('provider.create');
        expect(actions).toContain('channel.create');
      },
      { timeout: 5_000 },
    );

    // 收尾:就地退役/删除(数据卫生)
    expect((await call(`/v1/models/${mappingId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/v1/rate-cards/${cardId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/v1/channels/${channelId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/v1/providers/${providerId}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('用户面读侧与 404 资金守卫(零写入)', async () => {
    if (child === null) return;
    const users = await call('/v1/users');
    expect(users.status).toBe(200);
    expect(users.body).toMatchObject({ page: 1, pageSize: 20 });
    const missing = await call('/v1/users/2147483647');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'accounts.user_not_found' } });
    const giftMissing = await call('/v1/users/2147483647/gift', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1' }),
    });
    expect(giftMissing.status).toBe(404);
    const transactions = await call('/v1/users/2147483647/transactions');
    expect(transactions.status).toBe(200);
    expect(transactions.body).toMatchObject({ rows: [], total: 0 });
  });

  it('SIGTERM 优雅停机(退出码 0)', async () => {
    if (child === null) return;
    const proc = child;
    const exited = new Promise<number>((resolve) => {
      proc.once('exit', (code) => resolve(code ?? -1));
    });
    proc.kill('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    child = null;
  }, 30_000);
});
