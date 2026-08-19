/** 测试共享件：每文件一个池（max 3）+ 宽 kinds 白名单实例 + 执行计数探针。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createLedger } from '../ledger';
import type { Tx } from '../internal';
import type { CreateLedgerOptions, Ledger, OperationReceipt } from '../types';

export const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';

const schema = process.env.LEDGER_TEST_SCHEMA;
if (!schema) throw new Error('LEDGER_TEST_SCHEMA missing — vitest globalSetup 未执行?');

export const pool = new Pool({ connectionString, max: 3, options: `-c search_path=${schema}` });
export const db = drizzle(pool);

export interface CommittedEvent {
  operationId: string;
  kind: string;
  replayed: boolean;
  receipt: OperationReceipt | null;
}

export interface TestFixture {
  ledger: Ledger;
  committed: CommittedEvent[];
  audits: { action: string }[];
  /** execute 工厂：返回固定回执并计数（并发「至多一次」断言的核心探针） */
  makeExecute<T extends OperationReceipt | null>(receipt: T): (tx: Tx) => Promise<T>;
  /** makeExecute 创建的 execute 被真正调用的次数 */
  executions: () => number;
}

/** 宽 kinds 实例 + 计数探针；options.effects 传入时先收集再转调 */
export function buildFixture(options?: Partial<CreateLedgerOptions>): TestFixture {
  const committed: CommittedEvent[] = [];
  const audits: { action: string }[] = [];
  let executions = 0;
  const outerEffects = options?.effects;
  const ledger = createLedger(db, {
    kinds: [
      'payment.credit',
      'payment.refund',
      'order.place',
      'order.cancel',
      'order.settle',
      'subscription.purchase',
      'subscription.cancel',
      'gift.grant',
    ],
    ...options,
    effects: {
      committed: async (event) => {
        committed.push(event);
        await outerEffects?.committed?.(event);
      },
      audit: async (event) => {
        audits.push({ action: event.action });
        await outerEffects?.audit?.(event);
      },
    },
  });
  return {
    ledger,
    committed,
    audits,
    makeExecute:
      <T extends OperationReceipt | null>(receipt: T) =>
      async (_tx: Tx) => {
        executions += 1;
        return receipt;
      },
    executions: () => executions,
  };
}

/** 每测试唯一幂等键 */
let opSeq = 0;
export const nextOperationId = (): string => `test.op:${Date.now().toString(36)}.${opSeq++}`;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
