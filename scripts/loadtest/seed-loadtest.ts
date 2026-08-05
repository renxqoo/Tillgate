/**
 * 压测数据种子（scripts/loadtest/seed-loadtest.ts）
 *
 * 建立压测专用闭环：用户（高额度+高限流）→ mock provider/channel（指向本地 mock-llm）→ 模型映射 → api_key。
 * 幂等：已存在则更新（如 mock 端口变了，刷新 channel.base_url_override 与 status）。
 *
 * 用法：tsx scripts/loadtest/seed-loadtest.ts [--mock-port 9999]
 *
 * 输出：压测用 api_key 明文（仅显示一次）。
 */
import { createDb } from '../../packages/db/src/index.js';
import {
  users,
  apiKeys,
  providers,
  channels,
  modelMappings,
  modelChannels,
} from '../../packages/db/src/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';

// ---- .env 加载（从 cwd 向上找 monorepo 根，与 seed-dev.ts 同逻辑） ----
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
function findEnv(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) return f;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
const envPath = findEnv();
if (envPath) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  console.error('✗ ENCRYPTION_KEY 未设置或不足 32 字符（.env）');
  process.exit(1);
}

const MOCK_PORT = process.argv.includes('--mock-port')
  ? process.argv[process.argv.indexOf('--mock-port') + 1] ?? '9999'
  : '9999';
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

// ---- AES-256-GCM（与 gateway/src/lib/crypto.ts + seed-dev.ts 逐字节一致） ----
function encrypt(plaintext: string): string {
  const key = createHash('sha256').update(ENCRYPTION_KEY).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// 固定的压测 key（幂等：每次 seed 不换 key，避免拿到一堆一次性 key）
const LOADTEST_API_KEY = 'ag_loadtest_sk_fixed_do_not_use_in_prod';

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL);
  console.log('→ 连接 DB:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
  console.log('→ mock 上游:', MOCK_BASE_URL);

  // 1. 用户（高余额 + 高限流，避开默认 60 RPM）
  let user = await db.query.users?.findFirst?.({
    where: and(eq(users.issuer, 'local'), eq(users.subject, 'loadtest')),
  });
  if (!user) {
    const [u] = await db
      .insert(users)
      .values({
        issuer: 'local',
        subject: 'loadtest',
        identityProvider: 'local',
        email: 'loadtest@ai-gateway.local',
        displayName: 'Load Test',
        role: 0,
        balance: 1_000_000_000, // ¥1,000,000（厘）
        status: 0,
        rpmLimit: 100_000, // 远超 GLOBAL_RPM=2000（让全局限流成为天花板，而非用户限流）
        tpmLimit: 1_000_000_000,
      })
      .returning();
    user = u;
    console.log('✓ 创建用户 loadtest (id=' + u.id + ')');
  } else {
    // 已存在：确保高余额（用户可能跑过多次，余额被扣）
    await db
      .update(users)
      .set({ balance: 1_000_000_000, status: 0, rpmLimit: 100_000, tpmLimit: 1_000_000_000 })
      .where(eq(users.id, user.id));
    console.log('✓ 用户 loadtest 已存在，已刷新余额/限流 (id=' + user.id + ')');
  }

  // 2. api_key（固定明文，便于反复 seed 后还能用同一 key）
  const keyHash = sha256hex(LOADTEST_API_KEY);
  const existingKey = await db.query.apiKeys?.findFirst?.({ where: eq(apiKeys.keyHash, keyHash) });
  if (!existingKey) {
    await db.insert(apiKeys).values({
      keyHash,
      keyPreview: 'ag_****loadtest',
      userId: user.id,
      name: 'loadtest-key',
      status: 0,
      rpmLimit: 100_000,
      tpmLimit: 1_000_000_000,
    });
    console.log('✓ 创建压测 Key');
  } else {
    // 已存在：确保有效（可能被误改状态）
    await db
      .update(apiKeys)
      .set({ status: 0, userId: user.id, rpmLimit: 100_000, tpmLimit: 1_000_000_000 })
      .where(eq(apiKeys.id, existingKey.id));
    console.log('✓ 压测 Key 已存在，已刷新状态/限流');
  }

  // 3. provider（mock）
  let provider = await db.query.providers?.findFirst?.({ where: eq(providers.name, 'mock') });
  if (!provider) {
    const [pr] = await db
      .insert(providers)
      .values({ name: 'mock', protocol: 'openai_compatible', baseUrl: MOCK_BASE_URL, status: 0 })
      .returning();
    provider = pr;
    console.log('✓ 创建 provider mock');
  } else {
    await db
      .update(providers)
      .set({ baseUrl: MOCK_BASE_URL, status: 0 })
      .where(eq(providers.id, provider.id));
    console.log('✓ provider mock 已存在，已刷新 baseUrl/status');
  }

  // 4. channel（指向 mock，固定 dummy key 经加密入库）
  const DUMMY_UPSTREAM_KEY = 'sk-mock-loadtest-no-real-value';
  const encKey = encrypt(DUMMY_UPSTREAM_KEY);
  let channel = await db.query.channels?.findFirst?.({ where: eq(channels.name, 'mock-default') });
  if (!channel) {
    const [ch] = await db
      .insert(channels)
      .values({
        providerId: provider.id,
        name: 'mock-default',
        apiKeyEnc: encKey,
        baseUrlOverride: MOCK_BASE_URL,
        status: 0,
        weight: 1,
        priority: 0,
      })
      .returning();
    channel = ch;
    console.log('✓ 创建 channel mock-default');
  } else {
    // 已存在：刷新 baseUrl（端口可能变）+ 重置 status=0（可能被熔断成 3/4）
    await db
      .update(channels)
      .set({
        baseUrlOverride: MOCK_BASE_URL,
        apiKeyEnc: encKey,
        status: 0,
        failCount: 0,
        cooldownUntil: null,
      })
      .where(eq(channels.id, channel.id));
    console.log('✓ channel mock-default 已存在，已刷新 baseUrl/status（含熔断重置）');
  }

  // 5. model mapping（external=mock-gpt → real=mock-model，定价 1 厘/M 象征性）
  let mapping = await db.query.modelMappings?.findFirst?.({
    where: eq(modelMappings.externalName, 'mock-gpt'),
  });
  if (!mapping) {
    const [m] = await db
      .insert(modelMappings)
      .values({
        externalName: 'mock-gpt',
        realModel: 'mock-model',
        status: 0,
        inputPrice: 1_000_000, // 1 元/M（厘）—— 象征性，便于看计费链路
        outputPrice: 2_000_000,
        cacheInputPrice: 100_000,
      })
      .returning();
    mapping = m;
    console.log('✓ 创建 model mapping mock-gpt → mock-model');
  } else {
    await db
      .update(modelMappings)
      .set({ status: 0, realModel: 'mock-model' })
      .where(eq(modelMappings.id, mapping.id));
    console.log('✓ model mapping mock-gpt 已存在，已刷新');
  }

  // 6. model_channels 关联
  const exists = await db.query.modelChannels?.findFirst?.({
    where: and(eq(modelChannels.mappingId, mapping.id), eq(modelChannels.channelId, channel.id)),
  });
  if (!exists) {
    await db
      .insert(modelChannels)
      .values({ mappingId: mapping.id, channelId: channel.id, weight: 1, priority: 0 });
    console.log('✓ 关联 model_channels (mock-gpt ↔ mock-default)');
  }

  console.log('\n========================================');
  console.log('  压测种子完成');
  console.log('========================================');
  console.log('压测用 Key:');
  console.log('  ' + LOADTEST_API_KEY);
  console.log('\nmock 上游:');
  console.log('  ' + MOCK_BASE_URL);
  console.log('\ncurl 示例（流式）:');
  console.log(`  curl http://localhost:8787/v1/chat/completions \\`);
  console.log(`    -H "Authorization: Bearer ${LOADTEST_API_KEY}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"model":"mock-gpt","messages":[{"role":"user","content":"hi"}],"stream":true}'`);
  console.log('');

  await db.$client.end();
}

main().catch((e) => {
  console.error('✗ 种子失败:', e);
  process.exit(1);
});
