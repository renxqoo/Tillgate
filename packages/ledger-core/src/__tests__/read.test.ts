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
    const fx = buildFixture();
    const stamp = Date.now().toString(36);
    // 25 条 gift.grant + 5 条 payment.credit 交错插入（operationId 保序可断言）
    for (let i = 0; i < 25; i += 1) {
      await fx.ledger.run({
        operationId: `test.page:${stamp}.g${String(i).padStart(2, '0')}`,
        kind: 'gift.grant',
        fingerprint: { i },
        execute: fx.makeExecute({ i }),
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await fx.ledger.run({
        operationId: `test.page:${stamp}.p${String(i).padStart(2, '0')}`,
        kind: 'payment.credit',
        fingerprint: { i },
        execute: fx.makeExecute({ i }),
      });
    }

    // kind 过滤 + 分页：每页 10，翻页收齐本测试插入的全部 25 条 gift（跨文件共享表，按 stamp 圈定）
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await fx.ledger.operations({ kind: 'gift.grant', limit: 10, cursor: cursor ?? undefined });
      seen.push(...result.items.map((item) => item.operationId));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    const mine = seen.filter((id) => id.startsWith(`test.page:${stamp}`));
    expect(mine).toHaveLength(25);
    expect(new Set(mine).size).toBe(25); // 无重叠
    const expected = Array.from({ length: 25 }, (_, i) => `test.page:${stamp}.g${String(24 - i).padStart(2, '0')}`);
    expect(mine).toEqual(expected); // id 倒序（后插在前）

    // 不带 kind：默认 limit 50 一页收齐全部测试新插入行
    const all = await fx.ledger.operations({ limit: 200 });
    expect(all.items.filter((i) => i.operationId.includes(stamp)).length).toBe(30);
    expect(all.nextCursor).toBeNull();

    // 恰好满页 → nextCursor 非 null，下一页为空
    const exact = await fx.ledger.operations({ kind: 'gift.grant', limit: 25 });
    expect(exact.items).toHaveLength(25);
    expect(exact.nextCursor).not.toBeNull();
    const next = await fx.ledger.operations({ kind: 'gift.grant', limit: 25, cursor: exact.nextCursor! });
    expect(next.items.filter((i) => i.operationId.includes(stamp))).toHaveLength(0);
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
