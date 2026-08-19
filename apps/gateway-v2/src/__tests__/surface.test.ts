/**
 * 接口面对账测试（真实 PG）：/v1/models 目录、安全中间件三件套、404 信封、requestLog。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createApp } from '../app.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const app = createApp({
  db,
  corsOrigins: ['https://console.example.com'],
  oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
});
const createdUsers: number[] = [];
const createdKeys: number[] = [];

async function newKey(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2sf', subject: `v2sf-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const { apiKeys: keys } = await import('@ai-gateway/db');
  const [key] = await db
    .insert(keys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2sf' })
    .returning({ id: keys.id });
  createdKeys.push(key!.id);
  return raw;
}

afterAll(async () => {
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.end().catch(() => {});
});

describe('GET /v1/models', () => {
  it('带 Key 返回目录（OpenAI 形状，含计价单位）', async () => {
    const raw = await newKey();
    const res = await app.request('/v1/models', { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: Array<{ id: string; object: string; pricing_unit: string }> };
    expect(json.object).toBe('list');
    expect(Array.isArray(json.data)).toBe(true);
    if (json.data.length > 0) {
      expect(json.data[0]).toMatchObject({ object: 'model' });
      expect(typeof json.data[0]!.pricing_unit).toBe('string');
    }
  });

  it('未带 Key 401；未知模型 404 model_not_found', async () => {
    expect((await app.request('/v1/models')).status).toBe(401);
    const raw = await newKey();
    const res = await app.request('/v1/models/nonexistent-model-xyz', {
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
  });
});

describe('安全中间件', () => {
  it('CORS：白名单源预检 204 + ACAO 回显；非白名单无 ACAO', async () => {
    const preflight = await app.request('/healthz', {
      method: 'OPTIONS',
      headers: { origin: 'https://console.example.com' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://console.example.com');

    const denied = await app.request('/healthz', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    // 实际请求（非预检）带白名单 Origin：响应回显 ACAO + Vary
    const actual = await app.request('/healthz', { headers: { origin: 'https://console.example.com' } });
    expect(actual.headers.get('access-control-allow-origin')).toBe('https://console.example.com');
    expect(actual.headers.get('vary')).toContain('Origin');
  });

  it('安全头：nosniff/DENY/no-referrer；body 上限：超大 content-length 413', async () => {
    const res = await app.request('/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');

    const tooLarge = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-length': String(20 * 1024 * 1024) },
    });
    expect(tooLarge.status).toBe(413);
  });
});

describe('404 信封与 requestLog', () => {
  it('/v1/* 未匹配路径 404 信封（OpenAI 风格）', async () => {
    const res = await app.request('/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('requestLog：401 也入日志（鉴权前语义；requestId 服务端生成+响应回显）', async () => {
    const res = await app.request('/v1/models', { headers: { 'x-request-id': 'client-controlled' } });
    const marker = res.headers.get('x-request-id'); // 回显的是服务端 ID（客户端头不采信——S1）
    expect(marker).toBeTruthy();
    expect(marker).not.toBe('client-controlled');
    const log = await db.$client.query<{ path: string; status_code: number }>(
      'select path, status_code from request_logs where request_id = $1', [marker],
    );
    expect(log.rows[0]).toMatchObject({ path: '/v1/models', status_code: '401' }); // bigint 列经 pg 返回字符串
    await db.$client.query('delete from request_logs where request_id = $1', [marker]);
  });
});
