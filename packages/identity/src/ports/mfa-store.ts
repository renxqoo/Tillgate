/**
 * MFA 持久化 port(TOTP 注册/步进单调 CAS + 恢复码单次消费)。
 * 实现见 adapters/postgres/mfa.ts。secret 列可为 SecretCipher 密文(加密在用例层)。
 */
import type { DbLike } from '@tillgate/db';

export interface TotpRow {
  readonly secret: string;
  readonly confirmedAt: string | null;
  readonly lastUsedStep: number;
}

export type UpsertEnrollmentOutcome =
  | { readonly status: 'pending_created' }
  | { readonly status: 'pending_replaced' }
  | { readonly status: 'already_confirmed' };

export type ConfirmEnrollmentOutcome =
  | { readonly status: 'confirmed' }
  | { readonly status: 'already_confirmed' }
  | { readonly status: 'not_enrolled' };

export interface MfaStore {
  loadTotp(db: DbLike, userId: number): Promise<TotpRow | null>;

  /**
   * 挂起注册:无行 → 建挂起;挂起重挂 → 换钥重置 lastUsedStep=-1;已确认 →
   * already_confirmed。契约:调用方持 `identity.user:{userId}` advisoryLock。
   */
  upsertEnrollment(
    db: DbLike,
    input: { userId: number; storedSecret: string },
  ): Promise<UpsertEnrollmentOutcome>;

  /**
   * 确认注册(CAS 仅挂起可置 confirmed + lastUsedStep=step)+ 恢复码整组重签
   * (旧组全作废;onConflictDoNothing 阻断同批哈希碰撞,B19)。契约:调用方持锁。
   */
  confirmEnrollment(
    db: DbLike,
    input: { userId: number; step: number; recoveryCodeHashes: readonly string[] },
  ): Promise<ConfirmEnrollmentOutcome>;

  /** TOTP 步进单调 CAS(last_used_step < step 且已确认才放行;防同码/旧码重放) */
  advanceTotpStep(db: DbLike, input: { userId: number; step: number }): Promise<boolean>;

  /** 恢复码单次消费(used_at CAS) */
  consumeRecoveryCode(db: DbLike, input: { userId: number; codeHash: string }): Promise<boolean>;

  /** 删除 TOTP 注册与全部恢复码(disable 用例;调用方持锁) */
  deleteTotpAndRecoveryCodes(db: DbLike, userId: number): Promise<void>;
}
