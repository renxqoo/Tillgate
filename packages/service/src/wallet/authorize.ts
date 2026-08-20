/**
 * authorize 用例：冻结/预占——可用口径守卫（信用/现金双档）+ inFlight 占用。
 * 幂等快速路径在守卫之前（重放不该被余额守卫误伤）；跨用户键劫持 → RefKeyConflict。
 */
import type { RepoContext } from '@ai-gateway/repository';
import type { AuthorizationRow } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx, readOnly } from '../context.js';
import { assertCanDebit } from '@ai-gateway/domain';
import { BILLING_REF_TYPE, RefKeyConflictError, WalletInvariantError } from '@ai-gateway/domain';
import { assertCommandFingerprint, commandFingerprint } from '@ai-gateway/domain';
import { Decimal, normalizeAmount, parsePositiveAmount, toStorage } from '@ai-gateway/domain';
import { lockActiveAccounts, withTx } from './posting.js';
import { assertRefKey } from '././ref-key.js';
import { resolveCurrency } from '././currency.js';
import type { TxInjection, WalletEnv } from '././env.js';

export interface AuthorizeInput extends TxInjection {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  /** 冻结单过期时刻（billing 语义下不用——生命周期归 billing 显式管理） */
  expiresAt?: Date;
  memo?: string;
  /** false = 现金口径守卫（授信不参与可用额）；缺省 = 信用口径 */
  allowCredit?: boolean;
  /**
   * 仅结算补扣内部使用：允许形成负余额。必须同时满足 billing refType 与 #over 自然键，
   * 普通授权调用无法借此绕过余额守卫。
   */
  collectOverage?: boolean;
}

export interface AuthorizeResult {
  authorizationId: string;
  amount: string;
  status: 'active' | 'settled' | 'released' | 'expired';
  expiresAt: string | null;
  replayed: boolean;
}

/** 幂等键归属校验：同 (refType, refId) 跨用户/币种顶撞必须炸，不能把别人的当自己的重放 */
async function assertAuthorizationOwner(
  repos: Repositories,
  c: RepoContext,
  authorization: { accountId: string },
  refType: string,
  refId: string,
  userId: number,
  currency: string,
): Promise<void> {
  const owner = await repos.wallet.accountOwner(c, authorization.accountId);
  if (owner?.userId !== userId || owner?.currency !== currency) {
    throw new RefKeyConflictError(refType, refId, owner?.userId ?? 0);
  }
}

function authorizationResult(
  auth: AuthorizationRow,
  replayed: boolean,
): AuthorizeResult {
  return {
    authorizationId: auth.id,
    amount: normalizeAmount(auth.amount),
    status: auth.status as AuthorizeResult['status'],
    expiresAt: auth.expiresAt ? auth.expiresAt.toISOString() : null,
    replayed,
  };
}

export function createAuthorizeUseCase(env: WalletEnv) {
  const { db, guards, currency: defaultCurrency } = env;
  const repos = env.repos ?? createRepositories();
  return async function authorize(ctx: RunContext, input: AuthorizeInput): Promise<AuthorizeResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    assertRefKey(guards, input.refType, input.refId);
    const amount = parsePositiveAmount(input.amount);
    if (input.expiresAt && !(input.expiresAt instanceof Date)) {
      throw new WalletInvariantError('authorize.expiresAt');
    }
    if (
      input.collectOverage === true &&
      (input.refType !== BILLING_REF_TYPE || !input.refId.endsWith('#over'))
    ) {
      throw new WalletInvariantError('authorize.collectOverage_scope');
    }
    const fingerprint = commandFingerprint('authorize', {
      userId: input.userId,
      currency,
      amount: normalizeAmount(input.amount),
      expiresAt: input.expiresAt?.toISOString() ?? null,
      // 只在显式 false 时进指纹：缺省与 true 语义等价
      allowCredit: input.allowCredit === false ? false : undefined,
      collectOverage: input.collectOverage === true ? true : undefined,
      memo: input.memo ?? null,
    });

    // 幂等快速路径：守卫之前先查既有（重放不该被余额守卫误伤）
    const c0 = readOnly(ctx, db);
    const prior = await repos.wallet.findAuthorization(c0, input.refType, input.refId);
    if (prior) {
      await assertAuthorizationOwner(repos, c0, prior, input.refType, input.refId, input.userId, currency);
      assertCommandFingerprint(prior.authorizeFingerprint, fingerprint, input.refType, input.refId, 'authorize');
      return authorizationResult(prior, true);
    }

    try {
      return await withTx(db, input.tx, async (tx) => {
        const c = inTx(ctx, tx);
        const accountId = await repos.wallet.ensureUserAccount(c, input.userId, currency);
        const locked = await lockActiveAccounts(repos, c, [accountId]);
        const account = locked.get(accountId)!;
        if (input.collectOverage !== true) {
          assertCanDebit(account, amount, input.userId, { allowCredit: input.allowCredit });
        }
        const authorizationId = await repos.wallet.insertAuthorization(c, {
          accountId,
          refType: input.refType,
          refId: input.refId,
          amount: toStorage(amount),
          expiresAt: input.expiresAt ?? null,
          memo: input.memo ?? null,
          authorizeFingerprint: fingerprint,
        });
        await repos.wallet.setInFlight(
          c,
          accountId,
          toStorage(new Decimal(account.inFlight).plus(amount)),
        );
        return {
          authorizationId,
          amount: normalizeAmount(input.amount),
          status: 'active' as const,
          expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
          replayed: false,
        };
      });
    } catch (error) {
      if (repos.wallet.isUniqueViolation(error)) {
        const conn = readOnly(ctx, db);
        const existing = await repos.wallet.findAuthorization(conn, input.refType, input.refId);
        if (existing) {
          await assertAuthorizationOwner(repos, conn, existing, input.refType, input.refId, input.userId, currency);
          assertCommandFingerprint(existing.authorizeFingerprint, fingerprint, input.refType, input.refId, 'authorize');
          return authorizationResult(existing, true);
        }
      }
      throw error;
    }
  };
}
