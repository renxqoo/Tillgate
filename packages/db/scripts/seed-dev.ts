/**
 * 开发环境种子数据（packages/db/scripts/seed-dev.ts，自 v1 ai-getway 同位置脚本移植，IMPLEMENTATION.md C5）
 * 插入最小闭环所需：用户 + 费率卡(系数1.0) + 管理员 + 测试虚拟Key + 供应商 + 渠道 + 模型映射。
 *
 * 用法：cd packages/db && bun scripts/seed-dev.ts（或在仓库根 bun packages/db/scripts/seed-dev.ts）
 *   从 .env（cwd 向上查找 monorepo 根）读：
 *     DATABASE_URL          必填——v1 的硬编码默认连接串已按零写死裁决（B2/D5）删除，缺失即报错退出；
 *     ENCRYPTION_KEY        必填 ≥32 字符——渠道上游 Key 加密密钥（runtime cipher 同款契约）；
 *     DEEPSEEK_API_KEY(+DEEPSEEK_MODEL) / MINIMAX_API_KEY  可选——
 *       （供应商键缺失则跳过该供应商整段；baseUrl/模型名/占位价本脚本固定，env 契约唯一文档处在此）
 *   幂等：按唯一键判存跳过（费率卡/用户/管理员/供应商/渠道/映射/关联）；
 *     注意测试虚拟 Key 段因明文随机生成，每次运行必新插一把（v1 行为原样，旧库已验证兼容）。
 *
 * 与 v1 的行为差异（表/列以 v2 schema 为准）：
 *   1. users 不再插 balance '1000'——v2 资金事实唯一在 wallet（users.ts 注释明示，无 balance 列），
 *      开发余额初始化归 wallet 能力波次的 provision 动词，seed 不手工造资金行；
 *   2. createDb 收全必填配置对象（v2 契约，池参数由本脚本作为装配层注入字面量）；
 *   3. 渠道 Key 加密改用 @tillgate/runtime 的 AES-256-GCM cipher（enc:v1，与 v1 存量密文逐字节兼容）；
 *   4. 收口走 closeDb(db)（v2 facade 不泄漏 pg 池对象）。
 *
 * 用户与测试 Key 不再播种：C 端自助注册 + 控制台建 Key 完整覆盖（2026-08-24 瘦身）。
 * 金额单位：元（numeric 全精度），价格单位为「元/百万 token」。
 */
import { createDb, closeDb, ACCOUNT_STATUS, roles, type Db } from '../src/index.js';
import {
  admins,
  rateCards,
  rateCardCoefficients,
  providers,
  channels,
  modelMappings,
  modelChannels,
} from '../src/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
// cipher 经相对路径注入而非包名：db 是零内部依赖包（依赖白名单仅 @tillgate/errors，
// IMPLEMENTATION.md §6），不得把 runtime 写进 db 的 package.json；本脚本是 dev 装配面
// （文档「dev 装配波次」口径），跨包装配允许直达源文件——bun 的 workspace 隔离安装下
// 未声明依赖无法按包名解析，相对路径是唯一不破坏依赖纪律的接入方式。
// 只引 cipher 模块文件（其仅依赖 node:crypto + @tillgate/errors），不引 runtime 根出口，
// 避免 typecheck 闭包卷入 runtime 的 ioredis/pino 等依赖。
import { createCipher } from '../../runtime/src/crypto/cipher.js';

// ---- scrypt 哈希（独立实现随迁：格式与 v1 identity-core/password.ts 逐字一致
// `scrypt:N:r:p:<saltHex>:<hashHex>`，生产存量 password_hash 原样可校验；
// seed 独立实现避免 db → identity 依赖。注意：v2 schema 列注释写作「saltHex:hashHex:N:r:p」
// 是 v1 就有的注释漂移（v2 原样复制），行为真相以 identity-core 实现格式为准，不改 schema。）----
// eslint-disable-next-line max-params -- node:crypto scrypt 原生四参签名（password/salt/keylen/options）的类型镜像，非本仓可改的参数形态
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

// ---- .env 加载（从 cwd 向上查找 monorepo 根；bun 只自动加载 cwd 的 .env，包目录下需自寻）----
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
    if (m) {
      // 解构后判存注入：与原 m[1]/m[2] 下标访问逐字等价（key 为空串时同样跳过）
      const [, key, value] = m;
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
}

// v1 的默认连接串已删除（B2/D5 裁决：零隐藏默认）——缺失显式报错；
// requireEnv 即时收窄（模块级 if 收窄不进闭包，函数返回 string 免去 main 内二次判空）
function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`✗ ${key} 未设置（.env；v2 无默认连接串，零写死裁决 B2/D5）`);
    process.exit(1);
  }
  return v;
}
const DATABASE_URL = requireEnv('DATABASE_URL');
const ENCRYPTION_KEY = requireEnv('ENCRYPTION_KEY');
if (ENCRYPTION_KEY.length < 32) {
  console.error('✗ ENCRYPTION_KEY 不足 32 字符（.env）');
  process.exit(1);
}

// ---- 测试用虚拟 Key（明文只在此次输出，落库的是哈希；随机故每次运行新插一把，v1 行为） ----

// 各播种步骤按唯一键判存幂等（互相独立查存,不回读对方内部状态——铁律 22② 拆分）

/** 1. 费率卡（系数 1.0）：不存在则建卡 + 全局系数行 */
async function seedRateCard(db: Db): Promise<void> {
  let card = await db.query.rateCards.findFirst({ where: eq(rateCards.name, '标准') });
  if (!card) {
    const [c] = await db
      .insert(rateCards)
      .values({ name: '标准', description: '标准定价 1.0x' })
      .returning();
    // noUncheckedIndexedAccess 下解构可能为 undefined——insert…returning 空结果属驱动级异常，显式抛出
    if (!c) throw new Error('insert rate_cards returned no row');
    card = c;
    await db
      .insert(rateCardCoefficients)
      .values({ rateCardId: c.id, scope: 'global', coefficient: '1.000' });
    console.log('✓ 创建费率卡「标准」(系数 1.0)');
  }
}

/** 2. 管理员（admins 表，邀请制。测试账号 admin@ai-gateway.local / admin12345） */
async function seedAdmin(db: Db): Promise<void> {
  const adminEmail = 'admin@ai-gateway.local';
  const existingAdmin = await db.query.admins.findFirst({ where: eq(admins.email, adminEmail) });
  if (!existingAdmin) {
    const passwordHash = await hashPassword('admin12345');
    // 动态 RBAC:种子管理员挂 super_admin 角色（roles 由 0082 种子保证存在）
    const [superRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, 'super_admin'));
    if (superRole == null) throw new Error('seed: super_admin role missing (run migrations 0082)');
    await db.insert(admins).values({
      email: adminEmail,
      displayName: 'Dev Admin',
      passwordHash,
      status: ACCOUNT_STATUS.ACTIVE, // v1 字面量 0 → v2 词表（B4/D6 收敛，值不变）
      roleId: superRole.id,
    });
    console.log('✓ 创建管理员 admin@ai-gateway.local (密码 admin12345，仅开发用)');
  }
}

/** 供应商占位价（元/百万 token）——上线前请按实际成本调整 */
interface SeededProvider {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  realModel: string;
  price: { input: string; output: string; cache: string };
}

const PROVIDER_DATA: readonly SeededProvider[] = [
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

/** 按名取或建 provider 行（判存幂等） */
async function ensureProvider(db: Db, p: SeededProvider): Promise<typeof providers.$inferSelect> {
  const existing = await db.query.providers.findFirst({ where: eq(providers.name, p.name) });
  if (existing) return existing;
  const [row] = await db
    .insert(providers)
    .values({ name: p.name, protocol: 'openai-compatible', baseUrl: p.baseUrl })
    .returning();
  if (!row) throw new Error('insert providers returned no row');
  return row;
}

/** 按名取或建 channel 行（上游 Key 经 runtime cipher 加密落库） */
async function ensureChannel(
  db: Db,
  p: SeededProvider,
  creation: { providerId: number; encrypt: (plaintext: string) => string },
): Promise<typeof channels.$inferSelect> {
  const { providerId, encrypt } = creation;
  const existing = await db.query.channels.findFirst({
    where: eq(channels.name, `${p.name}-default`),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(channels)
    .values({
      providerId,
      name: `${p.name}-default`,
      apiKeyEnc: encrypt(p.apiKey ?? ''),
      status: 0, // channels status 0-4 词表未随 db 导出（C3）——保持 v1 字面量
      weight: 1,
      priority: 0,
    })
    .returning();
  if (!row) throw new Error('insert channels returned no row');
  return row;
}

/** 按外部模型名取或建 mapping 行（占位价） */
async function ensureMapping(
  db: Db,
  p: SeededProvider,
): Promise<typeof modelMappings.$inferSelect> {
  const existing = await db.query.modelMappings.findFirst({
    where: eq(modelMappings.externalName, p.model),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(modelMappings)
    .values({
      externalName: p.model,
      realModel: p.realModel,
      status: 0, // 0 上架 / 1 下架（C3 同上）
      inputPrice: p.price.input,
      outputPrice: p.price.output,
      cacheInputPrice: p.price.cache,
    })
    .returning();
  if (!row) throw new Error('insert model_mappings returned no row');
  return row;
}

/** mapping × channel 关联判存补建 */
async function ensureModelChannel(db: Db, mappingId: number, channelId: number): Promise<void> {
  const exists = await db.query.modelChannels.findFirst({
    where: and(eq(modelChannels.mappingId, mappingId), eq(modelChannels.channelId, channelId)),
  });
  if (!exists) {
    await db.insert(modelChannels).values({ mappingId, channelId, weight: 1, priority: 0 });
  }
}

/** 3. 供应商 + 渠道 + 模型映射 + 关联（DeepSeek + MiniMax，按名判存幂等） */
async function seedProviders(db: Db, encrypt: (plaintext: string) => string): Promise<void> {
  for (const p of PROVIDER_DATA) {
    if (!p.apiKey) {
      console.warn(`⚠ ${p.name} API_KEY 未配置，跳过该供应商`);
      continue;
    }
    const provider = await ensureProvider(db, p);
    const channel = await ensureChannel(db, p, { providerId: provider.id, encrypt });
    const mapping = await ensureMapping(db, p);
    await ensureModelChannel(db, mapping.id, channel.id);
    console.log(`✓ ${p.name}: provider + channel + mapping(${p.model})`);
  }
}

async function main() {
  // 池参数由本脚本（装配层）注入：一次性 seed 用最小池 + 短超时快速失败
  const db = createDb({
    url: DATABASE_URL,
    poolMax: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    maxUses: 1_000,
  });
  console.log('→ 连接 DB:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

  await seedRateCard(db);
  await seedAdmin(db);

  // v2 适配：v1 @ai-gateway/core 的 encrypt(key, secret) → runtime cipher（enc:v1，
  // 密钥 SHA-256 派生，与 v1 存量密文同密钥互解、逐字节兼容）
  const cipher = createCipher(ENCRYPTION_KEY);
  await seedProviders(db, cipher.encrypt);

  console.log('\n========================================');
  console.log('  种子数据完成');
  console.log('========================================');
  console.log('下一步: 用户面板自助注册建号,控制台创建 API Key 后即可 curl 网关。');
  console.log('');

  await closeDb(db);
}

main().catch((error) => {
  console.error('✗ 种子失败:', error);
  process.exit(1);
});
