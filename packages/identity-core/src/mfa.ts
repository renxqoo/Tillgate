/**
 * MFA 动词（TOTP RFC 6238 + 恢复码）：
 *
 *   enrollTotp   挂起注册（重复挂起=换新密钥）；已确认者拒绝
 *   confirmTotp  首码校验 → CAS 置 confirmed（步号一并落防重放）→ 重签恢复码（只存哈希）
 *   verifyMfa    TOTP 步进单调 CAS（同码/旧码重放被拒）；恢复码哈希单次消费
 *   disableTotp  已确认必须携有效码；挂起态免码直删；恢复码连带清除
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  InvalidTotpCodeError,
  TotpAlreadyEnrolledError,
  TotpNotEnrolledError,
} from './errors.js';
import { advisoryLock, credentialSetLockKey, runEffect, runTx } from './internal.js';
import { identityRecoveryCodes, identityTotp } from './schema.js';
import { base32Decode, base32Encode, generateRecoveryCode, matchingTotpStep } from './totp.js';
import { assertUserId } from './validation.js';
import type { IdentityContext } from './context.js';
import type {
  ConfirmTotpInput,
  ConfirmTotpResult,
  DisableTotpInput,
  EnrollTotpInput,
  EnrollTotpResult,
  VerifyMfaInput,
  VerifyMfaResult,
} from './types.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface TotpRow {
  secret: string;
  confirmedAt: Date | null;
  lastUsedStep: number;
}

async function loadTotp(db: NodePgDatabase, userId: number): Promise<TotpRow | null> {
  const rows = await db
    .select({
      secret: identityTotp.secret,
      confirmedAt: identityTotp.confirmedAt,
      lastUsedStep: identityTotp.lastUsedStep,
    })
    .from(identityTotp)
    .where(eq(identityTotp.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

function storedSecret(ctx: IdentityContext, plain: string): string {
  return ctx.config.totp.secretCipher ? ctx.config.totp.secretCipher.encrypt(plain) : plain;
}

function loadedSecret(ctx: IdentityContext, stored: string): string {
  return ctx.config.totp.secretCipher ? ctx.config.totp.secretCipher.decrypt(stored) : stored;
}

/** 解出二进制密钥（cipher 在外层已解） */
function totpSecretKey(ctx: IdentityContext, row: TotpRow): Buffer {
  return base32Decode(loadedSecret(ctx, row.secret));
}

function matchTotp(ctx: IdentityContext, row: TotpRow, code: string): number | null {
  return matchingTotpStep(
    totpSecretKey(ctx, row),
    code,
    ctx.clock().getTime(),
    ctx.config.totp.stepSec,
    ctx.config.totp.windowStep,
  );
}

export async function enrollTotp(
  db: NodePgDatabase,
  input: EnrollTotpInput,
  ctx: IdentityContext,
): Promise<EnrollTotpResult> {
  const userId = assertUserId(input.userId);
  const secret = base32Encode(randomBytes(20));

  await runTx(db, async (tx) => {
    await advisoryLock(tx, credentialSetLockKey(userId));
    const rows = await tx
      .select({ confirmedAt: identityTotp.confirmedAt })
      .from(identityTotp)
      .where(eq(identityTotp.userId, userId))
      .for('update')
      .limit(1);
    if (rows[0]?.confirmedAt != null) {
      throw new TotpAlreadyEnrolledError(userId);
    }
    if (rows[0] != null) {
      // 挂起态重挂：换新密钥（旧密钥作废，扫描了旧二维码的用户必须重新扫）
      await tx
        .update(identityTotp)
        .set({
          secret: storedSecret(ctx, secret),
          confirmedAt: null,
          lastUsedStep: -1,
          updatedAt: sql`now()`,
        })
        .where(eq(identityTotp.userId, userId));
    } else {
      await tx.insert(identityTotp).values({ userId, secret: storedSecret(ctx, secret) });
    }
  });

  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'user',
      action: 'totp.enroll',
      targetType: 'user',
      targetId: userId,
    }),
  );
  const label = typeof input.label === 'string' && input.label.trim().length > 0 ? input.label.trim() : String(userId);
  const issuer = ctx.config.totp.issuer;
  const otpauthUrl =
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${ctx.config.totp.stepSec}`;
  return { secret, otpauthUrl };
}

export async function confirmTotp(
  db: NodePgDatabase,
  input: ConfirmTotpInput,
  ctx: IdentityContext,
): Promise<ConfirmTotpResult> {
  const userId = assertUserId(input.userId);
  const row = await loadTotp(db, userId);
  if (row == null) {
    throw new TotpNotEnrolledError(userId);
  }
  if (row.confirmedAt != null) {
    throw new TotpAlreadyEnrolledError(userId);
  }
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const step = matchTotp(ctx, row, code);
  if (step == null) {
    throw new InvalidTotpCodeError();
  }

  const recoveryCodes = Array.from({ length: ctx.config.totp.recoveryCodeCount }, () =>
    generateRecoveryCode((alphabetLen) => randomInt(alphabetLen)),
  );

  await runTx(db, async (tx) => {
    await advisoryLock(tx, credentialSetLockKey(userId));
    // CAS：仅挂起态可置 confirmed——并发 confirm/disable 在此互斥
    const confirmed = await tx
      .update(identityTotp)
      .set({ confirmedAt: sql`now()`, lastUsedStep: step, updatedAt: sql`now()` })
      .where(and(eq(identityTotp.userId, userId), isNull(identityTotp.confirmedAt)))
      .returning({ userId: identityTotp.userId });
    if (confirmed.length === 0) {
      const reread = await tx
        .select({ confirmedAt: identityTotp.confirmedAt })
        .from(identityTotp)
        .where(eq(identityTotp.userId, userId))
        .limit(1);
      if (reread[0]?.confirmedAt != null) {
        throw new TotpAlreadyEnrolledError(userId);
      }
      throw new TotpNotEnrolledError(userId);
    }
    // 恢复码整组重签（旧组全作废——重新注册场景不残留旧码）
    await tx.delete(identityRecoveryCodes).where(eq(identityRecoveryCodes.userId, userId));
    await tx
      .insert(identityRecoveryCodes)
      .values(recoveryCodes.map((codeText) => ({ userId, codeHash: sha256Hex(codeText) })));
  });

  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'user',
      action: 'totp.confirm',
      targetType: 'user',
      targetId: userId,
    }),
  );
  return { recoveryCodes };
}

export async function verifyMfa(
  db: NodePgDatabase,
  input: VerifyMfaInput,
  ctx: IdentityContext,
): Promise<VerifyMfaResult> {
  const userId = assertUserId(input.userId);
  const row = await loadTotp(db, userId);
  if (row == null || row.confirmedAt == null) {
    throw new TotpNotEnrolledError(userId);
  }
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (code.length === 0) {
    throw new InvalidTotpCodeError();
  }

  // TOTP：窗口匹配 → 步进单调 CAS（last_used_step < step 才放行；重放/旧码重用被拒）
  const step = matchTotp(ctx, row, code);
  if (step != null) {
    const advanced = await db
      .update(identityTotp)
      .set({ lastUsedStep: step, updatedAt: sql`now()` })
      .where(
        and(
          eq(identityTotp.userId, userId),
          isNotNull(identityTotp.confirmedAt),
          sql`${identityTotp.lastUsedStep} < ${step}`,
        ),
      )
      .returning({ userId: identityTotp.userId });
    if (advanced.length > 0) {
      return { method: 'totp' };
    }
    // 步号不前进（同码重放/并发先消费）→ 落入恢复码分支，最终统一 InvalidTotpCodeError
  }

  // 恢复码：哈希单次消费（used_at CAS）
  const consumed = await db
    .update(identityRecoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(identityRecoveryCodes.userId, userId),
        eq(identityRecoveryCodes.codeHash, sha256Hex(code)),
        isNull(identityRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: identityRecoveryCodes.id });
  if (consumed.length > 0) {
    return { method: 'recovery' };
  }
  throw new InvalidTotpCodeError();
}

export async function disableTotp(
  db: NodePgDatabase,
  input: DisableTotpInput,
  ctx: IdentityContext,
): Promise<{ disabled: boolean }> {
  const userId = assertUserId(input.userId);
  const row = await loadTotp(db, userId);
  if (row == null) {
    throw new TotpNotEnrolledError(userId);
  }
  if (row.confirmedAt != null) {
    // 已确认的 MFA 关闭必须验码（否则盗会话者可直关 MFA）
    if (input.code == null) {
      throw new InvalidTotpCodeError();
    }
    await verifyMfa(db, { userId, code: input.code }, ctx);
  }

  await runTx(db, async (tx) => {
    await advisoryLock(tx, credentialSetLockKey(userId));
    await tx.delete(identityTotp).where(eq(identityTotp.userId, userId));
    await tx.delete(identityRecoveryCodes).where(eq(identityRecoveryCodes.userId, userId));
  });

  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'user',
      action: 'totp.disable',
      targetType: 'user',
      targetId: userId,
    }),
  );
  return { disabled: true };
}
