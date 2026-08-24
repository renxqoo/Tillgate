/**
 * @tillgate/control-plane 公共出口：控制面配置能力（Provider/Channel/Model/RateCard/fx/目录）。
 * 出口面刻意极小且由 __test__/boundary.test.ts 快照锁定——只暴露 facade、用例出入参、
 * 领域纯函数与错误目录；store/适配器/drizzle 行类型不出包（§5.3）。
 */

// ---- facade ----
export { createControlPlane } from './control-plane';
export type { ControlPlane, ControlPlaneEnv } from './control-plane';

// ---- 调用上下文 ----
export type { Actor, ControlContext } from './application/context';

// ---- 错误目录（§11：码表封闭性由边界测试锁定）----
export { controlPlaneErrors } from './errors';

// ---- 领域纯函数与值类型 ----
export { formatCoefficient, validateCoefficient } from './domain/rate-card/coefficient';
export { applyBuffer, normalizeRate, normalizeBuffer, trimNumeric } from './domain/fx/fx-rates';
export type { FxState, FxConfig } from './domain/fx/fx-rates';
export {
  suggestExternalName,
  mapOpenAiCompatibleCatalog,
  mapModelsDevCatalog,
  isUnpriceableSentinel,
} from './domain/catalog/catalog';
export type {
  CatalogItem,
  CatalogComparison,
  CatalogCurrency,
  CatalogDiffState,
} from './domain/catalog/catalog';
export { compareCatalog, goneFromCatalog } from './domain/catalog/compare';
export { toCny } from './domain/catalog/convert';
export { isFreeByPrice, freePriceConsistent } from './domain/model/model-pricing';
export { maskUpstreamKey } from './domain/channel/channel';
export { parseVoucherDataUrl } from './domain/channel/voucher';
export { assertOperationId, commandFingerprint } from './domain/operation';
export type { ListQuery, ListResult, SortOrder } from './domain/list';
export type { BillingConfig, PricingUnit, ModelPrices } from './domain/model/model';
export { PRICING_UNITS } from './domain/model/model';
export type { ProviderCapabilities } from './domain/provider/provider';

// ---- RBAC（ADR-0008:动态角色 + 权限树;静态矩阵已退役）----
export { PERMISSION_DOMAINS } from './domain/rbac';
export type { PermissionDomain } from './domain/rbac';
export { ENFORCED_CODES, isEnforcedCode, granted } from './domain/rbac';
export type { EnforcedCode, AdminGrants, AdminAccess } from './domain/rbac';
export type {
  RoleRecord,
  RoleListQuery,
  RoleListResult,
  CreateRoleRow,
  UpdateRoleRow,
  PermissionNode,
  CreatePermissionRow,
  UpdatePermissionRow,
  RoleStore,
  PermissionStore,
} from './ports/rbac-store';
export type { RoleUpdateResult } from './application/rbac/update-role';
export type { EndpointBindingRecord, CreateEndpointRow, EndpointStore } from './ports/rbac-store';
export type {
  AdminRecord,
  CreateAdminRow,
  UpdateAdminRow,
  AdminListQuery,
  AdminListResult,
} from './ports/admin-store';
export type { CreateAdminInput } from './application/admins/create-admin';

// ---- 装配/桥接 port 契约（assembly 实现与 observability 桥消费）----
export type { UpstreamProbe, ProbeTarget, ProbeOutcome } from './ports/upstream-probe';
export type { SecretCipher } from './ports/secret-cipher';
export type { CatalogSource, CatalogChannelGuard } from './ports/catalog-source';
export type { ActiveMappingRow, EnabledModelRow } from './ports/model-store';
export type { RouteCandidateRow } from './ports/channel-store';
export type { UserRateCardContext } from './ports/rate-card-store';
export type { AuditSink, AuditTxSink, AuditEntry, AuditActor } from './ports/audit-sink';
export type { VoucherStorage } from './ports/voucher-storage';
export type { CatalogCache, CatalogCacheEntry } from './ports/cache';
export { createMemoryCatalogCache } from './ports/cache';
// 外部目录源 adapter 不出根入口（§5.3）——装配经 ./composition 子入口引用：
//   import { createOpenRouterSource, modelsDevSource } from '@tillgate/control-plane/composition';

// ---- 用例出入参（app 路由层契约）----
export type { CreateProviderInput } from './application/providers/create-provider';
export type { UpdateProviderInput } from './application/providers/update-provider';
export type { DeleteProviderInput } from './application/providers/delete-provider';
export type { UndeleteProviderInput } from './application/providers/undelete-provider';
export type { ProviderListQuery } from './ports/provider-store';
export type { CreateChannelInput } from './application/channels/create-channel';
export type { UpdateChannelInput } from './application/channels/update-channel';
export type { DeleteChannelInput } from './application/channels/delete-channel';
export type { UndeleteChannelInput } from './application/channels/undelete-channel';
export type {
  ImportChannelsInput,
  ImportChannelsResult,
} from './application/channels/import-channels';
export type { RechargeChannelInput } from './application/channels/recharge-channel';
export type { AdjustChannelInput } from './application/channels/adjust-channel';
export type { ListRechargesInput } from './application/channels/list-recharges';
export type { CreateModelInput } from './application/models/create-model';
export type { UpdateModelInput } from './application/models/update-model';
export type { DeleteModelInput } from './application/models/delete-model';
export type { UndeleteModelInput } from './application/models/undelete-model';
export type { ListModelsQuery } from './application/models/list-models';
export type { BindModelChannelsInput } from './application/models/bind-model-channels';
export type { CreateRateCardInput } from './application/rates/create-rate-card';
export type { UpdateRateCardInput } from './application/rates/update-rate-card';
export type { DeleteRateCardInput } from './application/rates/delete-rate-card';
export type { ListRateCardUsersInput } from './application/rates/list-rate-card-users';
export type { RefreshFxInput } from './application/fx/refresh-fx';
export type { SetFxOverrideInput } from './application/fx/set-fx-override';
export type { ClearFxOverrideInput } from './application/fx/clear-fx-override';
export type { SetFxBufferInput } from './application/fx/set-fx-buffer';
export type { ImportCatalogInput } from './application/catalog/import-catalog';
