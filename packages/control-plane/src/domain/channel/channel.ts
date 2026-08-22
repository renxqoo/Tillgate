/**
 * 渠道域规则（纯函数）：状态词表、密钥脱敏、输入形状。
 * 密钥生命周期语义（落库即密文/换 Key 复位运行态/回显仅预览）由 application 承担，
 * 本文件只持有不可变口径。
 */
import type { ErrorContext } from '@tokenlens/errors';
import { controlPlaneErrors } from '../../errors';
import { parseNonNegativeAmount } from '../money';

/**
 * 渠道状态（v1 口径）：
 * 0 启用 / 1 禁用（软退役同值）/ 2 维护 / 3 熔断(自动，进货复活) / 4 凭据无效（连续 401/403，换 Key 后恢复）
 */
export const CHANNEL_STATUSES = [0, 1, 2, 3, 4] as const;

export interface ChannelCreateInput {
  readonly providerId: number;
  readonly name: string;
  readonly apiKey: string;
  readonly baseUrlOverride?: string | null;
  readonly models?: string[] | null;
  readonly weight?: number;
  readonly priority?: number;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
}

export interface ChannelPatchInput {
  readonly name?: string;
  readonly apiKey?: string;
  readonly baseUrlOverride?: string | null;
  readonly models?: string[] | null;
  readonly weight?: number;
  readonly priority?: number;
  readonly status?: number;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
  readonly upstreamThreshold?: string | null;
}

/** 上游密钥预览（无固定前缀，多展示一位头部便于区分供应商）：sk-abcdef0123xyz → sk-a****3xyz */
export function maskUpstreamKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return plaintext.slice(0, 4) + '****' + plaintext.slice(-4);
}

function invalid(detail: ErrorContext): never {
  throw controlPlaneErrors.business('invalid_channel_input', detail);
}

function assertLimit(name: 'rpmLimit' | 'tpmLimit', value: number): void {
  if (!Number.isInteger(value) || value < 1) invalid({ [name]: value });
}

/** 创建输入形状（v1 zod 域：name 1-64 / apiKey 1-512 / 覆盖地址 ≤255 / weight·priority 0-1e6 / 限流正整数） */
export function validateChannelCreate(input: ChannelCreateInput): ChannelCreateInput {
  if (!Number.isInteger(input.providerId) || input.providerId < 1)
    invalid({ providerId: input.providerId });
  if (input.name.length < 1 || input.name.length > 64) invalid({ name: input.name });
  if (input.apiKey.length < 1 || input.apiKey.length > 512) invalid({ apiKey: 'length' });
  if (input.baseUrlOverride != null && input.baseUrlOverride.length > 255) {
    invalid({ baseUrlOverride: input.baseUrlOverride });
  }
  for (const limit of ['weight', 'priority'] as const) {
    const value = input[limit];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 1_000_000)) {
      invalid({ [limit]: value });
    }
  }
  if (input.rpmLimit != null) assertLimit('rpmLimit', input.rpmLimit);
  if (input.tpmLimit != null) assertLimit('tpmLimit', input.tpmLimit);
  return input;
}

/** 更新补丁形状（apiKey 可选出现即换 Key；upstreamThreshold 非负金额串或 null=清阈值） */
export function validateChannelPatch(patch: ChannelPatchInput): ChannelPatchInput {
  if (patch.name !== undefined && (patch.name.length < 1 || patch.name.length > 64)) {
    invalid({ name: patch.name });
  }
  if (patch.apiKey !== undefined && (patch.apiKey.length < 1 || patch.apiKey.length > 512)) {
    invalid({ apiKey: 'length' });
  }
  if (patch.baseUrlOverride != null && patch.baseUrlOverride.length > 255) {
    invalid({ baseUrlOverride: patch.baseUrlOverride });
  }
  for (const limit of ['weight', 'priority'] as const) {
    const value = patch[limit];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 1_000_000)) {
      invalid({ [limit]: value });
    }
  }
  if (
    patch.status !== undefined &&
    !(CHANNEL_STATUSES as readonly number[]).includes(patch.status)
  ) {
    invalid({ status: patch.status });
  }
  if (patch.rpmLimit !== undefined && patch.rpmLimit !== null)
    assertLimit('rpmLimit', patch.rpmLimit);
  if (patch.tpmLimit !== undefined && patch.tpmLimit !== null)
    assertLimit('tpmLimit', patch.tpmLimit);
  if (
    patch.upstreamThreshold !== undefined &&
    patch.upstreamThreshold !== null &&
    parseNonNegativeAmount(patch.upstreamThreshold) == null
  ) {
    invalid({ upstreamThreshold: patch.upstreamThreshold });
  }
  return patch;
}

/** 批量导入条目形状（provider 按名解析；weight ≥1 / priority ≥0 整数） */
export interface ChannelImportItem {
  readonly provider: string;
  readonly name: string;
  readonly apiKey: string;
  readonly models?: string[];
  readonly weight?: number;
  readonly priority?: number;
}

export function validateChannelImportItem(item: ChannelImportItem): ChannelImportItem {
  if (item.provider.length < 1) invalid({ provider: item.provider });
  if (item.name.length < 1 || item.name.length > 64) invalid({ name: item.name });
  if (item.apiKey.length < 1 || item.apiKey.length > 512) invalid({ apiKey: 'length' });
  if (item.weight !== undefined && (!Number.isInteger(item.weight) || item.weight < 1)) {
    invalid({ weight: item.weight });
  }
  if (item.priority !== undefined && !Number.isInteger(item.priority)) {
    invalid({ priority: item.priority });
  }
  return item;
}
