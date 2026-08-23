/**
 * 兑换批次管理 facade（U6；组合件——动词各居一文件，此处只做绑定）。
 * app 装配：store/codes 取自 ./composition（postgres），generateCode 注入
 * `@tokenlens/http` 的 generateRedeemCode（本包不 import http——防环）。
 */
import type { BillingStore } from '../../ports/billing-store.js';
import type { RedeemCodeStore } from '../../ports/payment-ports.js';
import { createBatch, type CreateBatchInput, type CreateBatchResult } from './create-batch.js';
import { listBatches, type ListBatchesQuery } from './list-batches.js';
import { batchDetail } from './batch-detail.js';
import { listCodes, type ListCodesQuery } from './list-codes.js';
import { revokeCode } from './revoke-code.js';

export interface RedeemBatchesApi {
  create(input: CreateBatchInput): Promise<CreateBatchResult>;
  list(
    query: ListBatchesQuery,
  ): Promise<{ rows: Awaited<ReturnType<typeof listBatches>>['rows']; total: number }>;
  detail(
    batchId: number,
  ): Promise<ReturnType<typeof batchDetail> extends Promise<infer T> ? T : never>;
  codes(query: ListCodesQuery): Promise<{ rows: RedeemCodeRecordLike[]; total: number }>;
  revoke(input: { codeId: number }): Promise<{ ok: true }>;
}

type RedeemCodeRecordLike = Awaited<ReturnType<typeof listCodes>>['rows'][number];
type RedeemBatchRecordLike = Awaited<ReturnType<typeof listBatches>>['rows'][number];

export function createRedeemBatchApi(env: {
  store: Pick<BillingStore, 'read' | 'transaction'>;
  codes: RedeemCodeStore;
  generateCode: () => string;
}): RedeemBatchesApi {
  return {
    create: (input) => createBatch(env, input),
    list: (query) => listBatches(env, query),
    detail: (batchId) => batchDetail(env, batchId),
    codes: (query) => listCodes(env, query),
    revoke: (input) => revokeCode(env, input),
  };
}

export type { CreateBatchInput, CreateBatchResult, ListBatchesQuery, ListCodesQuery };
export type { RedeemBatchRecordLike, RedeemCodeRecordLike };
