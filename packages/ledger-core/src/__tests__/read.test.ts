/** 读侧：单条查询 / kind 过滤 / 游标分页（无重叠不遗漏）/ limit 与 cursor 校验 */
import { describe, expect, it } from 'vitest';
import { InvalidInputError, InvalidOperationIdError } from '../errors';
import { buildFixture, nextOperationId } from './helpers';

describe('operation（单条）', () => {
  it('存在返回全字段视图；不存在返回 null；operationId 非法形状拒绝', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    await fx.ledger.run({
      operationId,
      kind: 'payment.credit',
      fingerprint: { userId: 3 },
      execute: fx.makeExecute({ transactionId: 1 }),
    });
    const view = await fx.ledger.operation({ operationId });
    expect(view).toMatchObject({
      operationId,
      kind: 'payment.credit',
      receipt: { transactionId: 1 },
    });
    expect(view!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof view!.createdAt).toBe('string');
    expect(await fx.ledger.operation({ operationId: `nope-${Date.now()}` })).toBeNull();
    await expect(fx.ledger.operation({ operationId: 'bad id!' })).rejects.toThrow(InvalidOperationIdError);
  });
});

describe('operations（分页）', () => {
  it('id 倒序分页：跨页无重叠不遗漏；kind 过滤；nextCursor 语义', async () => {
    const stamp = Date.now().toString(36);
    // 本用例专属 kind（跨文件共享表——固定 kind 会被他文件的行污染，断言不稳定）
    const giftKind = `gift.r${stamp}`;
    const payKind = `pay.r${stamp}`;
    const fx = buildFixture({ kinds: [giftKind, payKind] });
    // 25 条 gift + 5 条 payment 交错插入（operationId 保序可断言）
    for (let i = 0; i < 25; i += 1) {
      await fx.ledger.run({
        operationId: `test.page:${stamp}.g${String(i).padStart(2, '0')}`,
        kind: giftKind,
        fingerprint: { i },
        execute: fx.makeExecute({ i }),
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await fx.ledger.run({
        operationId: `test.page:${stamp}.p${String(i).padStart(2, '0')}`,
        kind: payKind,
        fingerprint: { i },
        execute: fx.makeExecute({ i }),
      });
    }

    // kind 过滤 + 分页：每页 10，翻页收齐全部 25 条 gift
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await fx.ledger.operations({ kind: giftKind, limit: 10, cursor: cursor ?? undefined });
      seen.push(...result.items.map((item) => item.operationId));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // 无重叠
    const expected = Array.from({ length: 25 }, (_, i) => `test.page:${stamp}.g${String(24 - i).padStart(2, '0')}`);
    expect(seen).toEqual(expected); // id 倒序（后插在前）

    // 另一 kind 互不串：payment 域恰好 5 条，一页收齐且无游标
    const pays = await fx.ledger.operations({ kind: payKind, limit: 10 });
    expect(pays.items).toHaveLength(5);
    expect(pays.nextCursor).toBeNull();

    // 恰好满页且无更多行 → nextCursor null（fetch limit+1 语义：无溢出即无游标）；
    // 满页前（limit 20 < 25）→ 游标非空
    const partial = await fx.ledger.operations({ kind: giftKind, limit: 20 });
    expect(partial.nextCursor).not.toBeNull();
    const exact = await fx.ledger.operations({ kind: giftKind, limit: 25 });
    expect(exact.items).toHaveLength(25);
    expect(exact.nextCursor).toBeNull();
  });

  it('limit 与 cursor 校验：越界/非数字/伪造负值拒绝', async () => {
    const fx = buildFixture();
    await expect(fx.ledger.operations({ limit: 0 })).rejects.toThrow(InvalidInputError);
    await expect(fx.ledger.operations({ limit: 201 })).rejects.toThrow(InvalidInputError);
    await expect(fx.ledger.operations({ limit: 1.5 })).rejects.toThrow(InvalidInputError);
    await expect(fx.ledger.operations({ cursor: 'abc' })).rejects.toThrow(InvalidInputError);
    await expect(fx.ledger.operations({ cursor: '-5' })).rejects.toThrow(InvalidInputError);
    await expect(fx.ledger.operations({ cursor: '0' })).rejects.toThrow(InvalidInputError);
    await expect(fx.ledger.operations({ limit: 1 })).resolves.toBeTruthy();
  });
});
