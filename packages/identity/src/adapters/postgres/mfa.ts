/**
 * MFA store postgres 实现:TOTP 挂起/确认(锁内 CAS)+ 步进单调 CAS + 恢复码
 * 单次消费/整组重签(onConflictDoNothing 防同批碰撞,B19)。SQL 与 v1 mfa.ts 对齐。
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { identityRecoveryCodes, identityTotp } from '@tillgate/db';
import type {
  ConfirmEnrollmentOutcome,
  MfaStore,
  TotpRow,
  UpsertEnrollmentOutcome,
} from '../../ports/mfa-store.js';

export const mfaQueries: MfaStore = {
  async loadTotp(db: DbLike, userId: number): Promise<TotpRow | null> {
    const rows = await db
      .select({
        secret: identityTotp.secret,
        confirmedAt: identityTotp.confirmedAt,
        lastUsedStep: identityTotp.lastUsedStep,
      })
      .from(identityTotp)
      .where(eq(identityTotp.userId, userId))
      .limit(1);
    const row = rows[0];
    return row ? { ...row, confirmedAt: row.confirmedAt?.toISOString() ?? null } : null;
  },

  async upsertEnrollment(
    db: DbLike,
    input: { userId: number; storedSecret: string },
  ): Promise<UpsertEnrollmentOutcome> {
    const rows = await db
      .select({ confirmedAt: identityTotp.confirmedAt })
      .from(identityTotp)
      .where(eq(identityTotp.userId, input.userId))
      .for('update')
      .limit(1);
    if (rows[0]?.confirmedAt != null) {
      return { status: 'already_confirmed' };
    }
    if (rows[0] != null) {
      // 挂起态重挂:换新密钥(旧密钥作废,扫描了旧二维码的用户必须重新扫)
      await db
        .update(identityTotp)
        .set({
          secret: input.storedSecret,
          confirmedAt: null,
          lastUsedStep: -1,
          updatedAt: sql`now()`,
        })
        .where(eq(identityTotp.userId, input.userId));
      return { status: 'pending_replaced' };
    }
    await db.insert(identityTotp).values({ userId: input.userId, secret: input.storedSecret });
    return { status: 'pending_created' };
  },

  async confirmEnrollment(
    db: DbLike,
    input: { userId: number; step: number; recoveryCodeHashes: readonly string[] },
  ): Promise<ConfirmEnrollmentOutcome> {
    // CAS:仅挂起态可置 confirmed——并发 confirm/disable 在此互斥
    const confirmed = await db
      .update(identityTotp)
      .set({ confirmedAt: sql`now()`, lastUsedStep: input.step, updatedAt: sql`now()` })
      .where(and(eq(identityTotp.userId, input.userId), isNull(identityTotp.confirmedAt)))
      .returning({ userId: identityTotp.userId });
    if (confirmed.length === 0) {
      const reread = await db
        .select({ confirmedAt: identityTotp.confirmedAt })
        .from(identityTotp)
        .where(eq(identityTotp.userId, input.userId))
        .limit(1);
      if (reread[0]?.confirmedAt != null) {
        return { status: 'already_confirmed' };
      }
      return { status: 'not_enrolled' };
    }
    // 恢复码整组重签(旧组全作废——重新注册场景不残留旧码);同批哈希碰撞静默去重(B19)
    await db.delete(identityRecoveryCodes).where(eq(identityRecoveryCodes.userId, input.userId));
    if (input.recoveryCodeHashes.length > 0) {
      await db
        .insert(identityRecoveryCodes)
        .values(input.recoveryCodeHashes.map((codeHash) => ({ userId: input.userId, codeHash })))
        .onConflictDoNothing();
    }
    return { status: 'confirmed' };
  },

  async advanceTotpStep(db: DbLike, input: { userId: number; step: number }): Promise<boolean> {
    const rows = await db
      .update(identityTotp)
      .set({ lastUsedStep: input.step, updatedAt: sql`now()` })
      .where(
        and(
          eq(identityTotp.userId, input.userId),
          isNotNull(identityTotp.confirmedAt),
          sql`${identityTotp.lastUsedStep} < ${input.step}`,
        ),
      )
      .returning({ userId: identityTotp.userId });
    return rows.length > 0;
  },

  async consumeRecoveryCode(
    db: DbLike,
    input: { userId: number; codeHash: string },
  ): Promise<boolean> {
    const rows = await db
      .update(identityRecoveryCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(identityRecoveryCodes.userId, input.userId),
          eq(identityRecoveryCodes.codeHash, input.codeHash),
          isNull(identityRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: identityRecoveryCodes.id });
    return rows.length > 0;
  },

  async deleteTotpAndRecoveryCodes(db: DbLike, userId: number): Promise<void> {
    await db.delete(identityTotp).where(eq(identityTotp.userId, userId));
    await db.delete(identityRecoveryCodes).where(eq(identityRecoveryCodes.userId, userId));
  },
};
