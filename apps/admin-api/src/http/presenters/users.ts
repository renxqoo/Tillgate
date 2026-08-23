/**
 * 用户域 presenter：facade 行 → api-client DTO 快照形状（wire 键名对齐
 * packages/api-client/src/dto/admin-api.ts;日期一律 ISO 字符串）。
 * 富化口径 = v1 users.service enrich：available = balance + creditLimit − inFlight。
 */
import type { AccountSnapshot } from '@tokenlens/billing';
import { Decimal } from '@tokenlens/billing';
import { iso } from '../contracts/common';

export interface UserRowSource {
  readonly id: number;
  readonly issuer: string;
  readonly subject: string;
  readonly identityProvider: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly rateCardId: number | null;
  readonly dailySpendLimit: string | null;
  readonly status: number;
  readonly isEnterprise: boolean;
  readonly freezeReason: string | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export interface UserWireRow {
  id: number;
  issuer: string | null;
  subject: string;
  identityProvider: string | null;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  balance: string;
  reservedBalance: string;
  availableBalance: string;
  creditLimit: string;
  dailySpendLimit: string | null;
  status: number;
  isEnterprise: boolean;
  freezeReason: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** 钱包富化（无账户 = 全零——v1 语义;N+1 每行由路由并发） */
export function walletEnrichmentOf(snapshots: readonly AccountSnapshot[]): {
  balance: string;
  reservedBalance: string;
  creditLimit: string;
  availableBalance: string;
} {
  const first = snapshots[0];
  if (first === undefined) {
    return { balance: '0', reservedBalance: '0', creditLimit: '0', availableBalance: '0' };
  }
  return {
    balance: first.balance,
    reservedBalance: first.inFlight,
    creditLimit: first.creditLimit,
    availableBalance: new Decimal(first.balance)
      .plus(first.creditLimit)
      .minus(first.inFlight)
      .toString(),
  };
}

export function toUserWireRow(
  user: UserRowSource,
  enrichment: {
    balance: string;
    reservedBalance: string;
    creditLimit: string;
    availableBalance: string;
  },
  rateCardName: string | null = null,
): UserWireRow {
  return {
    id: user.id,
    issuer: user.issuer,
    subject: user.subject,
    identityProvider: user.identityProvider,
    email: user.email,
    displayName: user.displayName,
    rateCardId: user.rateCardId,
    rateCardName,
    balance: enrichment.balance,
    reservedBalance: enrichment.reservedBalance,
    availableBalance: enrichment.availableBalance,
    creditLimit: enrichment.creditLimit,
    dailySpendLimit: user.dailySpendLimit,
    status: user.status,
    isEnterprise: user.isEnterprise,
    freezeReason: user.freezeReason,
    rpmLimit: user.rpmLimit,
    tpmLimit: user.tpmLimit,
    lastLoginAt: iso(user.lastLoginAt),
    createdAt: iso(user.createdAt)!,
  };
}

/** 钱包流水行（腿级 → v1 transactions 行;createdBy 无来源恒 null——MIGRATION §4 D4 族） */
export interface TransactionWireRow {
  id: number;
  userId: number;
  type: string;
  amount: string;
  balanceAfter: string;
  refType: string;
  refId: string;
  remark: string | null;
  createdAt: string;
  createdBy: number | null;
}

export interface StatementItemSource {
  readonly legId: number;
  readonly transactionKind: string;
  readonly refType: string;
  readonly refId: string;
  readonly amount: string;
  readonly balanceAfter: string;
  readonly memo: string | null;
  readonly createdAt: Date;
}

export function toTransactionWireRow(
  userId: number,
  item: StatementItemSource,
): TransactionWireRow {
  return {
    id: item.legId,
    userId,
    type: item.transactionKind,
    amount: item.amount,
    balanceAfter: item.balanceAfter,
    refType: item.refType,
    refId: item.refId,
    remark: item.memo,
    createdAt: iso(item.createdAt)!,
    createdBy: null,
  };
}
