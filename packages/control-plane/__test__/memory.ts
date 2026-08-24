/**
 * 内存 store stand-in（§5.6 类型 2：PostgreSQL 的行为等价替身）——默认门禁专用。
 * 与 adapters/postgres 同契约实现；唯一约束以 23505 形状错误模拟
 * （isUniqueViolation 按 cause 链 code 判定——真实形状见 @tokenlens/db pg-error）。
 * 真实 SQL 行为等价由 postgres.real.test.ts 承担（默认门禁排除）。
 */
import type { Db, DbTx } from '@tokenlens/db';
import type { ProviderStore, ProviderRecord } from '../src/ports/provider-store';
import type {
  ChannelStore,
  ChannelListRow,
  ChannelFundsRow,
  ChannelProbeRow,
  RechargeRow,
  RouteCandidateRow,
} from '../src/ports/channel-store';
import type { ModelStore, ModelRecord, ActiveMappingRow } from '../src/ports/model-store';
import type { AdminStore, AdminRecord } from '../src/ports/admin-store';
import type { RateCardStore, RateCardRecord } from '../src/ports/rate-card-store';
import type { FxStore } from '../src/ports/fx-store';
import type { OperationsStore } from '../src/ports/operations-store';
import type { AuditStore, AuditLogRow } from '../src/ports/audit-store';
import type { AuditSink, AuditTxSink, AuditEntry } from '../src/ports/audit-sink';
import type { VoucherStorage } from '../src/ports/voucher-storage';
import type { UpstreamProbe, ProbeTarget, ProbeOutcome } from '../src/ports/upstream-probe';
import type { SecretCipher } from '../src/ports/secret-cipher';
import type { ProviderPatchInput } from '../src/domain/provider/provider';
import type { ModelInsertInput, ModelPatch } from '../src/ports/model-store';

/** PG 唯一冲突同形错误（cause 链 code 判定兼容） */
export function uniqueViolation(constraint: string): Error {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  (err as { code?: string }).code = '23505';
  (err as { constraint?: string }).constraint = constraint;
  return err;
}

/** db 事务替身：单事务直通（内存无并发语义；守卫/幂等行为由 store 自身模拟） */
export function createMemoryDb(): Db {
  return {
    async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      return fn({} as DbTx);
    },
  } as unknown as Db;
}

/**
 * 回滚语义 db 替身（§5.6 类型 2）：事务内抛错 → 快照恢复（内存替身的 PG ROLLBACK
 * 等价）。snapshot 在事务开启时取快照并返回恢复函数——用于「审计写失败 → 业务
 * 回滚」类边界断言（§5.4：写入失败必须回滚业务事务）。
 */
export function rollbackDb(snapshot: () => () => void): Db {
  return {
    async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      const restore = snapshot();
      try {
        return await fn({} as DbTx);
      } catch (error) {
        restore();
        throw error;
      }
    },
  } as unknown as Db;
}

/** Map 快照（值浅拷贝——行对象内字段变更也被恢复） */
export function snapshotMap<T>(map: Map<number, T>): { restore: () => void } {
  const copy = new Map([...map].map(([k, v]) => [k, { ...(v as object) }]) as [number, T][]);
  return {
    restore: () => {
      map.clear();
      for (const [k, v] of copy) map.set(k, v);
    },
  };
}

// ── providers ────────────────────────────────────────────────────────────────

export interface MemoryProviderStore {
  store: ProviderStore;
  rows: Map<number, ProviderRecord>;
}
export function createMemoryProviderStore(seed: ProviderRecord[] = []): MemoryProviderStore {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const byName = (name: string) =>
    [...rows.values()].find((r) => r.name === name && r.deletedAt == null) ?? null;
  const store: ProviderStore = {
    async insert(_db, input) {
      if (byName(input.name)) throw uniqueViolation('providers_name_uq');
      const row: ProviderRecord = {
        id: nextId++,
        deletedAt: null,
        createdAt: new Date(),
        ...input,
      };
      rows.set(row.id, row);
      return row;
    },
    async findById(_db, id) {
      const row = rows.get(id);
      return row && row.deletedAt == null ? row : null;
    },
    async findByName(_db, name) {
      return byName(name);
    },
    async update(_db, input: { providerId: number; patch: ProviderPatchInput }) {
      const row = rows.get(input.providerId);
      if (!row || row.deletedAt != null) return null;
      if (input.patch.name !== undefined) {
        const clash = byName(input.patch.name);
        if (clash && clash.id !== input.providerId) throw uniqueViolation('providers_name_uq');
      }
      Object.assign(row, input.patch);
      return row;
    },
    async retire(_db, input) {
      const row = rows.get(input.providerId);
      if (!row || row.deletedAt != null) return false;
      row.status = 1;
      return true;
    },
    async softDelete(_db, input) {
      const row = rows.get(input.providerId);
      if (!row || row.deletedAt != null) return false;
      row.status = 1;
      row.deletedAt = new Date();
      return true;
    },
    async restore(_db, input) {
      const row = rows.get(input.providerId);
      if (!row || row.deletedAt == null) return false;
      row.deletedAt = null;
      row.status = 1;
      return true;
    },
    async list(_db, query) {
      let all = [...rows.values()].filter((r) =>
        query.view === 'deleted' ? r.deletedAt != null : r.deletedAt == null,
      );
      if (query.q)
        all = all.filter((r) => r.name.includes(query.q!) || r.baseUrl.includes(query.q!));
      const sorted = all.toSorted((a, b) => {
        const key = query.sortBy as keyof ProviderRecord;
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        const cmp = av > bv ? 1 : av < bv ? -1 : 0;
        return (query.order === 'asc' ? cmp : -cmp) || b.id - a.id;
      });
      return {
        rows: sorted.slice(query.offset, query.offset + query.limit),
        total: all.length,
      };
    },
  };
  return { store, rows };
}

// ── channels ─────────────────────────────────────────────────────────────────

export interface MemoryChannelRow {
  id: number;
  providerId: number;
  name: string;
  apiKeyEnc: string;
  baseUrlOverride: string | null;
  models: string[] | null;
  weight: number;
  priority: number;
  status: number;
  failCount: number;
  cooldownUntil: Date | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  upstreamBudget: string;
  upstreamReserved: string;
  upstreamThreshold: string | null;
  /** 记录面逻辑删除时刻（回收站）；null = 在册 */
  deletedAt: Date | null;
}

export interface MemoryRechargeRow {
  id: number;
  channelId: number;
  type: 'recharge' | 'adjust';
  amount: string;
  balanceAfter: string;
  orderNo: string | null;
  voucher: string | null;
  remark: string | null;
  adminId: number;
}

export interface MemoryChannelStore {
  store: ChannelStore;
  rows: Map<number, MemoryChannelRow>;
  recharges: MemoryRechargeRow[];
}
export function createMemoryChannelStore(
  providerNameOf: (providerId: number) => string,
  seed: MemoryChannelRow[] = [],
  /** 列表富化注入：渠道 → 绑定外部名（无则空） */
  boundModels: Map<number, string[]> = new Map(),
  /** 列表富化注入：渠道 → 上游累计消耗（无则 '0'） */
  consumed: Map<number, string> = new Map(),
  /** 热路径读注入（G1）：providerId → 全量行（路由候选的协议/基址/厂商） */
  providersOf: Map<number, ProviderRecord> = new Map(),
): MemoryChannelStore {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const recharges: MemoryRechargeRow[] = [];
  let nextRechargeId = 1;
  const byName = (name: string) =>
    [...rows.values()].find((r) => r.name === name && r.deletedAt == null) ?? null;
  const store: ChannelStore = {
    async insertChannel(_db, input) {
      if (byName(input.name)) throw uniqueViolation('channels_name_uq');
      const row: MemoryChannelRow = {
        id: nextId++,
        providerId: input.providerId,
        name: input.name,
        apiKeyEnc: input.apiKeyEnc,
        baseUrlOverride: input.baseUrlOverride ?? null,
        models: input.models ?? null,
        weight: input.weight ?? 1,
        priority: input.priority ?? 0,
        status: input.status ?? 0,
        failCount: 0,
        cooldownUntil: null,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
        upstreamBudget: input.upstreamBudget ?? '0',
        upstreamReserved: '0',
        upstreamThreshold: null,
        deletedAt: null,
      };
      rows.set(row.id, row);
      return { id: row.id, name: row.name, providerId: row.providerId };
    },
    async findChannelByName(_db, name) {
      const row = byName(name);
      return row ? { id: row.id, rpmLimit: row.rpmLimit } : null;
    },
    async updateChannel(_db, input) {
      const row = rows.get(input.channelId);
      if (!row || row.deletedAt != null) return null;
      const { apiKeyEnc, status, failCount, cooldownUntil, upstreamThreshold, ...rest } =
        input.patch;
      Object.assign(row, rest);
      if (apiKeyEnc !== undefined) row.apiKeyEnc = apiKeyEnc;
      if (status !== undefined) row.status = status;
      if (failCount !== undefined) row.failCount = failCount;
      if (cooldownUntil !== undefined) row.cooldownUntil = cooldownUntil;
      if (upstreamThreshold !== undefined) row.upstreamThreshold = upstreamThreshold;
      return { id: row.id, name: row.name, status: row.status, failCount: row.failCount };
    },
    async retireChannel(_db, input) {
      const row = rows.get(input.channelId);
      if (!row || row.deletedAt != null) return false;
      row.status = 1;
      return true;
    },
    async softDeleteChannel(_db, input) {
      const row = rows.get(input.channelId);
      if (!row || row.deletedAt != null) return false;
      row.status = 1;
      row.deletedAt = new Date();
      return true;
    },
    async restoreChannel(_db, input) {
      const row = rows.get(input.channelId);
      if (!row || row.deletedAt == null) return false;
      row.deletedAt = null;
      row.status = 1;
      return true;
    },
    async countActiveByProvider(_db, providerId) {
      return [...rows.values()].filter((r) => r.providerId === providerId && r.deletedAt == null)
        .length;
    },
    async findChannelForProbe(_db, channelId): Promise<ChannelProbeRow | null> {
      const row = rows.get(channelId);
      if (!row) return null;
      return {
        channelId: row.id,
        channelName: row.name,
        apiKeyEnc: row.apiKeyEnc,
        baseUrlOverride: row.baseUrlOverride,
        providerBaseUrl: `https://provider.example.com/${row.providerId}`,
        providerProtocol: 'openai-compatible',
      };
    },
    async findChannelFunds(_db, channelId): Promise<ChannelFundsRow | null> {
      const row = rows.get(channelId);
      if (!row) return null;
      return {
        id: row.id,
        upstreamBudget: row.upstreamBudget,
        upstreamReserved: row.upstreamReserved,
        upstreamThreshold: row.upstreamThreshold,
        status: row.status,
      };
    },
    async listChannels(_db, query) {
      let all: ChannelListRow[] = [...rows.values()]
        .filter((r) => (query.view === 'deleted' ? r.deletedAt != null : r.deletedAt == null))
        .map((row) => ({
          id: row.id,
          name: row.name,
          providerId: row.providerId,
          providerName: providerNameOf(row.providerId),
          baseUrlOverride: row.baseUrlOverride,
          models: row.models,
          weight: row.weight,
          priority: row.priority,
          status: row.status,
          failCount: row.failCount,
          rpmLimit: row.rpmLimit,
          tpmLimit: row.tpmLimit,
          upstreamBudget: row.upstreamBudget,
          upstreamThreshold: row.upstreamThreshold,
          deletedAt: row.deletedAt,
          createdAt: new Date(0),
        }));
      if (query.q) {
        all = all.filter((r) => r.name.includes(query.q!) || r.providerName.includes(query.q!));
      }
      return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
    },
    async listBoundModelsByChannelIds(_db, channelIds) {
      const out: Array<{ channelId: number; externalName: string }> = [];
      for (const id of channelIds) {
        for (const name of boundModels.get(id) ?? [])
          out.push({ channelId: id, externalName: name });
      }
      return out;
    },
    async sumUpstreamConsumedByChannelIds(_db, channelIds) {
      return new Map(channelIds.map((id) => [id, consumed.get(id) ?? '0']));
    },
    async rechargeBudget(_db, input) {
      const row = rows.get(input.channelId);
      if (!row) throw new Error('channel.recharge_missed');
      row.upstreamBudget = String(Number(row.upstreamBudget) + Number(input.amount));
      if (row.status === 3) row.status = 0;
      return row.upstreamBudget;
    },
    async tryAdjustBudget(_db, input) {
      const row = rows.get(input.channelId);
      if (!row) return { ok: false as const };
      const next = Number(row.upstreamBudget) + Number(input.amount);
      if (next < 0) return { ok: false as const };
      row.upstreamBudget = String(next);
      return { ok: true as const, budget: row.upstreamBudget };
    },
    async insertRecharge(_db, values) {
      const row: MemoryRechargeRow = {
        id: nextRechargeId++,
        channelId: values.channelId,
        type: values.type,
        amount: values.amount,
        balanceAfter: values.balanceAfter,
        orderNo: values.orderNo ?? null,
        voucher: values.voucher ?? null,
        remark: values.remark ?? null,
        adminId: values.adminId,
      };
      recharges.push(row);
      return row.id;
    },
    async listRecharges(_db, query): Promise<{ rows: RechargeRow[]; total: number }> {
      let all: RechargeRow[] = recharges.map((r) => {
        const channel = rows.get(r.channelId);
        return {
          id: r.id,
          channelId: r.channelId,
          channelName: channel?.name ?? 'unknown',
          type: r.type,
          amount: r.amount,
          balanceAfter: r.balanceAfter,
          orderNo: r.orderNo,
          voucher: r.voucher,
          remark: r.remark,
          adminId: r.adminId,
          adminEmail: 'admin@example.com',
          adminDisplayName: 'Admin',
          createdAt: new Date(0),
        };
      });
      if (query.channelId !== undefined) all = all.filter((r) => r.channelId === query.channelId);
      if (query.type !== undefined) all = all.filter((r) => r.type === query.type);
      return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
    },

    // ---- 网关热路径读（G1）。stand-in 局限：内存行不持 model_channels 绑定表，
    // 不按 realModel 过滤（返回全部启用渠道）；过滤语义由 postgres.real 测试承担 ----
    async findRouteCandidates(_db, _realModel) {
      const out: RouteCandidateRow[] = [];
      for (const row of rows.values()) {
        if (row.status !== 0) continue;
        const provider = providersOf.get(row.providerId);
        // 已删除供应商的渠道不再路由（与 postgres 适配器同语义）
        if (provider != null && provider.deletedAt != null) continue;
        out.push({
          channelId: row.id,
          channelName: row.name,
          apiKeyEnc: row.apiKeyEnc,
          baseUrlOverride: row.baseUrlOverride,
          providerName: providerNameOf(row.providerId),
          providerBaseUrl: provider?.baseUrl ?? '',
          providerProtocol: provider?.protocol ?? '',
          providerVendor: provider?.vendor ?? null,
          priority: row.priority,
          weight: row.weight,
          rpmLimit: row.rpmLimit,
          tpmLimit: row.tpmLimit,
          upstreamBudget: row.upstreamBudget,
        });
      }
      return out;
    },

    async findTaskChannel(_db, channelId): Promise<RouteCandidateRow | null> {
      // by id 不按启用状态过滤（v1 语义：停用渠道的已提交任务仍须可轮询）
      const row = rows.get(channelId);
      if (row == null) return null;
      const provider = providersOf.get(row.providerId);
      return {
        channelId: row.id,
        channelName: row.name,
        apiKeyEnc: row.apiKeyEnc,
        baseUrlOverride: row.baseUrlOverride,
        providerName: providerNameOf(row.providerId),
        providerBaseUrl: provider?.baseUrl ?? '',
        providerProtocol: provider?.protocol ?? '',
        providerVendor: provider?.vendor ?? null,
        priority: row.priority,
        weight: row.weight,
        rpmLimit: row.rpmLimit,
        tpmLimit: row.tpmLimit,
        upstreamBudget: row.upstreamBudget,
      };
    },
  };
  return { store, rows, recharges };
}

// ── models ───────────────────────────────────────────────────────────────────

export interface MemoryModelRow extends ModelRecord {
  bindings: Array<{ channelId: number; weight: number; priority: number }>;
  /** 热路径读列（ModelRecord 管理面未含；postgres 行天然存在，内存行可选） */
  fallbackModels?: string[] | null;
  pricingGroup?: string | null;
}

export interface MemoryModelStore {
  store: ModelStore;
  rows: Map<number, MemoryModelRow>;
}
export function createMemoryModelStore(seed: MemoryModelRow[] = []): MemoryModelStore {
  const rows = new Map(seed.map((r) => [r.id, { ...r, bindings: [...r.bindings] }]));
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const byExternal = (name: string) =>
    [...rows.values()].find((r) => r.externalName === name && r.deletedAt == null) ?? null;
  const store: ModelStore = {
    async insertMapping(_db, input: ModelInsertInput) {
      if (byExternal(input.externalName)) throw uniqueViolation('model_mappings_external_name_uq');
      const row: MemoryModelRow = {
        id: nextId++,
        externalName: input.externalName,
        realModel: input.realModel,
        contextLength: input.contextLength ?? null,
        status: input.status ?? 0,
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cacheInputPrice: input.cacheInputPrice,
        cacheWritePrice: input.cacheWritePrice ?? '0',
        pricingUnit: input.pricingUnit ?? 'token',
        unitPrice: input.unitPrice ?? '0',
        billingConfig: input.billingConfig ?? {},
        isFree: input.isFree,
        billingPolicy: input.billingPolicy ?? null,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        bindings: [],
      };
      rows.set(row.id, row);
      return row;
    },
    async findById(_db, id) {
      const row = rows.get(id);
      return row && row.deletedAt == null ? row : null;
    },
    async findByExternalName(_db, name) {
      return byExternal(name);
    },
    async updateMapping(_db, input: { mappingId: number; patch: ModelPatch }) {
      const row = rows.get(input.mappingId);
      if (!row || row.deletedAt != null) return null;
      if (input.patch.externalName !== undefined) {
        const clash = byExternal(input.patch.externalName);
        if (clash && clash.id !== input.mappingId)
          throw uniqueViolation('model_mappings_external_name_uq');
      }
      Object.assign(row, input.patch, { updatedAt: new Date() });
      return row;
    },
    async retireMapping(_db, input) {
      const row = rows.get(input.mappingId);
      if (!row || row.deletedAt != null) return false;
      row.status = 1;
      return true;
    },
    async softDeleteMapping(_db, input) {
      const row = rows.get(input.mappingId);
      if (!row || row.deletedAt != null) return false;
      row.status = 1;
      row.deletedAt = new Date();
      return true;
    },
    async restoreMapping(_db, input) {
      const row = rows.get(input.mappingId);
      if (!row || row.deletedAt == null) return false;
      row.deletedAt = null;
      row.status = 1;
      return true;
    },
    async listMappings(_db, query) {
      let all = [...rows.values()].filter((r) =>
        query.view === 'deleted' ? r.deletedAt != null : r.deletedAt == null,
      );
      if (query.q) {
        all = all.filter(
          (r) => r.externalName.includes(query.q!) || r.realModel.includes(query.q!),
        );
      }
      return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
    },
    async replaceModelChannels(_db, input) {
      const row = rows.get(input.mappingId);
      if (row) row.bindings = [...input.channels];
      return input.channels.length;
    },
    async listChannelIdsByMappingIds(_db, mappingIds) {
      const out: Array<{ mappingId: number; channelId: number }> = [];
      for (const row of rows.values()) {
        if (mappingIds.includes(row.id)) {
          for (const b of row.bindings) out.push({ mappingId: row.id, channelId: b.channelId });
        }
      }
      return out;
    },
    async listBoundChannelsForProbe(_db, mappingId) {
      const row = rows.get(mappingId);
      if (!row) return [];
      return row.bindings.map((b) => ({
        channelId: b.channelId,
        channelName: `channel-${b.channelId}`,
        apiKeyEnc: `enc-for-${b.channelId}`,
        baseUrlOverride: null,
        providerBaseUrl: 'https://provider.example.com/v1',
        providerProtocol: 'openai-compatible',
      }));
    },
    async ensureModelChannelBinding(_db, input) {
      const row = rows.get(input.mappingId);
      if (row && !row.bindings.some((b) => b.channelId === input.channelId)) {
        row.bindings.push({ channelId: input.channelId, weight: 1, priority: 0 });
      }
    },
    async listEnabledByRealModels(_db, realModels) {
      return [...rows.values()].filter(
        (r) => realModels.includes(r.realModel) && r.status === 0 && r.deletedAt == null,
      );
    },
    async listMappingRowsByChannelId(_db, channelId) {
      const out: Array<{ mappingId: number; externalName: string; realModel: string }> = [];
      for (const row of rows.values()) {
        if (row.deletedAt != null) continue;
        if (row.bindings.some((b) => b.channelId === channelId)) {
          out.push({ mappingId: row.id, externalName: row.externalName, realModel: row.realModel });
        }
      }
      return out;
    },
    async countActiveMappingsByChannel(_db, channelId) {
      // 绑定守卫计数：仅算在册映射（已删除映射的残留绑定不算下游占用）
      return [...rows.values()].filter(
        (r) => r.deletedAt == null && r.bindings.some((b) => b.channelId === channelId),
      ).length;
    },

    // ---- 网关热路径读（G1） ----
    async findActiveByExternalName(_db, externalName) {
      const row = byExternal(externalName);
      return row && row.status === 0 ? toActiveRow(row) : null;
    },
    async findActiveByExternalNames(_db, externalNames) {
      const out = new Map<string, ActiveMappingRow>();
      for (const name of externalNames) {
        const row = byExternal(name);
        if (row && row.status === 0) out.set(name, toActiveRow(row));
      }
      return out;
    },
    async listEnabledMappings(_db) {
      return [...rows.values()]
        .filter((r) => r.status === 0 && r.deletedAt == null)
        .map((r) => ({
          externalName: r.externalName,
          realModel: r.realModel,
          pricingUnit: r.pricingUnit,
        }))
        .toSorted((a, b) => a.externalName.localeCompare(b.externalName));
    },
  };
  return { store, rows };
}

// ── rate cards ───────────────────────────────────────────────────────────────

export interface MemoryRateCardStore {
  store: RateCardStore;
  cards: Map<number, RateCardRecord>;
  coefficients: Array<{
    rateCardId: number;
    scope: string;
    modelMappingId: number | null;
    groupKey: string | null;
    coefficient: string;
  }>;
  /** 测试注入：各卡绑定用户数 */
  boundUsers: Map<number, number>;
}
export function createMemoryRateCardStore(): MemoryRateCardStore {
  const cards = new Map<number, RateCardRecord>();
  const coefficients: MemoryRateCardStore['coefficients'] = [];
  const boundUsers = new Map<number, number>();
  let nextId = 1;
  const store: RateCardStore = {
    async insertWithGlobal(_db, input) {
      const card: RateCardRecord = {
        id: nextId++,
        name: input.name,
        description: input.description,
        status: 0,
        createdAt: new Date(0),
      };
      cards.set(card.id, card);
      coefficients.push({
        rateCardId: card.id,
        scope: 'global',
        modelMappingId: null,
        groupKey: null,
        coefficient: input.coefficient,
      });
      return card;
    },
    async findById(_db, id) {
      // PG SELECT 语义：返回行的独立快照（调用方持有引用不随后续 UPDATE 漂移）
      const row = cards.get(id);
      return row == null ? null : { ...row };
    },
    async updateWithGlobal(_db, input) {
      const card = cards.get(input.rateCardId);
      if (!card) return null;
      Object.assign(card, input.patch);
      if (input.globalCoefficient !== undefined) {
        for (const c of coefficients) {
          if (c.rateCardId === input.rateCardId && c.scope === 'global')
            c.coefficient = input.globalCoefficient;
        }
      }
      return { id: card.id, name: card.name };
    },
    async countBoundUsers(_db, rateCardId) {
      return boundUsers.get(rateCardId) ?? 0;
    },
    async deleteCard(_db, input) {
      const had = cards.delete(input.rateCardId);
      for (let i = coefficients.length - 1; i >= 0; i -= 1) {
        if (coefficients[i]!.rateCardId === input.rateCardId) coefficients.splice(i, 1);
      }
      return had;
    },
    async list(_db, query) {
      let all = [...cards.values()];
      if (query.q) all = all.filter((c) => c.name.includes(query.q!));
      const withCoef = all.map((c) => ({
        ...c,
        globalCoefficient:
          coefficients.find((x) => x.rateCardId === c.id && x.scope === 'global')?.coefficient ??
          null,
      }));
      return { rows: withCoef.slice(query.offset, query.offset + query.limit), total: all.length };
    },
    async listCardUsers(_db, query) {
      const count = boundUsers.get(query.rateCardId) ?? 0;
      return {
        rows: Array.from({ length: count }, (_, i) => ({
          id: i + 1,
          subject: `user-${i + 1}`,
          email: null,
          displayName: null,
          createdAt: new Date(0),
        })),
        total: count,
      };
    },
    async findGlobalCoefficient(_db, rateCardId) {
      return (
        coefficients.find((x) => x.rateCardId === rateCardId && x.scope === 'global')
          ?.coefficient ?? null
      );
    },

    // ---- 网关热路径读（G1） ----
    async findActiveCardByUser(_db, userId) {
      const cardId = boundUsers.get(userId);
      if (cardId == null) return null;
      const card = cards.get(cardId);
      if (!card) return null;
      return {
        cardId: card.id,
        cardName: card.name,
        status: card.status,
        coefficients: coefficients
          .filter((c) => c.rateCardId === card.id)
          .map((c) => ({
            scope: c.scope as 'model' | 'group' | 'global',
            modelMappingId: c.modelMappingId ?? null,
            groupKey: c.groupKey ?? null,
            coefficient: c.coefficient,
          })),
      };
    },
  };
  return { store, cards, coefficients, boundUsers };
}

// ── fx ───────────────────────────────────────────────────────────────────────

export interface MemoryFxStore {
  store: FxStore;
  rates: Array<{
    id: number;
    rate: string;
    source: string;
    mode: 'auto' | 'override';
    operatorAdminId: number | null;
  }>;
  config: Record<string, unknown> | null;
}
export function createMemoryFxStore(): MemoryFxStore {
  const rates: MemoryFxStore['rates'] = [];
  let nextId = 1;
  const state: MemoryFxStore = {
    rates,
    config: null,
    store: {
      async current() {
        const override = [...rates].toReversed().find((r) => r.mode === 'override');
        const config = (state.config ?? {}) as { mode?: string };
        if (config.mode === 'override' && override) {
          return {
            rate: override.rate,
            fxRateId: override.id,
            source: 'manual',
            fetchedAt: '2026-01-01T00:00:00.000Z',
          };
        }
        const auto = [...rates].toReversed().find((r) => r.mode === 'auto');
        if (!auto) return null;
        return {
          rate: auto.rate,
          fxRateId: auto.id,
          source: auto.source,
          fetchedAt: '2026-01-01T00:00:00.000Z',
        };
      },
      async insertRate(_db, input) {
        const row = { id: nextId++, operatorAdminId: input.operatorAdminId ?? null, ...input };
        rates.push(row);
        return { id: row.id };
      },
      async readConfig() {
        return state.config;
      },
      async upsertConfig(_db, input) {
        state.config = input.value;
      },
    },
  };
  return state;
}

// ── operations / audit / voucher / probe / cipher ────────────────────────────

export interface MemoryOperationsStore {
  store: OperationsStore;
  rows: Map<string, { id: number; kind: string; fingerprint: string; receipt: unknown }>;
}
export function createMemoryOperationsStore(): MemoryOperationsStore {
  const rows = new Map<
    string,
    { id: number; kind: string; fingerprint: string; receipt: unknown }
  >();
  let nextId = 1;
  const store: OperationsStore = {
    async insertPlaceholder(_tx, input) {
      if (rows.has(input.operationId)) return null;
      const row = { id: nextId++, ...input, receipt: null };
      rows.set(input.operationId, row);
      return row.id;
    },
    async findByOperationId(_tx, operationId) {
      return rows.get(operationId) ?? null;
    },
    async saveReceipt(_tx, id, receipt) {
      for (const row of rows.values()) {
        if (row.id === id) row.receipt = receipt;
      }
    },
  };
  return { store, rows };
}

export interface MemoryAudit {
  sink: AuditSink;
  txSink: AuditTxSink;
  store: AuditStore;
  entries: AuditEntry[];
  /** 注入失败模式：置为 true 时 record/recordWithinTx 抛错（best-effort / 事务回滚两契约各验） */
  fail: { on: boolean };
}
export function createMemoryAudit(): MemoryAudit {
  const entries: AuditEntry[] = [];
  const fail = { on: false };
  const sink: AuditSink = {
    async record(entry) {
      if (fail.on) throw new Error('audit sink down');
      entries.push(entry);
    },
  };
  /** 事务参与替身：同一 entries 落档（回滚语义由 db 事务替身/真实 PG 测试承担） */
  const txSink: AuditTxSink = {
    async recordWithinTx(_db, entry) {
      if (fail.on) throw new Error('audit sink down');
      entries.push(entry);
    },
  };
  const store: AuditStore = {
    async listCatalogPriceHistory(_db, input): Promise<readonly AuditLogRow[]> {
      return entries
        .filter(
          (e) =>
            (e.action === 'model_catalog.import' || e.action === 'model_catalog.import_draft') &&
            Array.isArray(
              (e.detail as { models?: Array<{ externalName: string }> } | null)?.models,
            ) &&
            ((e.detail as { models: Array<{ externalName: string }> }).models ?? []).some(
              (m) => m.externalName === input.externalName,
            ),
        )
        .map((e, i) => ({
          id: entries.length - i,
          adminId: e.adminId ?? null,
          actor: e.actor,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId == null ? null : String(e.targetId),
          detail: e.detail ?? null,
          createdAt: new Date(0),
        }));
    },
  };
  return { sink, txSink, store, entries, fail };
}

export function createMemoryVoucherStorage(): VoucherStorage & {
  saved: Map<string, { data: Uint8Array; mimeType: string }>;
} {
  const saved = new Map<string, { data: Uint8Array; mimeType: string }>();
  let n = 0;
  return {
    saved,
    async save(data, mimeType) {
      const key = `key-${(n += 1)}`;
      saved.set(key, { data, mimeType });
      return key;
    },
    async load(key) {
      return saved.get(key) ?? null;
    },
  };
}

/** 探针替身：记录目标并按配置回放结果（默认成功） */
export function createStubProbe(overrides?: {
  channel?: (target: ProbeTarget) => ProbeOutcome;
  model?: (
    target: ProbeTarget,
    model: string,
    ctx: { requestId: string },
  ) => ProbeOutcome & { tokens?: number };
}) {
  const calls: Array<{
    kind: 'channel' | 'model';
    target: ProbeTarget;
    model?: string;
    requestId?: string;
  }> = [];
  const probe: UpstreamProbe = {
    async probeChannel(target) {
      calls.push({ kind: 'channel', target });
      return overrides?.channel?.(target) ?? { ok: true, durationMs: 3 };
    },
    async probeModel(target, model, ctx) {
      calls.push({ kind: 'model', target, model, requestId: ctx.requestId });
      return overrides?.model?.(target, model, ctx) ?? { ok: true, durationMs: 5, tokens: 3 };
    },
  };
  return { probe, calls };
}

/** 密码替身：前缀标记的对称编码（真实 AES-GCM 归 @tokenlens/runtime 已覆盖） */
export const fakeCipher: SecretCipher = {
  encrypt: (plaintext) => `fake-enc:${plaintext}`,
  decrypt: (packed) => packed.replace(/^fake-enc:/, ''),
};

/** 上下文工厂：管理员操作 */
export function adminCtx(adminId = 1) {
  return {
    requestId: `req-${adminId}-${Math.random().toString(36).slice(2, 8)}`,
    actor: { kind: 'admin' as const, id: adminId },
  };
}

/** MemoryModelRow → 热路径读行（补齐管理面行缺的两列） */
function toActiveRow(row: MemoryModelRow): ActiveMappingRow {
  return {
    id: row.id,
    externalName: row.externalName,
    realModel: row.realModel,
    contextLength: row.contextLength,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    cacheInputPrice: row.cacheInputPrice,
    cacheWritePrice: row.cacheWritePrice,
    pricingUnit: row.pricingUnit,
    unitPrice: row.unitPrice,
    pricingGroup: row.pricingGroup ?? null,
    isFree: row.isFree,
    fallbackModels: row.fallbackModels ?? null,
    billingPolicy: row.billingPolicy,
    billingConfig: row.billingConfig,
  };
}

/** 管理员资料 store 替身（G2）——投影不含密码列（与 postgres adapter 同口径） */
export function createMemoryAdminStore(
  seed: AdminRecord[] = [],
  roleCodes: Map<number, string> = new Map(),
  grantsByRole: Map<number, { isSuper: boolean; codes: string[] }> = new Map(),
): AdminStore & {
  rows: Map<number, AdminRecord>;
} {
  const rows = new Map<number, AdminRecord>(seed.map((r) => [r.id, r]));
  let clock = 0;
  return {
    rows,
    async findById(_db, id) {
      return rows.get(id) ?? null;
    },
    async findByEmail(_db, email) {
      return [...rows.values()].find((r) => r.email === email) ?? null;
    },
    async findAccess(_db, adminId) {
      const row = rows.get(adminId);
      if (row == null) return null;
      const grants = grantsByRole.get(row.roleId);
      const resolved =
        grants == null
          ? { isSuper: false, codes: [] }
          : grants.isSuper
            ? { isSuper: true, codes: [] }
            : { isSuper: false, codes: grants.codes };
      return { status: row.status, grants: resolved };
    },

    async touchLastLogin(_db, id) {
      const row = rows.get(id);
      if (row == null) return;
      clock += 1;
      rows.set(id, { ...row, lastLoginAt: new Date(clock) });
    },
    async setTwoFactorEnabled(_db, input) {
      const row = rows.get(input.adminId);
      if (row == null) return;
      rows.set(input.adminId, { ...row, twoFactorEnabled: input.enabled });
    },
    async list(_db, query) {
      const matched = [...rows.values()].filter((r) => {
        if (query.q == null || query.q === '') return true;
        const needle = query.q.toLowerCase();
        return (
          r.email.toLowerCase().includes(needle) ||
          (r.displayName ?? '').toLowerCase().includes(needle)
        );
      });
      const sorted = matched.toSorted((a, b) => {
        const key = (r: AdminRecord) =>
          query.sortBy === 'email'
            ? r.email
            : query.sortBy === 'lastLoginAt'
              ? (r.lastLoginAt?.getTime() ?? 0)
              : query.sortBy === 'createdAt'
                ? r.createdAt.getTime()
                : r.id;
        const av = key(a);
        const bv = key(b);
        const cmp =
          typeof av === 'string' ? av.localeCompare(bv as string) : Number(av) - Number(bv);
        return query.order === 'desc' ? -cmp : cmp;
      });
      return {
        rows: sorted.slice(query.offset, query.offset + query.limit),
        total: matched.length,
      };
    },
    async create(_db, row) {
      clock += 1;
      if ([...rows.values()].some((r) => r.email === row.email)) {
        const error = new Error('duplicate key') as Error & { code: string };
        error.code = '23505';
        throw error;
      }
      // 与 postgres adapter 同语义:id ≥1e9 段分配（identity_passwords 扁平主键防串号）
      const maxId = [...rows.keys()].reduce((max, id) => Math.max(max, id), 0);
      const record: AdminRecord = {
        id: Math.max(1_000_000_000, maxId + 1),
        ...row,
        role: roleCodes.get(row.roleId) ?? 'custom',
        status: 0,
        twoFactorEnabled: false,
        lastLoginAt: null,
        createdAt: new Date(clock),
      };
      rows.set(record.id, record);
      return record;
    },
    async update(_db, input) {
      const row = rows.get(input.adminId);
      if (row == null) return null;
      const roleId = input.roleId ?? row.roleId;
      const next: AdminRecord = {
        ...row,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.roleId !== undefined ? { roleId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        role: roleCodes.get(roleId) ?? row.role,
      };
      rows.set(input.adminId, next);
      return next;
    },
    async remove(_db, adminId) {
      rows.delete(adminId);
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 动态 RBAC 替身（roles/permissions;SQL 行为等价由 postgres.real 承担）
// ══════════════════════════════════════════════════════════════════════════

export function createMemoryRoleStore(seed: import('../src/ports/rbac-store').RoleRecord[] = []) {
  const rolesById = new Map(seed.map((r) => [r.id, r]));
  const grantsByRole = new Map<number, string[]>();
  const adminCounts = new Map<number, number>();
  let nextId = seed.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  const store: import('../src/ports/rbac-store').RoleStore = {
    async list(_db, query) {
      const matched = [...rolesById.values()].filter(
        (r) => query.q == null || query.q === '' || r.name.includes(query.q!),
      );
      return {
        rows: matched.map((r) => ({
          ...r,
          adminCount: adminCounts.get(r.id) ?? 0,
          codes: grantsByRole.get(r.id) ?? [],
        })),
        total: matched.length,
      };
    },
    async findById(_db, id) {
      return rolesById.get(id) ?? null;
    },
    async findByCode(_db, code) {
      return [...rolesById.values()].find((r) => r.code === code) ?? null;
    },
    async create(_db, row) {
      const record = {
        id: nextId++,
        code: row.code,
        name: row.name,
        description: row.description,
        status: 0,
        isSuper: false,
        isBuiltin: false,
        createdAt: new Date(0),
      };
      rolesById.set(record.id, record);
      grantsByRole.set(record.id, [...row.codes]);
      return record;
    },
    async update(_db, input) {
      const current = rolesById.get(input.roleId);
      if (current == null) return null;
      const next = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };
      rolesById.set(input.roleId, next);
      return next;
    },
    async remove(_db, roleId) {
      rolesById.delete(roleId);
      grantsByRole.delete(roleId);
    },
    async codesOf(_db, roleId) {
      return grantsByRole.get(roleId) ?? [];
    },
    async replaceCodes(_db, roleId, codes) {
      grantsByRole.set(roleId, [...codes]);
    },
    async adminCount(_db, roleId) {
      return adminCounts.get(roleId) ?? 0;
    },
  };
  return Object.assign(store, {
    rolesById,
    grantsByRole,
    setAdminCount(roleId: number, count: number) {
      adminCounts.set(roleId, count);
    },
  });
}

export function createMemoryPermissionStore(
  seed: import('../src/ports/rbac-store').PermissionNode[] = [],
) {
  const nodes = new Map(seed.map((n) => [n.id, n]));
  const bindings = new Map<number, number>(); // nodeId → 绑定角色数
  let nextId = seed.reduce((max, n) => Math.max(max, n.id), 0) + 1;
  const store: import('../src/ports/rbac-store').PermissionStore = {
    async list(_db) {
      return [...nodes.values()].toSorted((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    },
    async findById(_db, id) {
      return nodes.get(id) ?? null;
    },
    async codeTaken(_db, code) {
      return [...nodes.values()].some((n) => n.code === code);
    },
    async create(_db, row) {
      const node = {
        id: nextId++,
        parentId: row.parentId,
        type: row.type,
        code: row.code,
        name: row.name,
        i18nKey: row.i18nKey,
        description: row.description,
        path: row.path,
        icon: row.icon,
        sortOrder: row.sortOrder,
        status: 0,
        source: 'custom' as const,
        createdAt: new Date(0),
      };
      nodes.set(node.id, node);
      return node;
    },
    async update(_db, input) {
      const current = nodes.get(input.id);
      if (current == null) return null;
      const next = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.i18nKey !== undefined ? { i18nKey: input.i18nKey } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };
      nodes.set(input.id, next);
      return next;
    },
    async remove(_db, id) {
      nodes.delete(id);
    },
    async childCount(_db, id) {
      return [...nodes.values()].filter((n) => n.parentId === id).length;
    },
    async bindingCount(_db, id) {
      return bindings.get(id) ?? 0;
    },
    async activeCodes(_db) {
      return [...nodes.values()]
        .filter((n) => n.status === 0 && n.code != null)
        .map((n) => n.code as string);
    },
  };
  return Object.assign(store, {
    nodes,
    setBinding(nodeId: number, count: number) {
      bindings.set(nodeId, count);
    },
  });
}
