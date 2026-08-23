/**
 * createControlPlane facade：唯一装配面（§5.3——app 只见 facade 与稳定契约）。
 * 内部组装 postgres 适配器族；装配级可覆盖件（审计出口/凭证存储/目录缓存）显式注入。
 * 返回面不泄漏 Db/DbTx/drizzle 行类型/供应商 SDK；分组用例按单元收敛。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink, AuditTxSink } from './ports/audit-sink';
import type { CatalogCache } from './ports/cache';
import type { CatalogSource } from './ports/catalog-source';
import type { SecretCipher } from './ports/secret-cipher';
import type { UpstreamProbe } from './ports/upstream-probe';
import type { VoucherStorage } from './ports/voucher-storage';
import type { ProviderCapabilities } from './domain/provider/provider';
import type { FxEnv } from './application/fx/fx-shared';
import { createMemoryCatalogCache } from './ports/cache';
import {
  createPostgresAuditSink,
  postgresAuditStore,
  postgresAuditTxSink,
} from './adapters/postgres/audit';
import { postgresChannelStore } from './adapters/postgres/channel-store';
import { postgresFxStore } from './adapters/postgres/fx-store';
import { postgresModelStore } from './adapters/postgres/model-store';
import { postgresOperationsStore } from './adapters/postgres/operations-store';
import { postgresAdminStore } from './adapters/postgres/admin-store';
import { postgresProviderStore } from './adapters/postgres/provider-store';
import { postgresRateCardStore } from './adapters/postgres/rate-card-store';
import { createPostgresVoucherStorage } from './adapters/postgres/voucher-storage';
import { createProvider, type CreateProviderInput } from './application/providers/create-provider';
import { updateProvider, type UpdateProviderInput } from './application/providers/update-provider';
import { retireProvider, type RetireProviderInput } from './application/providers/retire-provider';
import { listProviders } from './application/providers/list-providers';
import { createChannel, type CreateChannelInput } from './application/channels/create-channel';
import { updateChannel, type UpdateChannelInput } from './application/channels/update-channel';
import { retireChannel, type RetireChannelInput } from './application/channels/retire-channel';
import { listChannels, type ListChannelsResult } from './application/channels/list-channels';
import {
  importChannels,
  type ImportChannelsInput,
  type ImportChannelsResult,
} from './application/channels/import-channels';
import { probeChannel, type ProbeChannelResult } from './application/channels/probe-channel';
import {
  rechargeChannel,
  type RechargeChannelInput,
} from './application/channels/recharge-channel';
import { adjustChannel, type AdjustChannelInput } from './application/channels/adjust-channel';
import { listRecharges, type ListRechargesInput } from './application/channels/list-recharges';
import { findAdmin } from './application/admins/find-admin';
import { findAdminByEmail } from './application/admins/find-admin-by-email';
import { touchLastLogin } from './application/admins/touch-last-login';
import { setTwoFactorEnabled } from './application/admins/set-two-factor-enabled';
import type { AdminRecord } from './ports/admin-store';
import { createModel, type CreateModelInput } from './application/models/create-model';
import { updateModel, type UpdateModelInput } from './application/models/update-model';
import { retireModel, type RetireModelInput } from './application/models/retire-model';
import { listModels } from './application/models/list-models';
import {
  bindModelChannels,
  type BindModelChannelsInput,
} from './application/models/bind-model-channels';
import { probeModel, type ProbeModelResult } from './application/models/probe-model';
import { createRateCard, type CreateRateCardInput } from './application/rates/create-rate-card';
import { updateRateCard, type UpdateRateCardInput } from './application/rates/update-rate-card';
import { deleteRateCard, type DeleteRateCardInput } from './application/rates/delete-rate-card';
import { listRateCards } from './application/rates/list-rate-cards';
import {
  listRateCardUsers,
  type ListRateCardUsersInput,
} from './application/rates/list-rate-card-users';
import { checkRateCardHealth } from './application/rates/check-rate-card-health';
import type { FxState } from './domain/fx/fx-rates';
import { fxState } from './application/fx/fx-state';
import { refreshFx, type RefreshFxInput } from './application/fx/refresh-fx';
import { setFxOverride, type SetFxOverrideInput } from './application/fx/set-fx-override';
import { clearFxOverride, type ClearFxOverrideInput } from './application/fx/clear-fx-override';
import { setFxBuffer, type SetFxBufferInput } from './application/fx/set-fx-buffer';
import type { FxDeps } from './application/fx/fx-shared';
import { listCatalogSources } from './application/catalog/list-catalog-sources';
import {
  compareCatalogFromSource,
  type CatalogComparisonPayload,
} from './application/catalog/compare-catalog';
import { catalogPriceHistory } from './application/catalog/catalog-price-history';
import { importCatalog, type ImportCatalogInput } from './application/catalog/import-catalog';
import type { ChannelSortField, RechargeRow } from './ports/channel-store';
import type { ModelSortField, ModelRecord } from './ports/model-store';
import type { ListModelsResult } from './application/models/list-models';
import type { RateCardSortField, RateCardUserSortField } from './ports/rate-card-store';
import type { RateCardListItem } from './application/rates/list-rate-cards';
import type { ProviderRecord, ProviderSortField } from './ports/provider-store';
import type { ListResult } from './domain/list';
import type { CreatedRateCard } from './application/rates/create-rate-card';
import type { UpdatedRateCard } from './application/rates/update-rate-card';
import type { RateCardHealth } from './application/rates/check-rate-card-health';
import type { CatalogPriceHistoryEntry } from './application/catalog/catalog-price-history';
import type { ImportCatalogResult } from './application/catalog/import-catalog';
import type { CreatedChannel } from './application/channels/create-channel';
import type { UpdatedChannel } from './application/channels/update-channel';

/** 装配环境（全部必填注入——铁律 3；可选覆盖件有包内缺省实现） */
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
  /** 资金/安全类审计（事务参与 port，§5.4/G3；缺省 postgres 同事务写入） */
  readonly auditTx?: AuditTxSink;
  /** 凭证存储（缺省 postgres voucher_blobs；OSS 适配可覆盖） */
  readonly voucherStorage?: VoucherStorage;
  /** 目录缓存（缺省进程内存；共享缓存可覆盖） */
  readonly cache?: CatalogCache;
  /** store 覆盖缝（缺省 postgres 适配器；行为等价 stand-in / observability 桥可覆盖） */
  readonly stores?: {
    readonly provider?: import('./ports/provider-store').ProviderStore;
    readonly channel?: import('./ports/channel-store').ChannelStore;
    readonly model?: import('./ports/model-store').ModelStore;
    readonly rateCard?: import('./ports/rate-card-store').RateCardStore;
    readonly fx?: import('./ports/fx-store').FxStore;
    readonly audit?: import('./ports/audit-store').AuditStore;
    readonly operations?: import('./ports/operations-store').OperationsStore;
    readonly admin?: import('./ports/admin-store').AdminStore;
  };
}

export interface ControlPlane {
  readonly providers: {
    create(input: CreateProviderInput): Promise<ProviderRecord>;
    update(input: UpdateProviderInput): Promise<ProviderRecord>;
    retire(input: RetireProviderInput): Promise<{ ok: true }>;
    list(query: {
      q?: string;
      sortBy: ProviderSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    }): Promise<ListResult<ProviderRecord>>;
  };
  readonly channels: {
    create(input: CreateChannelInput): Promise<CreatedChannel>;
    update(input: UpdateChannelInput): Promise<UpdatedChannel>;
    retire(input: RetireChannelInput): Promise<{ ok: true }>;
    list(query: {
      q?: string;
      sortBy: ChannelSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
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
    /** 进货凭证回读（admin-api P5 消费;键校验在 storage——防路径穿越） */
    loadVoucher(key: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  readonly models: {
    create(input: CreateModelInput): Promise<ModelRecord>;
    update(input: UpdateModelInput): Promise<ModelRecord>;
    retire(input: RetireModelInput): Promise<{ ok: true }>;
    list(query: {
      q?: string;
      sortBy: ModelSortField;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
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
    ): Promise<ListResult<import('./ports/rate-card-store').RateCardUserRow>>;
    cardHealth(rateCardId: number): Promise<RateCardHealth>;
    /** 卡全局兜底系数读（admin-api D6 set-password「缺则回填 1.000」消费） */
    findGlobalCoefficient(rateCardId: number): Promise<string | null>;
  };
  readonly fx: {
    state(): Promise<FxState>;
    refresh(input: RefreshFxInput): Promise<FxState>;
    setOverride(input: SetFxOverrideInput): Promise<FxState>;
    clearOverride(input: ClearFxOverrideInput): Promise<FxState>;
    setBuffer(input: SetFxBufferInput): Promise<FxState>;
  };
  readonly catalog: {
    listSources(): ReturnType<typeof listCatalogSources>;
    comparison(sourceId: string): Promise<CatalogComparisonPayload>;
    priceHistory(input: { externalName: string }): Promise<CatalogPriceHistoryEntry[]>;
    import(input: ImportCatalogInput): Promise<ImportCatalogResult>;
  };
  /** 管理员资料与授权策略（G2,admin realm）——密码/挑战在 identity,此处只持资料事实 */
  readonly admins: {
    find(id: number): Promise<AdminRecord | null>;
    findByEmail(email: string): Promise<AdminRecord | null>;
    touchLastLogin(adminId: number): Promise<void>;
    setTwoFactorEnabled(input: { adminId: number; enabled: boolean }): Promise<void>;
  };
}

export function createControlPlane(env: ControlPlaneEnv): ControlPlane {
  const audit = env.audit ?? createPostgresAuditSink(env.db);
  const auditTx = env.auditTx ?? postgresAuditTxSink;
  const voucherStorage = env.voucherStorage ?? createPostgresVoucherStorage(env.db);
  const cache = env.cache ?? createMemoryCatalogCache();
  const stores = {
    provider: env.stores?.provider ?? postgresProviderStore,
    channel: env.stores?.channel ?? postgresChannelStore,
    model: env.stores?.model ?? postgresModelStore,
    rateCard: env.stores?.rateCard ?? postgresRateCardStore,
    fx: env.stores?.fx ?? postgresFxStore,
    audit: env.stores?.audit ?? postgresAuditStore,
    operations: env.stores?.operations ?? postgresOperationsStore,
    admin: env.stores?.admin ?? postgresAdminStore,
  } as const;
  const adminsDeps = { db: env.db, store: stores.admin };

  const fxDeps: FxDeps = { db: env.db, stores: { fx: stores.fx }, audit, env: env.fx };
  const sourceDeps = { sources: env.sources, cache, cacheTtlMs: env.catalogTtlMs };

  return {
    providers: {
      create: (input) =>
        createProvider(
          {
            db: env.db,
            stores: { provider: stores.provider },
            capabilities: env.capabilities,
            defaultProtocol: env.defaultProtocol,
            audit,
          },
          input,
        ),
      update: (input) =>
        updateProvider(
          {
            db: env.db,
            stores: { provider: stores.provider },
            capabilities: env.capabilities,
            audit,
          },
          input,
        ),
      retire: (input) =>
        retireProvider({ db: env.db, stores: { provider: stores.provider }, audit }, input),
      list: (query) => listProviders({ db: env.db, stores: { provider: stores.provider } }, query),
    },
    channels: {
      create: (input) =>
        createChannel(
          { db: env.db, stores: { channel: stores.channel }, cipher: env.cipher, audit },
          input,
        ),
      update: (input) =>
        updateChannel(
          { db: env.db, stores: { channel: stores.channel }, cipher: env.cipher, audit },
          input,
        ),
      retire: (input) =>
        retireChannel({ db: env.db, stores: { channel: stores.channel }, audit }, input),
      list: (query) => listChannels({ db: env.db, stores: { channel: stores.channel } }, query),
      import: (input) =>
        importChannels(
          {
            db: env.db,
            stores: { channel: stores.channel, provider: stores.provider, model: stores.model },
            cipher: env.cipher,
            importMax: env.importMaxChannels,
            audit,
          },
          input,
        ),
      probe: (channelId) =>
        probeChannel(
          { db: env.db, stores: { channel: stores.channel }, cipher: env.cipher, probe: env.probe },
          channelId,
        ),
      recharge: (input) =>
        rechargeChannel(
          {
            db: env.db,
            stores: { channel: stores.channel, operations: stores.operations },
            voucherStorage,
            voucherMaxBytes: env.voucherMaxBytes,
            auditTx,
          },
          input,
        ),
      adjust: (input) =>
        adjustChannel(
          {
            db: env.db,
            stores: { channel: stores.channel, operations: stores.operations },
            auditTx,
          },
          input,
        ),
      listRecharges: (input) =>
        listRecharges({ db: env.db, stores: { channel: stores.channel } }, input),
      loadVoucher: (key) => voucherStorage.load(key),
    },
    admins: {
      find: (id) => findAdmin(adminsDeps, id),
      findByEmail: (email) => findAdminByEmail(adminsDeps, email),
      touchLastLogin: (adminId) => touchLastLogin(adminsDeps, adminId),
      setTwoFactorEnabled: (input) => setTwoFactorEnabled(adminsDeps, input),
    },
    models: {
      create: (input) => createModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      update: (input) => updateModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      retire: (input) => retireModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      list: (query) => listModels({ db: env.db, stores: { model: stores.model } }, query),
      bindChannels: (input) =>
        bindModelChannels({ db: env.db, stores: { model: stores.model }, audit }, input),
      probe: (mappingId) =>
        probeModel(
          { db: env.db, stores: { model: stores.model }, cipher: env.cipher, probe: env.probe },
          mappingId,
        ),
    },
    rates: {
      createCard: (input) =>
        createRateCard({ db: env.db, stores: { rateCard: stores.rateCard }, audit }, input),
      updateCard: (input) =>
        updateRateCard({ db: env.db, stores: { rateCard: stores.rateCard }, auditTx }, input),
      deleteCard: (input) =>
        deleteRateCard({ db: env.db, stores: { rateCard: stores.rateCard }, audit }, input),
      listCards: (query) =>
        listRateCards({ db: env.db, stores: { rateCard: stores.rateCard } }, query),
      listCardUsers: (input) =>
        listRateCardUsers({ db: env.db, stores: { rateCard: stores.rateCard } }, input),
      cardHealth: (rateCardId) =>
        checkRateCardHealth({ db: env.db, stores: { rateCard: stores.rateCard } }, rateCardId),
      findGlobalCoefficient: (rateCardId) =>
        stores.rateCard.findGlobalCoefficient(env.db, rateCardId),
    },
    fx: {
      state: () => fxState(fxDeps),
      refresh: (input) => refreshFx(fxDeps, input),
      setOverride: (input) => setFxOverride(fxDeps, input),
      clearOverride: (input) => clearFxOverride(fxDeps, input),
      setBuffer: (input) => setFxBuffer(fxDeps, input),
    },
    catalog: {
      listSources: () => listCatalogSources(env.sources),
      comparison: (sourceId) =>
        compareCatalogFromSource(
          {
            ...sourceDeps,
            db: env.db,
            stores: { model: stores.model, channel: stores.channel },
            fx: fxDeps,
          },
          sourceId,
        ),
      priceHistory: (input) =>
        catalogPriceHistory({ db: env.db, stores: { audit: stores.audit } }, input),
      import: (input) =>
        importCatalog(
          {
            ...sourceDeps,
            db: env.db,
            stores: {
              provider: stores.provider,
              channel: stores.channel,
              model: stores.model,
            },
            cipher: env.cipher,
            channelRpm: env.catalogChannelRpm,
            channelBudget: env.catalogChannelBudget,
            fx: fxDeps,
            audit,
          },
          input,
        ),
    },
  };
}
