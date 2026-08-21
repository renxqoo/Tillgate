/** 安全专项：守卫先于任何写 / 语义相近输入不顶替 / 幂等键注入形状拒绝 / 深嵌套不爆栈 / 大输入洪水 */
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../fingerprint';
import {
  InvalidInputError,
  InvalidOperationIdError,
  UnknownOperationKindError,
} from '../errors';
import { buildFixture, nextOperationId } from './helpers';

describe('守卫顺序（fail-closed：拒绝路径零副作用）', () => {
  it('白名单外 kind / 非法 operationId → execute 零调用、零落库', async () => {
    const fx = buildFixture();
    await expect(
      fx.ledger.run({
        operationId: nextOperationId(),
        kind: 'admin.backdoor',
        fingerprint: {},
        execute: fx.makeExecute({ ok: true }),
      }),
    ).rejects.toThrow(UnknownOperationKindError);
    await expect(
      fx.ledger.run({
        operationId: "'; drop table ledger_operations;--",
        kind: 'gift.grant',
        fingerprint: {},
        execute: fx.makeExecute({ ok: true }),
      }),
    ).rejects.toThrow(InvalidOperationIdError);
    expect(fx.executions()).toBe(0);
    expect(fx.committed).toHaveLength(0);
  });

  it('指纹输入非法（undefined/NaN/循环）→ 事务外即拒，execute 零调用', async () => {
    const fx = buildFixture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of [undefined, NaN, circular]) {
      await expect(
        fx.ledger.run({
          operationId: nextOperationId(),
          kind: 'gift.grant',
          fingerprint: bad,
          execute: fx.makeExecute({ ok: true }),
        }),
      ).rejects.toThrow(InvalidInputError);
    }
    expect(fx.executions()).toBe(0);
  });
});

describe('语义相近输入不得顶替重放（指纹的教学契约）', () => {
  it('字符串金额 "1.00" vs "1.0"、userId 7 vs "7"——指纹互异，重放被冲突拦下', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    await fx.ledger.run({
      operationId,
      kind: 'payment.credit',
      fingerprint: { userId: 7, amount: '1.00' },
      execute: fx.makeExecute({ balanceAfter: '1.00' }),
    });
    const driftAmount = await fx.ledger
      .run({
        operationId,
        kind: 'payment.credit',
        fingerprint: { userId: 7, amount: '1.0' },
        execute: fx.makeExecute({ wrong: true }),
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as Error,
      );
    expect(driftAmount.name).toBe('OperationConflictError');
    const driftUser = await fx.ledger
      .run({
        operationId,
        kind: 'payment.credit',
        fingerprint: { userId: '7', amount: '1.00' },
        execute: fx.makeExecute({ wrong: true }),
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as Error,
      );
    expect(driftUser.name).toBe('OperationConflictError');
    expect(fx.executions()).toBe(1);
  });
});

describe('洪水与深构造输入', () => {
  it('万层嵌套指纹输入不爆栈（深度上限拒绝）', () => {
    let deep: unknown = { v: 1 };
    for (let i = 0; i < 10_000; i += 1) deep = { n: deep };
    expect(() => canonicalJson(deep)).toThrow(InvalidInputError);
  });

  it('大字符串指纹输入超 1MB 拒绝；回执超 16KB 拒绝且回滚', async () => {
    const fx = buildFixture();
    await expect(
      fx.ledger.run({
        operationId: nextOperationId(),
        kind: 'gift.grant',
        fingerprint: { blob: 'x'.repeat(1_100_000) },
        execute: fx.makeExecute({ ok: true }),
      }),
    ).rejects.toThrow(InvalidInputError);
    const opId = nextOperationId();
    await expect(
      fx.ledger.run({
        operationId: opId,
        kind: 'gift.grant',
        fingerprint: { small: true },
        execute: fx.makeExecute({ blob: 'y'.repeat(20_000) }),
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(await fx.ledger.operation({ operationId: opId })).toBeNull();
  });

  it('操作档案 append-only：回放与冲突都不改写存档（重放回执恒等于首档）', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const input = {
      operationId,
      kind: 'order.place',
      fingerprint: { orderId: 'stable-1' },
      execute: fx.makeExecute({ stable: true }),
    };
    const first = await fx.ledger.run(input);
    for (let i = 0; i < 3; i += 1) {
      const replay = await fx.ledger.run(input);
      expect(replay.receipt).toEqual(first.receipt);
    }
    const view = await fx.ledger.operation({ operationId });
    expect(view!.receipt).toEqual({ stable: true });
    expect(view!.createdAt).toBe(first.createdAt);
  });
});
