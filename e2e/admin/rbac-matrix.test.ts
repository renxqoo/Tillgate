/**
 * RBAC 绑定矩阵 e2e——表驱动遍历:参数/错误码矩阵表驱动断言。
 *
 *   §P 零授权遍历:全部绑定端点 × 零码令牌 → 逐条 403 insufficient_permission
 *      （一条锁定两事:绑定完整性——缺绑定会变 endpoint_unbound;fail-closed 默认）;
 *      顺带断言绑定表与公开/自身白名单零重叠。
 *   §Q 全码 GET 侧:41 enforced 码全授令牌走全部 GET 绑定 → 不得命中
 *      insufficient_permission / endpoint_unbound（抓「错绑权限码」型越权/误拦）。
 *   §R 预置授权契约:0082 种子的 4 个预置角色授权码集逐一相等（种子被误改即红）。
 *   §S 路由 ⊆ 绑定:openapi 端点注册表（单一真相）× 绑定表集合 diff——
 *      新端点漏绑定时 §P 测不到（它不在绑定表里）,上线即超管外全体 403。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { admins, roles } from '@tillgate/db';
import { ENFORCED_CODES } from '@tillgate/control-plane';
import { adminApiEndpoints } from '../../apps/admin-api/src/http/openapi/index';
import { PUBLIC_ROUTES, SELF_PREFIXES } from '../../apps/admin-api/src/http/middleware/acl';
import {
  call,
  defined,
  jsonHeaders,
  setupE2EAdmin,
  teardownE2EAdmin,
  type E2EAdminWorld,
} from './kit';

let world: E2EAdminWorld | null = null;

beforeAll(async () => {
  world = await setupE2EAdmin();
}, 60_000);

const createdAdminIds: number[] = [];
const createdRoleIds: number[] = [];

afterAll(async () => {
  if (world === null) return;
  await world.assembly.db.delete(admins).where(inArray(admins.id, createdAdminIds));
  await world.assembly.db.delete(roles).where(inArray(roles.id, createdRoleIds));
  await teardownE2EAdmin(world);
});

function w(): E2EAdminWorld {
  if (world === null) throw new Error('e2e world not ready');
  return world;
}

async function callAs(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${w().base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** 零码/全码旅程令牌;行 e2e-matrix-* 前缀自清理 */
async function tokenWith(codes: string[], stamp: string): Promise<string> {
  const role = await call(w(), '/v1/roles', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ code: `e2e-matrix-${stamp}`, name: 'e2e matrix', permissions: codes }),
  });
  expect(role.status).toBe(201);
  createdRoleIds.push(role.body.id as number);
  const [row] = await w()
    .assembly.db.insert(admins)
    .values({
      email: `e2e-matrix-${stamp}@e2e.invalid`,
      passwordHash: 'identity-managed',
      roleId: role.body.id as number,
      displayName: 'e2e-matrix',
    })
    .returning({ id: admins.id });
  if (row == null) throw new Error('insert admins returned no row');
  createdAdminIds.push(row.id);
  return w().assembly.identity.sessions.sign({ realm: 'admin', subjectId: row.id, ttlSec: 600 });
}

interface BindingRow {
  id: number;
  method: string;
  path: string;
}

async function listBindings(): Promise<BindingRow[]> {
  const res = await call(w(), '/v1/endpoint-bindings');
  expect(res.status).toBe(200);
  return (res.body.rows ?? []) as BindingRow[];
}

/** ':param' 段替换为占位值（ACL 段匹配先于路由,不触达处理器） */
function materialize(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '1' : segment))
    .join('/');
}

/** 公开/自身白名单路由命中（S 矩阵:白名单端点不要求绑定行——模块级避免每用例重建） */
function isWhitelistedRoute(method: string, path: string): boolean {
  return (
    PUBLIC_ROUTES.some((route) => route.method === method && route.path === path) ||
    SELF_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}

describe('P. 绑定完整性矩阵（零码令牌遍历全部绑定端点）', () => {
  it('每条绑定 → 403 insufficient_permission;绑定表与白名单零重叠', async () => {
    const bindings = await listBindings();
    expect(bindings.length).toBeGreaterThan(50); // 0084 种子 108 条的合理性下界

    // 白名单路径不该出现在绑定表（公开/自身直通,绑定无意义且永不命中）
    const whitelisted = bindings.filter(
      (row) => row.path.startsWith('/v1/me') || row.path.startsWith('/v1/auth'),
    );
    expect(whitelisted).toEqual([]);

    const token = await tokenWith([], `p-${Date.now()}`);
    for (const row of bindings) {
      const init: RequestInit =
        row.method === 'GET' || row.method === 'HEAD'
          ? {}
          : { headers: jsonHeaders, body: JSON.stringify({}) };
      const res = await callAs(token, materialize(row.path), { method: row.method, ...init });
      expect(res.status, `${row.method} ${row.path} 零码应 403`).toBe(403);
      expect(res.body, `${row.method} ${row.path}`).toMatchObject({
        error: { code: 'admin.insufficient_permission' },
      });
    }
  });
});

describe('Q. 错绑检测矩阵（全码令牌走 GET 绑定）', () => {
  it('全部 GET 绑定不命中 ACL 拒绝码（业务 4xx 允许;错绑/漏授即红）', async () => {
    const bindings = (await listBindings()).filter((row) => row.method === 'GET');
    expect(bindings.length).toBeGreaterThan(40);
    const token = await tokenWith([...ENFORCED_CODES], `q-${Date.now()}`);

    for (const row of bindings) {
      const res = await callAs(token, materialize(row.path));
      const code = (res.body.error as { code?: string } | undefined)?.code;
      expect(code, `GET ${row.path} 全码令牌不得被 ACL 拒（错绑或绑到非 enforced 码）`).not.toBe(
        'admin.insufficient_permission',
      );
      expect(code).not.toBe('admin.endpoint_unbound');
    }
  });
});

describe('R. 预置授权契约（0082 种子逐角色锁定）', () => {
  it('operator/finance/support/viewer 授权码集与种子逐一相等;super 隐式全量零授权行', async () => {
    const expected: Record<string, string[]> = {
      operator: [
        'users:read',
        'funds:read',
        'catalog:read',
        'plans:read',
        'ops:read',
        'growth:read',
        'settings:read',
        'users:update',
        'users:set-password',
        'catalog:create',
        'catalog:update',
        'catalog:delete',
        'catalog:restore',
        'catalog:test',
        'catalog:import',
        'catalog:refresh',
        'catalog:bind',
        'plans:create',
        'plans:update',
        'plans:delete',
        'plans:renew',
        'plans:cancel',
        'plans:change',
        'plans:grant',
        'growth:create',
        'growth:update',
        'growth:delete',
        'growth:test',
        'settings:update',
      ],
      finance: [
        'users:read',
        'funds:read',
        'catalog:read',
        'plans:read',
        'ops:read',
        'growth:read',
        'settings:read',
        'funds:adjust',
        'funds:recharge',
        'funds:gift',
        'funds:close',
        'funds:revoke',
        'funds:create',
        'funds:retry',
        'funds:abandon',
      ],
      support: [
        'users:read',
        'funds:read',
        'catalog:read',
        'plans:read',
        'ops:read',
        'growth:read',
        'users:update',
        'users:set-password',
      ],
      viewer: [
        'users:read',
        'funds:read',
        'catalog:read',
        'plans:read',
        'ops:read',
        'growth:read',
        'settings:read',
      ],
    };

    const res = await call(w(), '/v1/roles?page_size=100');
    expect(res.status).toBe(200);
    const rows = res.body.rows as {
      code: string;
      isSuper: boolean;
      codes: string[];
    }[];
    const byCode = new Map(rows.map((row) => [row.code, row]));

    for (const [roleCode, codes] of Object.entries(expected)) {
      const role = defined(byCode.get(roleCode), `预置角色 ${roleCode}`);
      expect(role, `预置角色 ${roleCode} 缺失`).toBeDefined();
      expect([...role.codes].toSorted(), `${roleCode} 授权码集漂移`).toEqual([...codes].toSorted());
    }
    const superRole = defined(byCode.get('super_admin'), 'super_admin role');
    expect(superRole).toBeDefined();
    expect(superRole.isSuper).toBe(true);
    expect(superRole.codes).toEqual([]); // 隐式全量:不落授权行
  });
});

describe('S. 路由 ⊆ 绑定表（新端点漏绑定即红）', () => {
  it('注册表端点（剔除公开/自身白名单）逐条有绑定;:param 形态一致', async () => {
    const bindings = await listBindings();
    const bound = new Set(bindings.map((row) => `${row.method} ${row.path}`));

    const missing: string[] = [];
    for (const endpoint of adminApiEndpoints) {
      const method = endpoint.method.toUpperCase();
      // HEAD 经 ACL 归一为 GET 判定——绑定表按 GET 存（注册表如无 HEAD 项此分支自然不触发）
      const key = `${method} ${endpoint.path}`;
      if (isWhitelistedRoute(method, endpoint.path)) continue;
      if (!bound.has(key)) missing.push(key);
    }
    expect(missing, '以下端点未绑定权限——fail-closed 下超管外全体 403').toEqual([]);
    // 反向健康度:绑定量应接近注册表量（P 段已逐条验证绑定侧,此处防注册表意外缩水）
    expect(adminApiEndpoints.length).toBeGreaterThanOrEqual(119); // 注册表缩水即红（当前 119）
  });
});
