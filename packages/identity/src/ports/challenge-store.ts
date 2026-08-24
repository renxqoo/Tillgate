/**
 * 统一挑战持久化 port。时间单源 = DB clock_timestamp()(冷却判定与 retryAfterMs
 * 同钟,B14);验码是单条 CAS UPDATE(计错 + 命中即消费,无读改写竞态)。
 * 实现见 adapters/postgres/challenges.ts。
 */
import type { DbLike } from '@tillgate/db';
import type { NormalizedIdentifier } from '../domain/identifier.js';

export interface StoredChallengeTarget {
  readonly identifier: NormalizedIdentifier | null;
  readonly userId: number | null;
}

export type BeginChallengeOutcome =
  | { readonly status: 'inserted'; readonly expiresAt: string }
  | { readonly status: 'cooldown'; readonly retryAfterMs: number };

export interface VerifyChallengeOutcome {
  readonly status: 'consumed';
  readonly target: StoredChallengeTarget;
  readonly payload: Record<string, unknown> | null;
}
export type VerifyChallengeResult =
  | VerifyChallengeOutcome
  | { readonly status: 'wrong_code'; readonly remainingAttempts: number }
  | { readonly status: 'invalid' };

export interface ChallengeStore {
  /**
   * 发码原子决策:活挑战未冷却 → cooldown(retryAfterMs 按 DB 钟计算);已冷却 →
   * 作废旧挑战(替换语义,让出部分唯一索引)→ INSERT。契约:调用方持
   * `identity.challenge:{kind}:{target}` advisoryLock(runTx 临界区内);
   * 锁内清位仍撞唯一的理论窗口按冷却拒绝。
   */
  beginChallenge(
    db: DbLike,
    input: {
      challengeId: string;
      kind: string;
      identifier: NormalizedIdentifier | null;
      userId: number | null;
      codeHash: string;
      payload: Record<string, unknown> | null;
      ttlMs: number;
      cooldownMs: number;
      maxAttempts: number;
    },
  ): Promise<BeginChallengeOutcome>;

  /** 验码 CAS:命中即消费;错码计次(remaining>0);不存在/终态/过期/耗尽 = invalid(不细分) */
  verifyChallenge(
    db: DbLike,
    input: { challengeId: string; codeHash: string },
  ): Promise<VerifyChallengeResult>;

  /** 幂等作废(已消费/已作废/不存在 → false) */
  abortChallenge(db: DbLike, input: { challengeId: string }): Promise<{ aborted: boolean }>;
}
