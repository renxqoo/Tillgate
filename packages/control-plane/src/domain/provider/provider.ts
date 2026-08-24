/**
 * 供应商域规则（纯函数）：词表校验（协议/厂商档案）与输入形状。
 * 词表单一真相在 ai 适配器注册表——本包经装配注入快照（capabilities），
 * 不 import ai（总纲 §4.5/§5.2 防环规则）。
 */
import type { ErrorContext } from '@tillgate/errors';
import { controlPlaneErrors } from '../../errors';

/** 可执行能力词表快照（装配注入：protocols = ai.SUPPORTED_PROTOCOLS，vendorProfiles = ai.vendorProfileNames()） */
export interface ProviderCapabilities {
  readonly protocols: readonly string[];
  readonly vendorProfiles: readonly string[];
}

/** 供应商状态：0 启用 / 1 禁用（退役 = 软禁用） */
export const PROVIDER_STATUSES = [0, 1] as const;

export interface ProviderCreateInput {
  readonly name: string;
  /** undefined = 装配缺省（env.defaultProtocol 注入——铁律 3，不藏全局默认） */
  readonly protocol?: string;
  /** null/'' = 清除档案（纯透传） */
  readonly vendor?: string | null;
  readonly baseUrl: string;
  readonly status?: number;
}

export interface ProviderPatchInput {
  readonly name?: string;
  readonly protocol?: string;
  readonly vendor?: string | null;
  readonly baseUrl?: string;
  readonly status?: number;
}

/** 协议词表校验：未注册协议在配置期拒绝——防「建得进去、请求时才炸」的静默错配 */
export function assertProtocol(capabilities: ProviderCapabilities, protocol: string): string {
  if (!capabilities.protocols.includes(protocol)) {
    throw controlPlaneErrors.business('invalid_protocol', {
      protocol,
      allowed: capabilities.protocols.join(', '),
    });
  }
  return protocol;
}

/** 厂商档案词表校验：''/null 归一为 null（清除档案）；undefined 语义 = 不改，由调用方保留 */
export function assertVendor(
  capabilities: ProviderCapabilities,
  vendor: string | null,
): string | null {
  if (vendor === null || vendor === '') return null;
  if (!capabilities.vendorProfiles.includes(vendor)) {
    throw controlPlaneErrors.business('invalid_vendor', {
      vendor,
      allowed: capabilities.vendorProfiles.join(', ') || 'none',
    });
  }
  return vendor;
}

function invalid(detail: ErrorContext): never {
  throw controlPlaneErrors.business('invalid_provider_input', detail);
}

function assertBaseUrlShape(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') invalid({ baseUrl: url });
    if (url.length > 255) invalid({ baseUrl: url });
  } catch {
    invalid({ baseUrl: url });
  }
}

/** 创建输入形状（name 1-32 / baseUrl http(s) ≤255 / status ∈ {0,1}）+ 词表校验 */
export function validateProviderCreate(
  capabilities: ProviderCapabilities,
  input: ProviderCreateInput,
  defaultProtocol: string,
): { name: string; protocol: string; vendor: string | null; baseUrl: string; status: number } {
  if (input.name.length === 0 || input.name.length > 32) invalid({ name: input.name });
  assertBaseUrlShape(input.baseUrl);
  if (
    input.status !== undefined &&
    !(PROVIDER_STATUSES as readonly number[]).includes(input.status)
  ) {
    invalid({ status: input.status });
  }
  if (input.protocol !== undefined && input.protocol.length > 32) {
    invalid({ protocol: input.protocol });
  }
  if (input.vendor != null && input.vendor.length > 32) invalid({ vendor: input.vendor });
  const protocol = assertProtocol(capabilities, input.protocol ?? defaultProtocol);
  const vendor = input.vendor === undefined ? null : assertVendor(capabilities, input.vendor);
  return {
    name: input.name,
    protocol,
    vendor,
    baseUrl: input.baseUrl,
    status: input.status ?? 0,
  };
}

/** 更新补丁形状 + 词表校验（仅校验出现字段；vendor 保持 undefined 语义） */
export function validateProviderPatch(
  capabilities: ProviderCapabilities,
  patch: ProviderPatchInput,
): ProviderPatchInput {
  if (patch.name !== undefined && (patch.name.length === 0 || patch.name.length > 32)) {
    invalid({ name: patch.name });
  }
  if (patch.baseUrl !== undefined) assertBaseUrlShape(patch.baseUrl);
  if (
    patch.status !== undefined &&
    !(PROVIDER_STATUSES as readonly number[]).includes(patch.status)
  ) {
    invalid({ status: patch.status });
  }
  if (patch.protocol !== undefined && patch.protocol.length > 32) {
    invalid({ protocol: patch.protocol });
  }
  if (patch.protocol !== undefined) assertProtocol(capabilities, patch.protocol);
  if (patch.vendor !== undefined && patch.vendor !== null) {
    if (patch.vendor.length > 32) invalid({ vendor: patch.vendor });
    assertVendor(capabilities, patch.vendor);
  }
  return patch;
}
