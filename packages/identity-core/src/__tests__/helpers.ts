/** 测试共享件：每文件一个池（max 3）+ 宽白名单 identity 实例 + 可控时钟。
 *  fileParallelism: false 保证同一时刻只有一个文件的池在跑。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createIdentity } from '../identity';
import type { CreateIdentityOptions, Identity } from '../types';

export const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';

const schema = process.env.IDENTITY_TEST_SCHEMA;
if (!schema) throw new Error('IDENTITY_TEST_SCHEMA missing — vitest globalSetup 未执行?');

export const pool = new Pool({ connectionString, max: 3, options: `-c search_path=${schema}` });
export const db = drizzle(pool);

export interface Delivered {
  channel: 'email' | 'sms';
  to: string;
  kind: string;
  code: string;
  challengeId: string;
}

export interface TestFixture {
  identity: Identity;
  delivered: Delivered[];
  audits: { action: string }[];
  /** 当前可控时钟值（ms）——TOTP 步进测试取码/推进用 */
  clockMs(): number;
  /** 推进可控时钟（未显式传 clock 的实例生效） */
  advanceTo(date: Date): void;
}

/**
 * 宽白名单实例（测试全词表开放）+ 投递/审计收集器。
 * 默认时钟=真实当下（吊销线/会话断言用真实时间轴）；TOTP 测试按 clockMs() 取码。
 * options.effects 传入时：先收集再转调（保收集器语义不被覆盖）。
 */
export function buildFixture(options?: Partial<CreateIdentityOptions>): TestFixture {
  const delivered: Delivered[] = [];
  const audits: { action: string }[] = [];
  /** null = 活时钟（默认）；advanceTo 后冻结——TOTP 步进/吊销时刻测试用 */
  let frozen: Date | null = null;
  const clock = options?.clock ?? (() => frozen ?? new Date());
  const outerEffects = options?.effects;
  const identity = createIdentity(db, {
    identifiers: ['email', 'phone', 'username'],
    providers: ['github', 'google', 'wechat'],
    challenges: ['email_code', 'email_verification', 'password_reset', 'sms_code'],
    ...options,
    clock,
    effects: {
      deliver: async (event) => {
        delivered.push(event);
        await outerEffects?.deliver?.(event);
      },
      audit: async (event) => {
        audits.push({ action: event.action });
        await outerEffects?.audit?.(event);
      },
    },
  });
  return {
    identity,
    delivered,
    audits,
    clockMs: () => (frozen ?? new Date()).getTime(),
    advanceTo: (date: Date) => {
      frozen = date;
    },
  };
}

/** 每测试独立的消费方 userId（消费方自建 users 行的模拟——本包不建用户行） */
let userSeq = 0;
export const nextUserId = (): number =>
  700_000_000 + (Date.now() % 1_000_000) * 10 + (userSeq++ % 10);

/** 每测试唯一邮箱（跨文件/跨运行唯一，防并发顶撞） */
let emailSeq = 0;
export const nextEmail = (): string =>
  `it${Date.now().toString(36)}.${emailSeq++}@identity-test.local`;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
