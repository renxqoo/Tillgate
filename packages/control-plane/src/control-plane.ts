/**
 * createControlPlane facade：唯一装配面（app 只见 facade 与稳定契约）。
 * 内部组装 postgres 适配器族；装配级可覆盖件（审计出口/凭证存储/目录缓存）显式注入。
 * 返回面不泄漏 Db/DbTx/drizzle 行类型/供应商 SDK；分组用例按单元收敛。
 * 按域方法级委托住 src/sections/*-section.ts（逐字搬迁的域构建器）——本文件只做
 * 缺省解析、共享装配对象（SectionDeps）分发与 rbac/admins compose 收口。
 */
import type { Db } from '@tillgate/db';
import type { ProviderStore, ProviderRecord, ProviderSortField } from './ports/provider-store';
import type { ChannelStore, ChannelSortField, RechargeRow } from './ports/channel-store';
import type { ModelStore, ModelSortField, ModelRecord } from './ports/model-store';
import type {
  RateCardStore,
  RateCardSortField,
  RateCardUserSortField,
  RateCardUserRow,
} from './ports/rate-card-store';
import type { FxStore } from './ports/fx-store';
import type { SettingsStore } from './ports/settings-store';
import type { IntegrationSettingsStore } from './ports/integration-settings-store';
import type { AuditStore } from './ports/audit-store';
import type { OperationsStore } from './ports/operations-store';
import type { AdminStore } from './ports/admin-store';
import type { RoleStore, PermissionStore, EndpointStore } from './ports/rbac-store';
import type { AuditSink, AuditTxSink } from './ports/audit-sink';
import type { CatalogCache } from './ports/cache';
import type { CatalogSource } from './ports/catalog-source';
import type { SecretCipher } from './ports/secret-cipher';
import type { UpstreamProbe } from './ports/upstream-probe';
import type { VoucherStorage } from './ports/voucher-storage';
import type { ProviderCapabilities } from './domain/provider/provider';
import type { ListResult } from './domain/list';
import type { FxState } from './domain/fx/fx-rates';
import type { FxEnv, FxDeps } from './application/fx/fx-shared';
import type { RefreshFxInput } from './application/fx/refresh-fx';
import type { SetFxOverrideInput } from './application/fx/set-fx-override';
import type { ClearFxOverrideInput } from './application/fx/clear-fx-override';
import type { SetFxBufferInput } from './application/fx/set-fx-buffer';
import type { CreateProviderInput } from './application/providers/create-provider';
import type { UpdateProviderInput } from './application/providers/update-provider';
import type { DeleteProviderInput } from './application/providers/delete-provider';
import type { UndeleteProviderInput } from './application/providers/undelete-provider';
import type { CreateChannelInput, CreatedChannel } from './application/channels/create-channel';
import type { UpdateChannelInput, UpdatedChannel } from './application/channels/update-channel';
import type { DeleteChannelInput } from './application/channels/delete-channel';
import type { UndeleteChannelInput } from './application/channels/undelete-channel';
import type { ListChannelsResult } from './application/channels/list-channels';
import type {
  ImportChannelsInput,
  ImportChannelsResult,
} from './application/channels/import-channels';
import type { ProbeChannelResult } from './application/channels/probe-channel';
import type { RechargeChannelInput } from './application/channels/recharge-channel';
import type { AdjustChannelInput } from './application/channels/adjust-channel';
import type { ListRechargesInput } from './application/channels/list-recharges';
import type { CreateModelInput } from './application/models/create-model';
import type { UpdateModelInput } from './application/models/update-model';
import type { DeleteModelInput } from './application/models/delete-model';
import type { UndeleteModelInput } from './application/models/undelete-model';
import type { ListModelsResult } from './application/models/list-models';
import type { BindModelChannelsInput } from './application/models/bind-model-channels';
import type { ProbeModelResult } from './application/models/probe-model';
import type { CreateRateCardInput, CreatedRateCard } from './application/rates/create-rate-card';
import type { UpdateRateCardInput, UpdatedRateCard } from './application/rates/update-rate-card';
import type { DeleteRateCardInput } from './application/rates/delete-rate-card';
import type { RateCardListItem } from './application/rates/list-rate-cards';
import type { ListRateCardUsersInput } from './application/rates/list-rate-card-users';
import type { RateCardHealth } from './application/rates/check-rate-card-health';
import type { UpdateBillingTimezoneInput } from './application/settings/update-billing-timezone';
import type { UpdateIntegrationInput } from './application/integrations/update-integration';
import type { IntegrationListItem } from './application/integrations/list-integrations';
import type { CatalogComparisonPayload } from './application/catalog/compare-catalog';
import type { CatalogPriceHistoryEntry } from './application/catalog/catalog-price-history';
import type { ImportCatalogInput, ImportCatalogResult } from './application/catalog/import-catalog';
import type { listCatalogSources } from './application/catalog/list-catalog-sources';
import { createMemoryCatalogCache } from './ports/cache';
import {
  createPostgresAuditSink,
  postgresAuditStore,
  postgresAuditTxSink,
} from './adapters/postgres/audit';
import { postgresChannelStore } from './adapters/postgres/channel-store';
import { postgresFxStore } from './adapters/postgres/fx-store';
import { postgresSettingsStore } from './adapters/postgres/settings-store';
import { postgresIntegrationSettingsStore } from './adapters/postgres/integration-settings-store';
import { postgresModelStore } from './adapters/postgres/model-store';
import { postgresOperationsStore } from './adapters/postgres/operations-store';
import { postgresAdminStore } from './adapters/postgres/admin-store';
import { postgresProviderStore } from './adapters/postgres/provider-store';
import { postgresRateCardStore } from './adapters/postgres/rate-card-store';
import { createPostgresVoucherStorage } from './adapters/postgres/voucher-storage';
import {
  postgresRoleStore,
  postgresPermissionStore,
  postgresEndpointStore,
} from './adapters/postgres/rbac-store';
import { composeRbacSurface, type RbacSurface } from './application/rbac/compose';
import { composeAdminsSurface, type AdminsSurface } from './application/admins/compose';
import type { ResolvedStores, SectionDeps } from './sections/section-deps';
import { createProviderSection } from './sections/provider-section';
import { createChannelSection } from './sections/channel-section';
import { createModelSection } from './sections/model-section';
import { createRateCardSection } from './sections/rate-card-section';
import { createFxSection } from './sections/fx-section';
import { createSettingsSection } from './sections/settings-section';
import { createCatalogSection } from './sections/catalog-section';

/** 装配环境（全部必填注入；可选覆盖件有包内缺省实现） */
export interface ControlPlaneEnv {
  readonly db: Db;
  /** 渠道上游 Key 加解密（AES-256-GCM enc:v1；runtime.createCipher 结构兼容） */
  readonly cipher: SecretCipher;
  /** 可执行能力词表快照（ai 适配器注册表经 assembly 注入——本包不 import ai） */
  readonly capabilities: ProviderCapabilities;
  /** 上游探针（assembly 用 ai 库包装：每次新建实例——内存态隔离） */
  readonly probe: UpstreamProbe;
  /** 协议缺省（如 'openai-compatible'） */
  readonly defaultProtocol: string;
  /** 渠道批量导入单批上限 */
  readonly importMaxChannels: number;
  /** 目录源注册表（新增源 = 注册一个 CatalogSource 实现） */
  readonly sources: readonly CatalogSource[];
  /** 目录源货架缓存 TTL（ms） */
  readonly catalogTtlMs: number;
  /** 目录导入建渠道护栏：限流预填 */
  readonly catalogChannelRpm: number;
  /** 目录导入建渠道护栏：进货额度预填 */
  readonly catalogChannelBudget: string;
  /** 渠道进货凭证大小上限（字节） */
  readonly voucherMaxBytes: number;
  /** fx 拉取参数（源地址/TTL/超时/fetch 注入） */
  readonly fx: FxEnv;
  /** 审计出口（运营事件 best-effort；observability 桥可覆盖——降级清单见 ports/audit-sink.ts） */
  readonly audit?: AuditSink;
  /** 资金/安全类审计（事务参与 port；缺省 postgres 同事务写入） */
  readonly auditTx?: AuditTxSink;
  /** 凭证存储（缺省 postgres voucher_blobs；OSS 适配可覆盖） */
  readonly voucherStorage?: VoucherStorage;
  /** 目录缓存（缺省进程内存；共享缓存可覆盖） */
  readonly cache?: CatalogCache;
  /** store 覆盖缝（缺省 postgres 适配器；行为等价 stand-in / observability 桥可覆盖） */
  readonly stores?: {
    readonly provider?: ProviderStore;
    readonly channel?: ChannelStore;
    readonly model?: ModelStore;
    readonly rateCard?: RateCardStore;
    readonly fx?: FxStore;
    readonly settings?: SettingsStore;
    readonly integrationSettings?: IntegrationSettingsStore;
    readonly audit?: AuditStore;
    readonly operations?: OperationsStore;
    readonly admin?: AdminStore;
    readonly role?: RoleStore;
    readonly permission?: PermissionStore;
    readonly endpoint?: EndpointStore;
  };
}

export interface ControlPlane {
  readonly providers: {
    create(input: CreateProviderInput): Promise<ProviderRecord>;
    update(input: UpdateProviderInput): Promise<ProviderRecord>;
    /** 逻辑删除（回收站）：status→1 + deleted_at；行与渠道引用保留（禁用走 update status=1） */
    delete(input: DeleteProviderInput): Promise<{ ok: true }>;
    /** 恢复已删除记录：回禁用态（不直接启用） */
    undelete(input: UndeleteProviderInput): Promise<{ ok: true }>;
    list(query: {
      q?: string;
      sortBy: ProviderSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
      /** 缺省 active（在册）；deleted = 回收站 */
      view?: 'active' | 'deleted';
    }): Promise<ListResult<ProviderRecord>>;
  };
  readonly channels: {
    create(input: CreateChannelInput): Promise<CreatedChannel>;
    update(input: UpdateChannelInput): Promise<UpdatedChannel>;
    /** 逻辑删除（回收站）：status→1 + deleted_at；绑定/流水保留（停用走 update status=1）。
     *  下游守卫：在册映射绑定中 → channel_has_models */
    delete(input: DeleteChannelInput): Promise<{ ok: true }>;
    /** 恢复已删除记录：回停用态（不直接启用） */
    undelete(input: UndeleteChannelInput): Promise<{ ok: true }>;
    list(query: {
      q?: string;
      sortBy: ChannelSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
      /** 缺省 active（在册）；deleted = 回收站 */
      view?: 'active' | 'deleted';
    }): Promise<ListChannelsResult>;
    import(input: ImportChannelsInput): Promise<ImportChannelsResult>;
    probe(channelId: number): Promise<ProbeChannelResult>;
    recharge(input: RechargeChannelInput): Promise<{
      ok: true;
      rechargeId: number;
      balanceAfter: string;
      replayed: boolean;
    }>;
    adjust(input: AdjustChannelInput): Promise<{
      ok: true;
      rechargeId: number;
      balanceAfter: string;
      replayed: boolean;
    }>;
    listRecharges(input: ListRechargesInput): Promise<ListResult<RechargeRow>>;
    /** 进货凭证回读（admin-api 消费;键校验在 storage——防路径穿越） */
    loadVoucher(key: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  readonly models: {
    create(input: CreateModelInput): Promise<ModelRecord>;
    update(input: UpdateModelInput): Promise<ModelRecord>;
    /** 逻辑删除（回收站）：status→1 + deleted_at；记录与绑定保留可追溯（下架走 update status=1） */
    delete(input: DeleteModelInput): Promise<{ ok: true }>;
    /** 恢复已删除记录：回下架态（不直接复活上架） */
    undelete(input: UndeleteModelInput): Promise<{ ok: true }>;
    list(query: {
      q?: string;
      sortBy: ModelSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
      /** 缺省 active（在册）；deleted = 回收站 */
      view?: 'active' | 'deleted';
    }): Promise<ListModelsResult>;
    bindChannels(input: BindModelChannelsInput): Promise<{ bound: number }>;
    probe(mappingId: number): Promise<ProbeModelResult>;
  };
  readonly rates: {
    createCard(input: CreateRateCardInput): Promise<CreatedRateCard>;
    updateCard(input: UpdateRateCardInput): Promise<UpdatedRateCard>;
    deleteCard(input: DeleteRateCardInput): Promise<{ ok: true }>;
    listCards(query: {
      q?: string;
      sortBy: RateCardSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    }): Promise<ListResult<RateCardListItem>>;
    listCardUsers(
      input: ListRateCardUsersInput & {
        q?: string;
        sortBy: RateCardUserSortField;
        order: 'asc' | 'desc';
        limit: number;
        offset: number;
      },
    ): Promise<ListResult<RateCardUserRow>>;
    cardHealth(rateCardId: number): Promise<RateCardHealth>;
    /** 卡全局兜底系数读（admin-api set-password「缺则回填 1.000」消费） */
    findGlobalCoefficient(rateCardId: number): Promise<string | null>;
  };
  readonly fx: {
    state(): Promise<FxState>;
    refresh(input: RefreshFxInput): Promise<FxState>;
    setOverride(input: SetFxOverrideInput): Promise<FxState>;
    clearOverride(input: ClearFxOverrideInput): Promise<FxState>;
    setBuffer(input: SetFxBufferInput): Promise<FxState>;
  };
  /** 运营系统配置（system_configs KV）——admin settings 面 */
  readonly settings: {
    billingTimezone: {
      read(): Promise<{ timezone: string | null }>;
      update(input: UpdateBillingTimezoneInput): Promise<{ timezone: string }>;
    };
    /** 第三方集成动态配置（integration_settings） */
    integrations: {
      list(): Promise<{ integrations: readonly IntegrationListItem[] }>;
      update(input: UpdateIntegrationInput): Promise<IntegrationListItem>;
    };
  };
  readonly catalog: {
    listSources(): ReturnType<typeof listCatalogSources>;
    comparison(sourceId: string): Promise<CatalogComparisonPayload>;
    priceHistory(input: { externalName: string }): Promise<CatalogPriceHistoryEntry[]>;
    import(input: ImportCatalogInput): Promise<ImportCatalogResult>;
  };
  /** 动态 RBAC：动态角色 + 权限树管理面（装配见 application/rbac/compose） */
  readonly rbac: RbacSurface;
  /** 管理员资料面（装配见 application/admins/compose） */
  readonly admins: AdminsSurface;
}

/** 管理面 store 覆盖缝回退（实体 CRUD + 定价/汇率/系统配置/集成配置） */
function resolveManagementStores(
  env: ControlPlaneEnv,
): Pick<
  ResolvedStores,
  'provider' | 'channel' | 'model' | 'rateCard' | 'fx' | 'settings' | 'integrationSettings'
> {
  return {
    provider: env.stores?.provider ?? postgresProviderStore,
    channel: env.stores?.channel ?? postgresChannelStore,
    model: env.stores?.model ?? postgresModelStore,
    rateCard: env.stores?.rateCard ?? postgresRateCardStore,
    fx: env.stores?.fx ?? postgresFxStore,
    settings: env.stores?.settings ?? postgresSettingsStore,
    integrationSettings: env.stores?.integrationSettings ?? postgresIntegrationSettingsStore,
  };
}

/** 治理面 store 覆盖缝回退（审计/运营流水/管理员/RBAC） */
function resolveGovernanceStores(
  env: ControlPlaneEnv,
): Pick<ResolvedStores, 'audit' | 'operations' | 'admin' | 'role' | 'permission' | 'endpoint'> {
  return {
    audit: env.stores?.audit ?? postgresAuditStore,
    operations: env.stores?.operations ?? postgresOperationsStore,
    admin: env.stores?.admin ?? postgresAdminStore,
    role: env.stores?.role ?? postgresRoleStore,
    permission: env.stores?.permission ?? postgresPermissionStore,
    endpoint: env.stores?.endpoint ?? postgresEndpointStore,
  };
}

/** store 覆盖缝汇总：显式注入优先，逐项缺省回落 postgres 适配器（唯一装配真相在 facade） */
function resolveStores(env: ControlPlaneEnv): ResolvedStores {
  return {
    ...resolveManagementStores(env),
    ...resolveGovernanceStores(env),
  };
}

export function createControlPlane(env: ControlPlaneEnv): ControlPlane {
  const audit = env.audit ?? createPostgresAuditSink(env.db);
  const auditTx = env.auditTx ?? postgresAuditTxSink;
  const voucherStorage = env.voucherStorage ?? createPostgresVoucherStorage(env.db);
  const cache = env.cache ?? createMemoryCatalogCache();
  const stores = resolveStores(env);
  const fxDeps: FxDeps = { db: env.db, stores: { fx: stores.fx }, audit, env: env.fx };
  const settingsDeps = { db: env.db, stores: { settings: stores.settings }, audit };
  const integrationDeps = {
    db: env.db,
    stores: { integrationSettings: stores.integrationSettings },
    cipher: env.cipher,
    audit,
    auditTx,
    now: () => new Date(),
  };
  const sourceDeps = { sources: env.sources, cache, cacheTtlMs: env.catalogTtlMs };
  const deps: SectionDeps = {
    env,
    stores,
    audit,
    auditTx,
    voucherStorage,
    fxDeps,
    settingsDeps,
    integrationDeps,
    sourceDeps,
  };
  return {
    ...createProviderSection(deps),
    ...createChannelSection(deps),
    rbac: composeRbacSurface(env.db, {
      role: stores.role,
      permission: stores.permission,
      endpoint: stores.endpoint,
    }),
    admins: composeAdminsSurface(env.db, stores.admin),
    ...createModelSection(deps),
    ...createRateCardSection(deps),
    ...createFxSection(deps),
    ...createSettingsSection(deps),
    ...createCatalogSection(deps),
  };
}
