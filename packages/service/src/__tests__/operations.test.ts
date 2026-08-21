/**
 * 幂等操作用例（真实 PG）：占位 → 执行 → 回执存档 / 重放 / 冲突 / 并发。
 * 覆盖单线程语义、并发竞态与操作契约三面。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import { ledgerOperations, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { OperationConflictError } from '@ai-gateway/domain';
import { systemContext, type RunContext } from '../context.js';
import { createOperationsUseCase } from '../shared/operations.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 8 },
);
const ctx: RunContext = systemContext('v2op-suite');
const operations = createOperationsUseCase({ db });
const createdUsers: number[] = [];
const createdOperationIds: string[] = [];

const opId = (tag: string): string => `v2op:${tag}:${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  if (createdOperationIds.length) {
    await db.delete(ledgerOperations).where(inArray(ledgerOperations.operationId, createdOperationIds));
  }
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('run：占位 → 执行 → 回执存档', () => {
  it('首次执行 receipt 落档；replayed:false', async () => {
    const operationId = opId('first');
    createdOperationIds.push(operationId);
    const result = await operations.run(ctx, {
      operationId,
      kind: 'test.echo',
      payload: { n: 1 },
      execute: async () => ({ n: 1 } as Record<string, unknown>),
    });
    expect(result.replayed).toBe(false);
    expect(result.receipt).toEqual({ n: 1 });
  });

  it('同 operationId 同命令 → 重放首次回执（execute 不再执行）', async () => {
    const operationId = opId('replay');
    createdOperationIds.push(operationId);
    let executions = 0;
    const input = {
      operationId,
      kind: 'test.counter',
      payload: { tag: 'x' },
      execute: async () => {
        executions += 1;
        return { ok: true } as Record<string, unknown>;
      },
    };
    await operations.run(ctx, input);
    const replay = await operations.run(ctx, input);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual({ ok: true });
    expect(executions).toBe(1);
  });

  it('同 operationId 异命令 → OperationConflictError（409）', async () => {
    const operationId = opId('conflict');
    createdOperationIds.push(operationId);
    await operations.run(ctx, {
      operationId, kind: 'test.a', payload: { v: 1 },
      execute: async () => ({ v: 1 } as Record<string, unknown>),
    });
    await expect(
      operations.run(ctx, {
        operationId, kind: 'test.a', payload: { v: 2 },
        execute: async () => ({ v: 2 } as Record<string, unknown>),
      }),
    ).rejects.toThrow(OperationConflictError);
  });

  it('execute 抛错 → 占位随事务回滚（下次可重试）', async () => {
    const operationId = opId('rollback');
    createdOperationIds.push(operationId);
    await expect(
      operations.run(ctx, {
        operationId, kind: 'test.boom', payload: { v: 1 },
        execute: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const retry = await operations.run(ctx, {
      operationId, kind: 'test.boom', payload: { v: 1 },
      execute: async () => ({ recovered: true } as Record<string, unknown>),
    });
    expect(retry.replayed).toBe(false);
  });
});

describe('并发与共享事务', () => {
  it('双发同 operationId：恰一次执行，输家重放回执', async () => {
    const operationId = opId('race');
    createdOperationIds.push(operationId);
    let executions = 0;
    const run = () =>
      operations.run(ctx, {
        operationId, kind: 'test.race', payload: { v: 1 },
        execute: async () => {
          executions += 1;
          return { n: executions } as Record<string, unknown>;
        },
      });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const receipts = results.map(
      (r) => (r as PromiseFulfilledResult<{ receipt: Record<string, unknown> }>).value.receipt,
    );
    expect(receipts[0]).toEqual(receipts[1]); // 同一首答
    expect(executions).toBe(1);
  });

  it('operationId 形状契约：非法字符拒绝（调用方设计责任）', async () => {
    await expect(
      operations.run(ctx, {
        operationId: 'bad id with spaces!', kind: 'test.x', payload: {},
        execute: async () => ({}) as Record<string, unknown>,
      }),
    ).rejects.toThrow();
  });

  it('加入调用方事务：tx 注入时与外层同生共死', async () => {
    const operationId = opId('tx');
    createdOperationIds.push(operationId);
    await db.transaction(async (tx) => {
      await operations.run(ctx, {
        operationId, kind: 'test.tx', payload: { v: 1 },
        execute: async () => ({ inTx: true } as Record<string, unknown>),
        tx,
      });
      throw new Error('outer rollback');
    }).catch(() => undefined);
    const [row] = await db
      .select({ id: ledgerOperations.operationId })
      .from(ledgerOperations)
      .where(eq(ledgerOperations.operationId, operationId));
    expect(row).toBeUndefined(); // 占位随外层回滚
  });
});
