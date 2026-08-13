/**
 * 开发环境种子数据（packages/db/scripts/seed-dev.ts）
 * 插入最小闭环所需：用户 + 费率卡(系数1.0) + 管理员 + 测试虚拟Key + 供应商 + 渠道 + 模型映射。
 *
 * 用法：pnpm tsx packages/db/scripts/seed-dev.ts
 *   从 .env 读 DATABASE_URL / ENCRYPTION_KEY / DEEPSEEK_* / MINIMAX_*
 *   幂等：已存在的数据跳过（按唯一键判断）
 *
 * 输出：测试用虚拟 Key 明文（ag_xxx），用于 curl 测试。
 * 金额单位：元（numeric 全精度），价格单位为「元/百万 token」。
 */
import { createDb } from '../src/index.js';
import {
  users,
  admins,
  rateCards,
  rateCardCoefficients,
  apiKeys,
  providers,
  channels,
  modelMappings,
  modelChannels,
} from '../src/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { encrypt } from '@ai-gateway/core';

// ---- scrypt 哈希（与 @ai-gateway/identity/password.ts 同格式；seed 脚本独立实现避免 db→identity 循环依赖） ----
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 32;
async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plaintext, salt, HASH_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 512 * 1024 * 1024,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// ---- .env 加载（从 cwd 向上查找 monorepo 根） ----
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

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---- 测试用虚拟 Key（明文只在此次输出，落库的是哈希） ----
const TEST_API_KEY = 'ag_test_dev_key_sk_' + randomBytes(8).toString('hex');

async function main() {
  const db = createDb(DATABASE_URL);
  console.log('→ 连接 DB:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

  // 1. 费率卡（系数 1.0）
  let card = await db.query.rateCards?.findFirst?.({ where: eq(rateCards.name, '标准') });
  if (!card) {
    const [c] = await db
      .insert(rateCards)
      .values({ name: '标准', description: '标准定价 1.0x' })
      .returning();
    card = c;
    await db
      .insert(rateCardCoefficients)
      .values({ rateCardId: c.id, scope: 'global', coefficient: '1.000' });
    console.log('✓ 创建费率卡「标准」(系数 1.0)');
  }

  // 2. 用户（本地账号，绑定费率卡，开发余额 ¥1000）
  let user = await db.query.users?.findFirst?.({
    where: and(eq(users.issuer, 'local'), eq(users.subject, 'dev')),
  });
  if (!user) {
    const [u] = await db
      .insert(users)
      .values({
        issuer: 'local',
        subject: 'dev',
        identityProvider: 'local',
        email: 'dev@ai-gateway.local',
        displayName: 'Dev User',
        rateCardId: card.id,
        balance: '1000', // ¥1000（元）—— 开发用，足够测试
      })
      .returning();
    user = u;
    console.log('✓ 创建用户 dev (id=' + u.id + ')');
  }

  // 3. 管理员（admins 表，邀请制。测试账号 admin@ai-gateway.local / admin12345）
  const adminEmail = 'admin@ai-gateway.local';
  const existingAdmin = await db.query.admins?.findFirst?.({ where: eq(admins.email, adminEmail) });
  if (!existingAdmin) {
    const passwordHash = await hashPassword('admin12345');
    await db.insert(admins).values({
      email: adminEmail,
      displayName: 'Dev Admin',
      passwordHash,
      status: 0,
    });
    console.log('✓ 创建管理员 admin@ai-gateway.local (密码 admin12345，仅开发用)');
  }

  // 4. 测试虚拟 Key
  const keyHash = sha256hex(TEST_API_KEY);
  const existingKey = await db.query.apiKeys?.findFirst?.({ where: eq(apiKeys.keyHash, keyHash) });
  if (!existingKey) {
    await db.insert(apiKeys).values({
      keyHash,
      keyPreview: 'ag_****' + TEST_API_KEY.slice(-4),
      userId: user.id,
      name: 'dev-test-key',
      status: 0,
    });
    console.log('✓ 创建测试虚拟 Key');
  }

  // 5. 供应商 + 渠道（DeepSeek + MiniMax）
  // 占位价（元/百万 token）——上线前请按实际成本调整
  const providerData = [
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
      realModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      price: { input: '0.001', output: '0.002', cache: '0.0001' },
    },
    {
      name: 'minimax',
      baseUrl: 'https://api.minimaxi.com',
      apiKey: process.env.MINIMAX_API_KEY,
      model: 'MiniMax-M3',
      realModel: 'MiniMax-M3',
      price: { input: '0.001', output: '0.002', cache: '0.0002' },
    },
  ];

  for (const p of providerData) {
    if (!p.apiKey) {
      console.warn(`⚠ ${p.name} API_KEY 未配置，跳过该供应商`);
      continue;
    }
    // provider
    let provider = await db.query.providers?.findFirst?.({ where: eq(providers.name, p.name) });
    if (!provider) {
      const [pr] = await db
        .insert(providers)
        .values({ name: p.name, protocol: 'openai_compatible', baseUrl: p.baseUrl })
        .returning();
      provider = pr;
    }
    // channel（加密 key）
    let channel = await db.query.channels?.findFirst?.({
      where: eq(channels.name, p.name + '-default'),
    });
    if (!channel) {
      const [ch] = await db
        .insert(channels)
        .values({
          providerId: provider.id,
          name: p.name + '-default',
          apiKeyEnc: encrypt(p.apiKey, ENCRYPTION_KEY),
          status: 0,
          weight: 1,
          priority: 0,
        })
        .returning();
      channel = ch;
    }
    // model mapping
    let mapping = await db.query.modelMappings?.findFirst?.({
      where: eq(modelMappings.externalName, p.model),
    });
    if (!mapping) {
      const [m] = await db
        .insert(modelMappings)
        .values({
          externalName: p.model,
          realModel: p.realModel,
          status: 0,
          inputPrice: p.price.input,
          outputPrice: p.price.output,
          cacheInputPrice: p.price.cache,
        })
        .returning();
      mapping = m;
    }
    // model_channels 关联
    const exists = await db.query.modelChannels?.findFirst?.({
      where: and(eq(modelChannels.mappingId, mapping.id), eq(modelChannels.channelId, channel.id)),
    });
    if (!exists) {
      await db
        .insert(modelChannels)
        .values({ mappingId: mapping.id, channelId: channel.id, weight: 1, priority: 0 });
    }
    console.log(`✓ ${p.name}: provider + channel + mapping(${p.model})`);
  }

  console.log('\n========================================');
  console.log('  种子数据完成');
  console.log('========================================');
  console.log('测试虚拟 Key（curl 用，仅显示一次）:');
  console.log('  ' + TEST_API_KEY);
  console.log('\ncurl 示例:');
  console.log(`  curl http://localhost:8787/v1/chat/completions \\`);
  console.log(`    -H "Authorization: Bearer ${TEST_API_KEY}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(
    `    -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'`,
  );
  console.log('');

  await db.$client.end();
}

main().catch((e) => {
  console.error('✗ 种子失败:', e);
  process.exit(1);
});
