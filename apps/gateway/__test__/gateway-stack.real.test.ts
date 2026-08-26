/**
 * gateway 全栈真实契约（*.real.test.ts；默认门禁排除，test:real 显式运行）：
 * 真装配（assembleGateway：真 PG + 真 Redis + control-plane/billing/inference 桥）
 * × 隔离 schema（迁移链 0000–0054 回放，同 inference real 范式）。
 * 覆盖：catalog-port postgres 路径（系数三层/停用卡/渠道候选映射）、app 探针、
 * oauth→models 闭环（accounts 真读模型 + 双计数守卫经真 Redis）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '@tillgate/db';
import { loadGatewayConfig } from '../src/config';
import { assembleGateway, type GatewayAssembly } from '../src/assembly';
import { createGatewayApp } from '../src/app';
import { createPostgresGatewayCatalog } from '../src/adapters/catalog-port';
import { defined } from './defined';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const CLIENT_SECRET = 'it-secret';

describe.skipIf(url == null || redisUrl == null)('gateway 全栈（真实 PG + Redis）', () => {
  let db: Db;
  let schema = '';
  let assembly: GatewayAssembly;
  let app: ReturnType<typeof createGatewayApp>;
  const teardowns: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    schema = `tillgate_gw_${process.pid.toString(36)}_${Date.now().toString(36)}`;
    const [baseUrl] = defined(url, 'DB url').split('?');
    db = createDb({
      url: `${baseUrl}?options=-c%20search_path%3D${schema}`,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
    const migrationsDir = fileURLToPath(
      new URL('../../../packages/db/migrations', import.meta.url),
    );
    const { readdirSync } = await import('node:fs');
    await db.execute(sql.raw(`create schema ${schema}`));
    // 回放范围：0000–0054（db IMPLEMENTATION §6 探针结论的空库可推进范围）
    // + 独立 provision 风格加列件（0060-0064：api_keys.allow_payg_fallback /
    //   model_mappings.billing_config / providers.vendor / cache_write_price 族——
    //   if-not-exists、不依赖 identity 链；目录/渠道/鉴权读需要）
    const files = readdirSync(migrationsDir)
      .filter(
        (f) => /^\d{4}_.*\.sql$/.test(f) && (Number(f.slice(0, 4)) <= 54 || /^(006[0-4])/.test(f)),
      )
      .toSorted();
    for (const file of files) {
      const text = readFileSync(`${migrationsDir}/${file}`, 'utf8');
      for (const statement of text.split('--> statement-breakpoint')) {
        // "public". 限定 FK 剥离（迁移 SQL 不改；隔离 schema 回放适配——同 inference real）
        const trimmed = statement.trim().replaceAll('"public".', '');
        if (trimmed) await db.execute(sql.raw(trimmed));
      }
    }

    const one = async (statement: ReturnType<typeof sql>) => {
      const r = await db.execute(statement);
      return r[0] as Record<string, unknown>;
    };
    // 种子：用户（绑卡）+ 费率卡（global 0.8 / model 0.5）+ 目录 + fallback + 渠道 + Key + App
    const card = await one(sql`insert into rate_cards (name) values ('it-gw-card') returning id`);
    const owner = await one(sql`
      insert into users (issuer, subject, identity_provider, rate_card_id)
      values ('it-gw', 'owner', 'oidc', ${card.id}) returning id`);
    const mapping = await one(sql`
      insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price, pricing_group)
      values ('it-gpt-x', 'real-gpt-x', '1.5', '3', '1.5', 'openai') returning id`);
    await db.execute(sql`
      insert into rate_card_coefficients (rate_card_id, scope, model_mapping_id, coefficient)
      values (${card.id}, 'global', null, '0.8'), (${card.id}, 'model', ${mapping.id}, '0.5')`);
    await one(sql`
      insert into model_mappings (external_name, real_model) values ('it-gpt-fb', 'real-gpt-fb') returning id`);
    await db.execute(
      sql`update model_mappings set fallback_models = '["it-gpt-fb"]'::jsonb where id = ${mapping.id}`,
    );
    const provider = await one(sql`
      insert into providers (name, base_url, protocol, vendor)
      values ('it-up', 'https://up.example/v1', 'openai-compatible', 'openai') returning id`);
    const channel = await one(sql`
      insert into channels (provider_id, name, api_key_enc, rpm_limit)
      values (${provider.id}, 'it-ch', 'enc:v1:x', 100) returning id`);
    await db.execute(sql`
      insert into model_channels (mapping_id, channel_id, weight, priority)
      values (${mapping.id}, ${channel.id}, 3, 2)`);
    await one(sql`
      insert into api_keys (key_hash, key_preview, user_id, name)
      values (${createHash('sha256').update('sk_it-real-key').digest('hex')}, 'sk_…', ${owner.id}, 'it-key') returning id`);
    await one(sql`
      insert into apps (app_id, user_id, client_id, client_secret_hash, name)
      values ('it-app-1', ${owner.id}, 'it-ci', ${createHash('sha256').update(CLIENT_SECRET).digest('hex')}, 'it-app') returning id`);

    // 全装配（配置直指隔离 schema 的 PG 与本机 Redis）
    const config = loadGatewayConfig({
      DATABASE_URL: `${baseUrl}?options=-c%20search_path%3D${schema}`,
      REDIS_URL: defined(redisUrl, 'REDIS_URL'),
      CHANNEL_API_KEY_ENCRYPTION: 'aB3daB3daB3daB3daB3daB3daB3daB3d',
      JWT_SECRET: 'eF5geF5geF5geF5geF5geF5geF5geF5g',
      NODE_ENV: 'test',
      OTEL_TRACES_MODE: 'off',
    });
    assembly = assembleGateway(config);
    app = createGatewayApp({
      inference: assembly.inference,
      reader: {
        resolveKeyByHash: (h) => assembly.accounts.resolveKeyByHash(h),
        resolveApp: (appId) => assembly.accounts.resolveApp(appId),
      },
      verifyAppClient: (input) => assembly.accounts.verifyAppClient(input),
      models: assembly.modelsReader,
      requestLogs: assembly.requestLogs,
      pingDb: assembly.pingDb,
      redisProbe: assembly.redis,
      authGuards: assembly.authGuards,
      oauth: {
        jwtSecret: config.oauth.jwtSecret,
        issuer: config.oauth.issuer,
        audience: config.oauth.audience,
        keyPrefix: config.keyPrefix,
        tokenTtlSeconds: config.oauth.tokenTtlSeconds,
      },
      rateLimit: assembly.rateLimit,
      oauthIpGuard: assembly.authGuards.ipGuard,
      trustedProxyHops: 0,
    });
    teardowns.push(async () => {
      assembly.inference.close();
      await assembly.redis.quit();
      await assembly.closeDb();
    });
  });

  afterAll(async () => {
    for (const t of teardowns.toReversed()) await t();
    if (schema) await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await closeDb(db);
  });

  it('探针：healthz/readyz 双依赖（PG + Redis）全通', async () => {
    const res = await app.request('/healthz');
    if (res.status !== 200) console.log('HEALTHZ BODY:', await res.text());
    expect(res.status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
    expect((await app.request('/livez')).status).toBe(200);
  });

  it('catalog-port postgres 路径：model 行系数 0.5 优先 + fallback 链 + 渠道候选（限流列）', async () => {
    const catalog = createPostgresGatewayCatalog(assembly.db, {
      ttlMs: 60_000,
      fallback: 'Asia/Shanghai',
    });
    const snap = defined(
      await catalog.findMapping('it-gpt-x', {
        userId: Number(await scalarUserId()),
        body: {},
        now: new Date(),
      }),
      'snap',
    );
    // numeric 列原样全标度字符串（运算归 billing Decimal——快照只透传）
    expect(Number(snap.coefficient)).toBe(0.5); // model 行 0.5 > global 0.8
    expect(Number(snap.inputPrice)).toBe(1.5);
    expect(snap).toMatchObject({
      mappingId: expect.any(Number),
      externalModel: 'it-gpt-x',
      realModel: 'real-gpt-x',
      fallbackModels: ['it-gpt-fb'],
    });
    const channels = await catalog.resolveChannels('real-gpt-x');
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      channelId: expect.any(Number),
      channelName: 'it-ch',
      protocol: 'openai-compatible',
      baseUrl: 'https://up.example/v1',
      rpmLimit: 100,
      priority: 2,
      weight: 3,
    });
    // 未绑卡用户 → 快照照常（无卡恒系数 1——v1 buildQuote 语义）
    const other = await catalog.findMapping('it-gpt-x', {
      userId: 999_999,
      body: {},
      now: new Date(),
    });
    expect(other).not.toBeNull();
    expect(defined(other, 'other').coefficient).toBe('1');
    // 未知模型 → null（status 过滤 + 未命中）
    expect(
      await catalog.findMapping('no-such-model', { userId: 1, body: {}, now: new Date() }),
    ).toBeNull();
  });

  it('静态 Key 鉴权 + /v1/models（真实 resolveKeyByHash + 未知 Key 401 经真 guard）', async () => {
    const ok = await app.request('/v1/models', {
      headers: { authorization: 'Bearer sk_it-real-key' },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain('it-gpt-x');

    const unknown = await app.request('/v1/models', {
      headers: { authorization: 'Bearer sk_not-a-real-key' },
    });
    expect(unknown.status).toBe(401);
  });

  it('oauth → models 闭环：正确凭证签发 app_jwt → Bearer 列目录；错凭证 401', async () => {
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'it-ci',
        client_secret: CLIENT_SECRET,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: token } = (await tokenRes.json()) as { access_token: string };
    const listRes = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as { data: unknown[] }).data).toHaveLength(2);

    const bad = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'it-ci',
        client_secret: 'wrong',
      }),
    });
    expect(bad.status).toBe(401);
  });

  /** owner 用户 id（种子行） */
  async function scalarUserId(): Promise<string | number> {
    const r = await db.execute(sql`select id from users where issuer = 'it-gw' limit 1`);
    return (r[0] as { id: string | number }).id;
  }
});
