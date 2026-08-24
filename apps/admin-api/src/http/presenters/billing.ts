/**
 * billing 管理域 presenter：plans/订阅管理/兑换批次/死信行 → wire DTO 快照形状。
 * 金额出站点归一（numeric(38,18) 存储精度不裸出）;兑换码 codeMasked = 哈希脱敏
 * （明文不存在于库——v1 同口径）;createdBy/usedBy wire 为字符串（v1 形状）。
 */
import { normalizeAmount } from '@tillgate/billing';
import { iso } from '../contracts/common';

export interface PlanRowSource {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly sortOrder: number | null;
  readonly price: string;
  readonly periodDays: number;
  readonly quotaAmount: string;
  readonly allowSeats: boolean;
  readonly status: number;
}

export function toPlanWireRow(row: PlanRowSource) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sortOrder,
    price: normalizeAmount(row.price),
    periodDays: row.periodDays,
    quotaAmount: normalizeAmount(row.quotaAmount),
    allowSeats: row.allowSeats,
    status: row.status,
  };
}

export interface AdminSubscriptionSource {
  readonly id: number;
  readonly userId: number;
  readonly userSubject: string;
  readonly userDisplayName: string | null;
  readonly planId: number;
  readonly planName: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly quotaAmount: string;
  readonly usedAmount: string;
  readonly reservedAmount: string;
  readonly quantity: number;
  readonly price: string;
  readonly remainingAmount: string;
  readonly status: number;
  readonly createdAt: Date;
}

export function toSubscriptionWireRow(row: AdminSubscriptionSource) {
  return {
    id: row.id,
    userId: row.userId,
    userSubject: row.userSubject,
    userDisplayName: row.userDisplayName,
    planId: row.planId,
    planName: row.planName,
    startAt: iso(row.startAt)!,
    endAt: iso(row.endAt)!,
    quotaAmount: normalizeAmount(row.quotaAmount),
    usedAmount: normalizeAmount(row.usedAmount),
    reservedAmount: normalizeAmount(row.reservedAmount),
    quantity: row.quantity,
    price: normalizeAmount(row.price),
    remainingAmount: normalizeAmount(row.remainingAmount),
    status: row.status,
    createdAt: iso(row.createdAt)!,
  };
}

export interface RedeemBatchSource {
  readonly id: number;
  readonly name: string;
  readonly remark: string | null;
  readonly amount: string;
  readonly total: number;
  readonly usedCount: number;
  readonly createdBy: number | null;
  readonly createdAt: Date;
}

export function toBatchWireRow(row: RedeemBatchSource) {
  return {
    id: row.id,
    name: row.name,
    remark: row.remark,
    amount: normalizeAmount(row.amount),
    total: row.total,
    usedCount: row.usedCount,
    createdBy: row.createdBy === null ? null : String(row.createdBy),
    createdAt: iso(row.createdAt)!,
  };
}

/** 哈希脱敏:首 8 + **** + 尾 4（明文不可再现——库内只有 SHA-256） */
function maskCodeHash(codeHash: string): string {
  return `${codeHash.slice(0, 8)}****${codeHash.slice(-4)}`;
}

export interface RedeemCodeSource {
  readonly id: number;
  readonly codeHash: string;
  readonly status: number;
  readonly usedBy: number | null;
  readonly usedAt: Date | null;
  readonly expiresAt: Date | null;
}

export function toCodeWireRow(row: RedeemCodeSource) {
  return {
    id: row.id,
    codeMasked: maskCodeHash(row.codeHash),
    status: row.status,
    usedBy: row.usedBy === null ? null : String(row.usedBy),
    usedAt: iso(row.usedAt),
    expiresAt: iso(row.expiresAt),
  };
}

export interface DeadCaseSource {
  readonly requestId: string;
  readonly userId: number;
  readonly status: string;
  readonly revision: number;
  readonly attempt: number;
  readonly failureCode: string | null;
  readonly lastError: string | null;
  readonly reservedAmount: string | null;
  readonly createdAt: Date;
}

export function toDeadCaseWireRow(row: DeadCaseSource) {
  return {
    requestId: row.requestId,
    userId: row.userId,
    status: row.status,
    revision: row.revision,
    attempt: row.attempt,
    failureCode: row.failureCode,
    lastError: row.lastError,
    ...(row.reservedAmount !== null ? { reservedAmount: normalizeAmount(row.reservedAmount) } : {}),
    createdAt: iso(row.createdAt)!,
  };
}
