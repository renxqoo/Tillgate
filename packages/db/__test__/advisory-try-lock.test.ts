/**
 * 会话级 advisory try-lock 闭箱规格（真 PG 语义在 pg.real 门）：
 * 获锁/未获锁、fn 异常透传、解锁失败 → 销毁连接不归还 + onDefect 上报。
 * 假 $client.reserve() 注入——db 包默认门禁无 PG 依赖。
 */
import { describe, expect, it, vi } from 'vitest';
import { withSessionTryLock } from '../src/advisory-try-lock.js';
import type { Db } from '../src/client.js';

interface FakeClient {
  unsafe: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeDb(client: FakeClient): Db {
  return { $client: { reserve: vi.fn(async () => client) } as never } as unknown as Db;
}

/** lock 查询回 [{locked}],unlock 语句按 unlockThrows 决定成败 */
function makeClient(locked: boolean, unlockThrows = false): FakeClient {
  const client: FakeClient = {
    unsafe: vi.fn(),
    release: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  client.unsafe.mockResolvedValueOnce([{ locked }]);
  if (unlockThrows) client.unsafe.mockRejectedValueOnce(new Error('connection reset'));
  else client.unsafe.mockResolvedValueOnce([{ unlock: true }]);
  return client;
}

describe('withSessionTryLock（闭箱：假 reserve 客户端）', () => {
  it('获锁成功 → fn 结果透传,unlock 后归还连接', async () => {
    const client = makeClient(true);
    const result = await withSessionTryLock(fakeDb(client), { key: 'k1' }, async () => 'ran');
    expect(result).toBe('ran');
    expect(client.unsafe).toHaveBeenCalledTimes(2); // try-lock + unlock
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('未获锁 → null,fn 不执行,连接仍归还', async () => {
    const client = makeClient(false);
    const ran = vi.fn();
    const result = await withSessionTryLock(fakeDb(client), { key: 'k1' }, ran);
    expect(result).toBeNull();
    expect(ran).not.toHaveBeenCalled();
    expect(client.unsafe).toHaveBeenCalledTimes(1); // 只有一次 try-lock 查询
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('fn 抛错 → 异常透传,unlock 仍执行(内层 finally),连接归还', async () => {
    const client = makeClient(true);
    await expect(
      withSessionTryLock(fakeDb(client), { key: 'k1' }, async () => {
        throw new Error('fn boom');
      }),
    ).rejects.toThrow('fn boom');
    expect(client.unsafe).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('解锁失败(R-5) → 销毁连接不归还,onDefect 恰一次,fn 结果不丢', async () => {
    const client = makeClient(true, true);
    const defects: Array<{ key: string }> = [];
    const result = await withSessionTryLock(
      fakeDb(client),
      {
        key: 'k-unlock-fail',
        onDefect: (error, key) => {
          void error;
          defects.push({ key });
        },
      },
      async () => 'ran',
    );
    expect(result).toBe('ran');
    expect(defects).toEqual([{ key: 'k-unlock-fail' }]);
    expect(client.close).toHaveBeenCalledTimes(1); // 持锁连接销毁(锁随连接释放)
    expect(client.release).not.toHaveBeenCalled(); // 不得把持锁连接归还池
  });

  it('解锁失败且未注入 onDefect → 仍销毁不归还(缺省钩子安全)', async () => {
    const client = makeClient(true, true);
    const result = await withSessionTryLock(fakeDb(client), { key: 'k' }, async () => 'ran');
    expect(result).toBe('ran');
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.release).not.toHaveBeenCalled();
  });
});
