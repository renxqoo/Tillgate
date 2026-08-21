/**
 * 压测数据种子（scripts/loadtest/seed-loadtest.ts）
 *
 * 建立压测专用闭环：用户（高额度+高限流）→ mock provider/channel（指向本地 mock-llm）→ 模型映射 → api_key。
 * 幂等：已存在则更新（如 mock 端口变了，刷新 channel.base_url_override 与 status）。
 *
 * 用法：bun scripts/loadtest/seed-loadtest.ts [--mock-port 9999]
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
  plans,
  userSubscriptions,
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
  ? (process.argv[process.argv.indexOf('--mock-port') + 1] ?? '9999')
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

// 压测 key：每次随机生成（不写死常量，防泄漏后被用于生产库）
const LOADTEST_API_KEY = 'ag_loadtest_sk_' + randomBytes(16).toString('hex');

async function main(): Promise<void> {
  // 生产门控：禁止在生产环境执行（防误跑创建高额度压测 key）
  if (process.env.NODE_ENV === 'production') {
    console.error('✗ 拒绝在生产环境执行 seed-loadtest（会创建高额度压测用户 + key）');
    process.exit(1);
  }

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
        balance: '1000', // 元；纯额度模型下余额不参与扣费，仅保持账户健康
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
      .set({ balance: '1000', status: 0, rpmLimit: 100_000, tpmLimit: 1_000_000_000 })
      .where(eq(users.id, user.id));
    console.log('✓ 用户 loadtest 已存在，已刷新余额/限流 (id=' + user.id + ')');
  }

  // 2. api_key（每次随机生成；旧 loadtest key 吊销而非删除——有 FK 关联 usage_logs）
  await db
    .update(apiKeys)
    .set({ status: 1 }) // 1=已吊销（保留行满足 FK，但不再可用）
    .where(
      and(eq(apiKeys.userId, user.id), eq(apiKeys.name, 'loadtest-key'), eq(apiKeys.status, 0)),
    );
  const keyHash = sha256hex(LOADTEST_API_KEY);
  await db.insert(apiKeys).values({
    keyHash,
    keyPreview: 'ag_****' + LOADTEST_API_KEY.slice(-4),
    userId: user.id,
    name: 'loadtest-key',
    status: 0,
    rpmLimit: 100_000,
    tpmLimit: 1_000_000_000,
  });
  console.log('✓ 创建压测 Key（随机生成，每次 seed 不同；旧 key 已吊销）');

  // 3. provider（mock）
  let provider = await db.query.providers?.findFirst?.({ where: eq(providers.name, 'mock') });
  if (!provider) {
    const [pr] = await db
      .insert(providers)
      .values({ name: 'mock', protocol: 'openai-compatible', baseUrl: MOCK_BASE_URL, status: 0 })
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
        upstreamBudget: '1000000000', // 进货额度给足：压测关注网关吞吐，不关注渠道预算耗尽
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
        upstreamBudget: '1000000000',
        upstreamReserved: '0',
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
        inputPrice: 1, // 1 元/M tokens —— 象征性，便于看计费链路
        outputPrice: 2,
        cacheInputPrice: 0.1,
      })
      .returning();
    mapping = m;
    console.log('✓ 创建 model mapping mock-gpt → mock-model');
  } else {
    await db
      .update(modelMappings)
      .set({ status: 0, realModel: 'mock-model', inputPrice: '1', outputPrice: '2', cacheInputPrice: '0.1' })
      .where(eq(modelMappings.id, mapping.id));
    console.log('✓ model mapping mock-gpt 已存在，已刷新');
  }

  // 5b. 有效订阅（订阅即闸门：无订阅 authorize 直接 402）——超大额度，压测只关注吞吐
  let plan = await db.query.plans?.findFirst?.({ where: eq(plans.name, 'loadtest-plan') });
  if (!plan) {
    const [pl] = await db
      .insert(plans)
      .values({
        name: 'loadtest-plan',
        kind: 'subscription',
        price: '0',
        periodDays: 3650,
        quotaAmount: '1000000000', // 10 亿额度，压测期间不可能耗尽
        sortOrder: null,
        status: 0,
      })
      .returning();
    plan = pl;
    console.log('✓ 创建 plan loadtest-plan');
  }
  const activeSub = await db.query.userSubscriptions?.findFirst?.({
    where: and(eq(userSubscriptions.userId, user.id), eq(userSubscriptions.status, 0)),
  });
  if (activeSub && activeSub.endAt > new Date()) {
    await db
      .update(userSubscriptions)
      .set({ quotaAmount: '1000000000', endAt: new Date(Date.now() + 3650 * 86_400_000) })
      .where(eq(userSubscriptions.id, activeSub.id));
    console.log('✓ 压测订阅已存在，已刷新额度/有效期');
  } else {
    if (activeSub) {
      // 过期但 status=0 的旧行会占用单有效订阅唯一索引，先转到期
      await db
        .update(userSubscriptions)
        .set({ status: 1 })
        .where(eq(userSubscriptions.id, activeSub.id));
    }
    await db.insert(userSubscriptions).values({
      userId: user.id,
      planId: plan.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 3650 * 86_400_000),
      quotaAmount: '1000000000',
      usedAmount: '0',
      reservedAmount: '0',
      quantity: 1,
      price: '0',
      status: 0,
    });
    console.log('✓ 创建压测订阅（额度 10 亿，有效期 3650 天）');
  }

  // 压测 Key 显式绑定压测订阅（换额度=换绑 key，AGENT.md §1 计费来源模型）；
  // 普通未绑 Key 永不消耗订阅额度——不补绑则资金瀑布 probe 恒 0（402）。
  const loadtestSub = (await db.query.userSubscriptions?.findFirst?.({
    where: and(eq(userSubscriptions.userId, user.id), eq(userSubscriptions.status, 0)),
  }))!;
  await db
    .update(apiKeys)
    .set({ subscriptionId: loadtestSub.id })
    .where(and(eq(apiKeys.userId, user.id), eq(apiKeys.name, 'loadtest-key'), eq(apiKeys.status, 0)));
  console.log('✓ 压测 Key 已绑定压测订阅');

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
  console.log(
    `    -d '{"model":"mock-gpt","messages":[{"role":"user","content":"hi"}],"stream":true}'`,
  );
  console.log('');

  await db.$client.end();
}

main().catch((e) => {
  console.error('✗ 种子失败:', e);
  process.exit(1);
});
