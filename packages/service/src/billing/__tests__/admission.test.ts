/** 积压准入（stub 仓储，零 DB）：阈值判定与零堆积放行。 */
import { describe, expect, it } from 'vitest';
import { BillingBacklogError } from '@ai-gateway/domain';
import type { Db, Repositories } from '@ai-gateway/repository';
import { createBacklogAdmission } from '../admission.js';

const stubRepos = (inv: { pending?: number; retrying?: number; oldestPendingMs?: number }): Repositories =>
  ({
    billingRequest: {
      inventory: async () => ({
        pending: inv.pending ?? 0,
        processing: 0,
        retrying: inv.retrying ?? 0,
        dead: 0,
        oldestPendingMs: inv.oldestPendingMs ?? 0,
      }),
    },
  }) as unknown as Repositories;

const config = { db: {} as Db, maxPending: 100, maxOldestPendingMs: 60_000 };

describe('createBacklogAdmission', () => {
  it('零堆积零开销放行', async () => {
    const assertCapacity = createBacklogAdmission({ ...config, repos: stubRepos({}) });
    await expect(assertCapacity()).resolves.toBeUndefined();
  });

  it('阈值内放行（张数与账龄都不越线）', async () => {
    const assertCapacity = createBacklogAdmission({
      ...config,
      repos: stubRepos({ pending: 60, retrying: 30, oldestPendingMs: 59_000 }),
    });
    await expect(assertCapacity()).resolves.toBeUndefined();
  });

  it('超张数 / 超账龄 → BillingBacklogError', async () => {
    const overCount = createBacklogAdmission({ ...config, repos: stubRepos({ pending: 101 }) });
    await expect(overCount()).rejects.toThrow(BillingBacklogError);
    const overAge = createBacklogAdmission({
      ...config,
      repos: stubRepos({ pending: 1, oldestPendingMs: 61_000 }),
    });
    await expect(overAge()).rejects.toThrow(BillingBacklogError);
  });

  it('retry_wait 计入待结算口径', async () => {
    const assertCapacity = createBacklogAdmission({ ...config, repos: stubRepos({ retrying: 101 }) });
    await expect(assertCapacity()).rejects.toThrow(BillingBacklogError);
  });
});
