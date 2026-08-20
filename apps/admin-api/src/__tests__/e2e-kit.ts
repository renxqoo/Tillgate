/**
 * admin-api E2E 共享基建：真服务进程（全真装配：真 DB/真 wallet/真幂等内核）
 * + 种子管理员 + HTTP 助手 + 清理台账。与 client-api e2e-kit 同哲学：
 * 不 mock 业务；可变值（JWT/加密钥/凭证目录）注入测试值。
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import {
  admins,
  apiKeys,
  channelRecharges,
  channels,
  modelChannels,
  modelMappings,
  plans,
  providers,
  rateCardCoefficients,
  rateCards,
  redeemBatches,
  redeemCodes,
  userSubscriptions,
  users,
} from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { hashPassword } from '@ai-gateway/identity-core';
import { assembleAdminApi } from '../assembly.js';
import { createApp } from '../app.js';
import type { AdminApiConfig } from '../config.js';

export const E2E_ADMIN_JWT = 'aav2-e2e-jwt-secret-0123456789abcdef';
export const E2E_PASSWORD = 'correct-horse-battery';
export const E2E_ENCRYPTION_KEY = 'a'.repeat(32);

export function e2eDb(): Db {
  return createDb(
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    { poolMax: 5 },
  );
}

export function e2eAdminConfig(overrides: Partial<AdminApiConfig> = {}): AdminApiConfig {
  return {
    DATABASE_URL: 'postgres://unused',
    PORT: 0,
    DB_POOL_MAX: 5,
    ADMIN_JWT_SECRET: E2E_ADMIN_JWT,
    SESSION_TTL_SECONDS: 3_600,
    ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    LOGIN_FAILURE_THRESHOLD: 5,
    LOGIN_FAILURE_WINDOW_S: 600,
    LOGIN_LOCK_S: 600,
    LOGIN_IP_FAILURE_LIMIT: 50,
    LOGIN_IP_FAILURE_WINDOW_S: 300,
    ALLOW_LOCAL_UPSTREAM: false,
    CHANNEL_IMPORT_MAX: 1000,
    CATALOG_FREE_CHANNEL_RPM: 20,
    CATALOG_FREE_CHANNEL_BUDGET: '1000000',
    CATALOG_CACHE_TTL_MS: 600_000,
    SMTP_PORT: 465,
    ADMIN_CURRENCY: 'CNY',
    VOUCHER_MAX_BYTES: 2_097_152,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://:root123@localhost:6379',
    CORS_ORIGINS: '',
    BODY_LIMIT_BYTES: 4_194_304,
    ADMIN_SHUTDOWN_GRACE_MS: 1_000,
    OTEL_TRACES_MODE: 'off' as const,
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    TRUSTED_PROXY_HOPS: 0,
    ...overrides,
  };
}

export interface E2EAdminApi {
  baseUrl: string;
  db: Db;
  stop(): Promise<void>;
}

/** 起真 admin-api（全真装配；extra 覆盖配置） */
export async function startAdminApi(db: Db, extra: Partial<AdminApiConfig> = {}): Promise<E2EAdminApi> {
  const config = e2eAdminConfig(extra);
  const assembly = assembleAdminApi(config, db);
  const app = createApp({
    db,
    assembly,
    jwtSecret: config.ADMIN_JWT_SECRET,
    corsOrigins: [],
    bodyLimitBytes: config.BODY_LIMIT_BYTES,
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    baseUrl,
    db,
    async stop() {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ────────────────────────── HTTP 助手 ──────────────────────────

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  text: string;
}

export async function http(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers, text };
}

// ────────────────────────── 种子与清理台账 ──────────────────────────

const seededAdmins: number[] = [];
const createdUsers: number[] = [];
const createdPlans: number[] = [];
const createdBatches: number[] = [];
const createdCards: number[] = [];
const createdProviders: number[] = [];
const createdChannels: number[] = [];
const createdMappings: number[] = [];
const createdApiKeys: number[] = [];

export const e2eUid = (tag: string): string => `aav2e2e-${tag}-${randomUUID().slice(0, 8)}`;

/** 种子管理员（真实 scrypt 哈希）；E2E 一律走 HTTP 登录拿 Bearer */
export async function seedAdmin(db: Db): Promise<{ email: string; password: string }> {
  const email = `${e2eUid('admin')}@example.com`;
  const [row] = await db
    .insert(admins)
    .values({ email, displayName: 'e2e-admin', passwordHash: await hashPassword(E2E_PASSWORD) })
    .returning({ id: admins.id });
  seededAdmins.push(row!.id);
  return { email, password: E2E_PASSWORD };
}

/** HTTP 登录 → Bearer token（E2E 的唯一凭证入口） */
export async function loginAdmin(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await http(baseUrl, '/v1/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return res.body.token as string;
}

export async function seedE2EUser(db: Db): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'local', subject: e2eUid('user'), identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

export const trackE2E = {
  user: (id: number) => void createdUsers.push(id),
  plan: (id: number) => void createdPlans.push(id),
  batch: (id: number) => void createdBatches.push(id),
  card: (id: number) => void createdCards.push(id),
  provider: (id: number) => void createdProviders.push(id),
  channel: (id: number) => void createdChannels.push(id),
  mapping: (id: number) => void createdMappings.push(id),
  apiKey: (id: number) => void createdApiKeys.push(id),
};

export async function cleanupE2E(db: Db): Promise<void> {
  if (createdUsers.length) {
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.userId, createdUsers));
    await db.delete(apiKeys).where(inArray(apiKeys.userId, createdUsers));
    await db.update(redeemCodes).set({ usedBy: null }).where(inArray(redeemCodes.usedBy, createdUsers));
    await db.update(users).set({ rateCardId: null }).where(inArray(users.id, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  if (createdBatches.length) {
    await db.delete(redeemCodes).where(inArray(redeemCodes.batchId, createdBatches));
    await db.delete(redeemBatches).where(inArray(redeemBatches.id, createdBatches));
  }
  if (createdCards.length) {
    await db.delete(rateCardCoefficients).where(inArray(rateCardCoefficients.rateCardId, createdCards));
    await db.delete(rateCards).where(inArray(rateCards.id, createdCards));
  }
  if (createdMappings.length) {
    await db.delete(modelChannels).where(inArray(modelChannels.mappingId, createdMappings));
    await db.delete(modelMappings).where(inArray(modelMappings.id, createdMappings));
  }
  if (createdChannels.length) {
    await db.delete(channelRecharges).where(inArray(channelRecharges.channelId, createdChannels));
    await db.delete(modelChannels).where(inArray(modelChannels.channelId, createdChannels));
    await db.delete(channels).where(inArray(channels.id, createdChannels));
  }
  if (createdProviders.length) {
    await db.delete(providers).where(inArray(providers.id, createdProviders));
  }
  if (createdPlans.length) await db.delete(plans).where(inArray(plans.id, createdPlans));
  if (createdApiKeys.length) await db.delete(apiKeys).where(inArray(apiKeys.id, createdApiKeys));
  if (seededAdmins.length) await db.delete(admins).where(inArray(admins.id, seededAdmins));
  await db.$client.end().catch(() => {});
}
