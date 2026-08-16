import { describe, expect, it } from 'vitest';
import { createTpmReservation } from '../types.js';
import type { RateLimiter } from '../../billing/rate-limit-service.js';

/**
 * TpmReservation 句柄所有权单测（2026-08 结构化所有权）：
 * 释放/移交两态互斥，release 幂等只执行一次（retained 随 2026-08-17 政策删除）。
 * 端到端语义由 tpm-reservation.characterization.test.ts 护栏验证。
 */
function makeLimiter() {
  const released: string[] = [];
  const rateLimiter = {
    releaseTpm: async (id: string) => {
      released.push(id);
    },
  } as unknown as RateLimiter;
  return { released, rateLimiter };
}

describe('TpmReservation 句柄', () => {
  it('held 状态 release() 执行释放', async () => {
    const { released, rateLimiter } = makeLimiter();
    const tpm = createTpmReservation(rateLimiter, 'req-1');
    await tpm.release();
    expect(released).toEqual(['req-1']);
  });

  it('handedOff 后 release() 为 no-op（移交结算回填）', async () => {
    const { released, rateLimiter } = makeLimiter();
    const tpm = createTpmReservation(rateLimiter, 'req-2');
    tpm.handedOff();
    await tpm.release();
    expect(released).toEqual([]);
  });

  it('release 幂等：重复调用只释放一次', async () => {
    const { released, rateLimiter } = makeLimiter();
    const tpm = createTpmReservation(rateLimiter, 'req-4');
    await tpm.release();
    await tpm.release();
    expect(released).toEqual(['req-4']);
  });

  it('存储故障被吞（best-effort，不阻塞主路径）', async () => {
    const rateLimiter = {
      releaseTpm: async () => {
        throw new Error('redis down');
      },
    } as unknown as RateLimiter;
    const tpm = createTpmReservation(rateLimiter, 'req-5');
    await expect(tpm.release()).resolves.toBeUndefined();
  });
});
