/**
 * 兑换批次创建：明文码在内存生成、仅此一次返回；库内只落 SHA-256 哈希
 * （code_hash 唯一索引）。生成器经注入（app 装配传 http generateRedeemCode；
 * 本包不 import http——分层防环）。
 */
import { BillingErrors } from '../../domain/errors.js';
import { sha256Hex } from '../redemption/redemption.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { RedeemCodeStore } from '../../ports/payment-ports.js';

export interface CreateBatchInput {
  /** 操作管理员（批次行 createdBy 数据列） */
  createdBy: number;
  name: string;
  remark?: string | null;
  amount: string;
  count: number;
  expiresAt?: Date | null;
}

export interface CreateBatchResult {
  batch: { id: number; name: string; amount: string; total: number };
  /** 明文码全量（仅此一次返回——之后不可再现） */
  codes: string[];
}

export async function createBatch(
  env: {
    store: Pick<BillingStore, 'read' | 'transaction'>;
    codes: Pick<RedeemCodeStore, 'insertBatchWithCodes' | 'findBatch'>;
    generateCode: () => string;
  },
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  const plaintexts = Array.from({ length: input.count }, () => env.generateCode());
  const { batchId } = await env.store.transaction((tx) =>
    env.codes.insertBatchWithCodes(tx, {
      batchName: input.name,
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
      amount: input.amount,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      codeHashes: plaintexts.map((plaintext) => sha256Hex(plaintext)),
    }),
  );
  const row = await env.store.read((conn) => env.codes.findBatch(conn, batchId));
  if (row === null) {
    throw BillingErrors.business('redeem_batch_not_found', { batchId: String(batchId) });
  }
  return {
    batch: { id: row.id, name: row.name, amount: row.amount, total: row.total },
    codes: plaintexts,
  };
}
