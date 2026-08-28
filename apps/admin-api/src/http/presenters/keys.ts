/**
 * Key 域 presenter：ApiKeyRecord → AdminKeyRow（api-client DTO 快照形状）。
 * userEmail/userDisplayName 恒 null——accounts 行无用户 join。
 */
import { iso, isoRequired } from '../contracts/common';

/** Key 行（userEmail/userDisplayName 恒 null——accounts 行无用户 join） */
export interface KeyWireRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  subscriptionId: number | null;
  userId: number;
  userEmail: string | null;
  userDisplayName: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailySpendLimit: string | null;
  status: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface KeyRowSource {
  readonly id: number;
  readonly keyPreview: string;
  readonly name: string;
  readonly remark: string | null;
  readonly subscriptionId: number | null;
  readonly userId: number;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly dailySpendLimit: string | null;
  readonly status: number;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export function toKeyWireRow(key: KeyRowSource): KeyWireRow {
  return {
    id: key.id,
    keyPreview: key.keyPreview,
    name: key.name,
    remark: key.remark,
    subscriptionId: key.subscriptionId,
    userId: key.userId,
    userEmail: null,
    userDisplayName: null,
    rpmLimit: key.rpmLimit,
    tpmLimit: key.tpmLimit,
    dailySpendLimit: key.dailySpendLimit,
    status: key.status,
    lastUsedAt: iso(key.lastUsedAt),
    createdAt: isoRequired(key.createdAt),
  };
}
