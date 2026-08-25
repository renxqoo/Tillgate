/**
 * section 构建器共享装配对象（facade 内部——不出公共出口面）：
 * facade 解析完缺省回退与覆盖缝后一次性分发；各域 section 只解构所需字段，
 * 字段名与 facade 内局部名一致（env/stores/audit/…），保证委托体从 facade
 * 逐字搬迁时不改写依赖引用名。
 */

import type { ControlPlaneEnv } from '../control-plane';
import type { FxDeps } from '../application/fx/fx-shared';
import type { UpdateBillingTimezoneDeps } from '../application/settings/update-billing-timezone';
import type { UpdateIntegrationDeps } from '../application/integrations/update-integration';
import type { SourceCacheDeps } from '../application/catalog/fetch-source-models';
import type { AuditSink, AuditTxSink } from '../ports/audit-sink';
import type { VoucherStorage } from '../ports/voucher-storage';
import type { AdminStore } from '../ports/admin-store';
import type { ChannelStore } from '../ports/channel-store';
import type { FxStore } from '../ports/fx-store';
import type { ModelStore } from '../ports/model-store';
import type { OperationsStore } from '../ports/operations-store';
import type { ProviderStore } from '../ports/provider-store';
import type { RateCardStore } from '../ports/rate-card-store';
import type { EndpointStore, PermissionStore, RoleStore } from '../ports/rbac-store';
import type { SettingsStore } from '../ports/settings-store';
import type { IntegrationSettingsStore } from '../ports/integration-settings-store';
import type { AuditStore } from '../ports/audit-store';

/** 覆盖缝解析后的 store 集：形状即 port 清单（缺省 postgres 适配器或注入覆盖，单一真相） */
export interface ResolvedStores {
  readonly provider: ProviderStore;
  readonly channel: ChannelStore;
  readonly model: ModelStore;
  readonly rateCard: RateCardStore;
  readonly fx: FxStore;
  readonly audit: AuditStore;
  readonly operations: OperationsStore;
  readonly admin: AdminStore;
  readonly role: RoleStore;
  readonly permission: PermissionStore;
  readonly endpoint: EndpointStore;
  readonly settings: SettingsStore;
  readonly integrationSettings: IntegrationSettingsStore;
}

/** facade → 各域 section 的分发对象（cache 经 sourceDeps 携带，不单列字段） */
export interface SectionDeps {
  readonly env: ControlPlaneEnv;
  readonly stores: ResolvedStores;
  readonly audit: AuditSink;
  readonly auditTx: AuditTxSink;
  readonly voucherStorage: VoucherStorage;
  readonly fxDeps: FxDeps;
  readonly settingsDeps: UpdateBillingTimezoneDeps;
  readonly integrationDeps: UpdateIntegrationDeps;
  readonly sourceDeps: SourceCacheDeps;
}
