/**
 * accounts 三桥接件（装配面——仅 assembly.ts 引用,architecture 测试锁定）。
 *   - walletCredit 独立事务形态（accounts 赠送/推荐入账动词不在 admin 面）;
 *   - sessionInvalidation 后置推进（identity 锚点存储无外部 tx 参与面;
 *     失败仍抛错——邮箱变更 500,不静默吞）;
 *   - 审计同事务写入（失败随 accounts 业务事务回滚）。
 */
import type { WalletCreditPort, AuditPort } from '@tillgate/accounts';
import type { DbLike } from '@tillgate/db';
import type { WalletApi } from '@tillgate/billing';
import type { Identity } from '@tillgate/identity';

/**
 * 会话失效 port 的结构镜像（accounts 根出口暂未导出该类型,此处按「消费方定义 port」
 * 口径本地持形,形状漂移由 createAccounts 装配点类型检查兜底）。
 */
export interface AdminSessionInvalidation {
  invalidateUserSessions(db: unknown, input: { realm: string; userId: number }): Promise<void>;
}

type WriteAuditFn = (
  db: DbLike,
  entry: {
    actor: 'admin' | 'user' | 'system';
    adminId?: number | null;
    action: string;
    targetType: string;
    targetId?: string | number | null;
    detail?: Record<string, unknown> | null;
  },
) => Promise<void>;

export function createWalletCreditBridge(wallet: Pick<WalletApi, 'credit'>): WalletCreditPort {
  return {
    credit: async (_db, command) => {
      const posted = await wallet.credit({
        userId: command.userId,
        amount: command.amount,
        refType: command.refType,
        refId: command.refId,
        ...(command.memo !== undefined ? { memo: command.memo } : {}),
      });
      return { replayed: posted.replayed };
    },
  };
}

export function createSessionInvalidationBridge(
  revocation: Pick<Identity['revocation'], 'advance'>,
): AdminSessionInvalidation {
  return {
    invalidateUserSessions: async (_db, input) => {
      await revocation.advance({ realm: input.realm, userId: input.userId });
    },
  };
}

export function createAuditSinkBridge(audit: WriteAuditFn): AuditPort {
  return {
    record: (db, action) =>
      audit(db, {
        actor: action.actor,
        adminId: action.adminId,
        action: action.action,
        targetType: action.targetType,
        ...(action.targetId !== undefined ? { targetId: action.targetId } : {}),
        ...(action.detail !== undefined ? { detail: action.detail } : {}),
      }),
  };
}
