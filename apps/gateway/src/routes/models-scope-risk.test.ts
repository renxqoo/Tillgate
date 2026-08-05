import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { modelsRoutes } from './models.js';
import type { Db } from '@ai-gateway/db';
import type { AuthContext, AuthEnv } from '../middleware/auth.js';

/**
 * TDD 红灯：/v1/models 应按 JWT scope.models 过滤。
 *
 * 定位：routes/models.ts:22-25
 *   if (auth.credentialType === 'jwt') {
 *     // 最小闭环：JWT 不过滤（scope.models 过滤后续加，需要 AuthContext 存 scope）
 *   }
 *
 * 期望（安全行为）：
 *   JWT 签发了 scope.models 白名单时，/v1/models 应只返回白名单内的上架模型，
 *   防止泄漏全部模型清单。auth.ts:202 已把 scope.models 存进 AuthContext.allowedModels，
 *   路由应据此 filter。
 *
 * 当前实现：JWT 分支是空实现，不过滤 → 返回全部上架模型（信息泄漏）。
 * 以下断言全部报红 = 风险确认存在。
 * 补上 filter 后（models = models.filter(m => allowedModels.includes(m))），断言转绿。
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
    coefficient: '1.0',
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

describe('/v1/models 应按 JWT scope.models 过滤（红灯 = 风险确认）', () => {
  const ALL = ['model-a', 'model-b', 'model-c'];

  it('静态 Key（allowedModels=null）→ 返回全部（基线，绿）', async () => {
    const { status, body } = await callModels(makeMockDb(ALL), {
      credentialType: 'key',
      allowedModels: null,
    });
    expect(status).toBe(200);
    expect(body.data.map((m) => m.id)).toEqual(ALL);
  });

  it('JWT allowedModels=[model-a] → 应只返回 [model-a]（当前返回全部 → 红）', async () => {
    const { status, body } = await callModels(makeMockDb(ALL), {
      credentialType: 'jwt',
      allowedModels: ['model-a'],
    });
    expect(status).toBe(200);
    expect(
      body.data.map((m) => m.id),
      'JWT scope 内只授权 model-a，应只返回它，而非全集',
    ).toEqual(['model-a']);
  });

  it('JWT allowedModels 多元素子集 → 应只返回子集（当前返回全集 → 红）', async () => {
    const { body } = await callModels(makeMockDb(ALL), {
      credentialType: 'jwt',
      allowedModels: ['model-a', 'model-b'],
    });
    expect(
      body.data.map((m) => m.id).toSorted(),
      '应只返回白名单内的模型',
    ).toEqual(['model-a', 'model-b']);
  });

  it('JWT allowedModels 含未上架模型 → 应只返回已上架且在白名单内的（交集）', async () => {
    const { body } = await callModels(makeMockDb(ALL), {
      credentialType: 'jwt',
      allowedModels: ['model-a', 'model-x-unpublished'],
    });
    expect(body.data.map((m) => m.id)).toEqual(['model-a']);
  });

  it('静态分析：models.ts 应基于 allowedModels 过滤（非空实现）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './models.ts'), 'utf8');
    // 期望源码引用 auth.allowedModels 并做 filter（不论分支写法），而非空注释
    expect(src, '应引用 auth.allowedModels').toMatch(/auth\.allowedModels/);
    expect(src, '应调用 isModelAllowed 或 filter').toMatch(/isModelAllowed|\.filter\(/);
  });
});
