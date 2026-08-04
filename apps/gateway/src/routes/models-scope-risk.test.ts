import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { modelsRoutes } from './models.js';
import type { Db } from '@ai-gateway/db';
import type { AuthContext, AuthEnv } from '../middleware/auth.js';

/**
 * 风险回归验证（检测而非修复）：/v1/models JWT scope.models 过滤未生效。
 *
 * 定位：routes/models.ts:22-25
 *   if (auth.credentialType === 'jwt') {
 *     // JWT scope 内有 models 限制时过滤（需要从 auth 取 scope——当前 AuthContext 没存 scope）
 *     // 最小闭环：JWT 不过滤（scope.models 过滤后续加，需要 AuthContext 存 scope）
 *   }
 *
 * 关键矛盾（风险根因）：
 *   - auth.ts:202 实际已把 payload.scope.models 存进 AuthContext.allowedModels（注释 S3）
 *   - 但 models.ts 路由的过滤分支是「空实现」（注释声称「AuthContext 没存 scope」与事实不符）
 *   - 结果：JWT 签了只能调 A 模型的 scope，调 /v1/models 仍返回全部上架模型（信息泄漏）
 */

function makeMockDb(externalNames: string[]): Db {
  return {
    query: {
      modelMappings: {
        findMany: async () => externalNames.map((n) => ({ externalName: n })),
      },
    },
  } as unknown as Db;
}

function baseAuth(over: Partial<AuthContext>): AuthContext {
  return {
    userId: 1,
    apiKeyId: null,
    appId: null,
    credentialType: 'jwt',
    coefficientMilli: 1000,
    rateCardId: null,
    keyRpmLimit: null,
    userRpmLimit: null,
    appRpmLimit: null,
    keyTpmLimit: null,
    userTpmLimit: null,
    appTpmLimit: null,
    allowedModels: null,
    ...over,
  };
}

/** 父 app 先注册 auth 注入中间件，再挂载 modelsRoutes 子路由，保证 c.var.auth 先就绪 */
async function callModels(db: Db, auth: Partial<AuthContext>) {
  const parent = new Hono<AuthEnv>();
  parent.use('*', async (c, next) => {
    c.set('auth', baseAuth(auth));
    c.set('requestId', 'test');
    await next();
  });
  parent.route('/v1/models', modelsRoutes(db));
  const res = await parent.request('/v1/models', { method: 'GET' });
  const body = res.status === 200 ? ((await res.json()) as { data: Array<{ id: string }> }) : { data: [] };
  return { status: res.status, body };
}

describe('[风险] /v1/models JWT scope.models 过滤未生效', () => {
  const ALL = ['model-a', 'model-b', 'model-c'];

  it('静态分析：models.ts 的 JWT 分支为空实现（注释自承「最小闭环：JWT 不过滤」）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './models.ts'), 'utf8');
    const jwtBranch = src.match(/if\s*\(\s*auth\.credentialType\s*===\s*['"]jwt['"]\s*\)\s*\{([\s\S]*?)\}/);
    expect(jwtBranch, '应存在 JWT 分支').toBeTruthy();
    const branchBody = jwtBranch![1];
    // 分支体内不应出现对 models 数组的实际过滤逻辑
    expect(branchBody).not.toMatch(/models\s*=\s*models\.filter|allowedModels/);
    // 注释自承未实现
    expect(branchBody).toMatch(/不过滤|后续加|最小闭环/);
  });

  it('静态 Key（allowedModels=null）-> 返回全部上架模型（基线，正确行为）', async () => {
    const { status, body } = await callModels(makeMockDb(ALL), {
      credentialType: 'key',
      allowedModels: null,
    });
    expect(status).toBe(200);
    expect(body.data.map((m) => m.id)).toEqual(ALL);
  });

  it('JWT 且 allowedModels=[model-a] -> 仍返回全部模型（过滤未生效，风险复现）', async () => {
    const { status, body } = await callModels(makeMockDb(ALL), {
      credentialType: 'jwt',
      allowedModels: ['model-a'], // 该 JWT 只授权了 model-a
    });
    expect(status).toBe(200);
    const ids = body.data.map((m) => m.id);
    // 风险：期望过滤后只剩 model-a，实际返回全部 3 个（信息泄漏）
    expect(ids).toEqual(ALL); // 当前缺陷行为
    expect(ids).not.toEqual(['model-a']); // 若修复，这里会失败，提示更新断言
  });

  it('JWT 且 allowedModels 为多元素子集 -> 仍泄漏全集', async () => {
    const { body } = await callModels(makeMockDb(ALL), {
      credentialType: 'jwt',
      allowedModels: ['model-a', 'model-b'],
    });
    expect(body.data.map((m) => m.id)).toEqual(ALL);
  });
});
