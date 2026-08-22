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
} from '../src/ports/channel-store';
import type { ModelStore, ModelRecord } from '../src/ports/model-store';
import type { RateCardStore, RateCardRecord } from '../src/ports/rate-card-store';
import type { FxStore } from '../src/ports/fx-store';
import type { OperationsStore } from '../src/ports/operations-store';
import type { AuditStore, AuditLogRow } from '../src/ports/audit-store';
import type { AuditSink, AuditEntry } from '../src/ports/audit-sink';
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

// ── providers ────────────────────────────────────────────────────────────────

export interface MemoryProviderStore {
  store: ProviderStore;
  rows: Map<number, ProviderRecord>;
}
export function createMemoryProviderStore(seed: ProviderRecord[] = []): MemoryProviderStore {
  const rows = new Map(seed.map((r) => [r.id, r]));
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const byName = (name: string) => [...rows.values()].find((r) => r.name === name) ?? null;
  const store: ProviderStore = {
    async insert(_db, input) {
      if (byName(input.name)) throw uniqueViolation('providers_name_uq');
      const row: ProviderRecord = { id: nextId++, createdAt: new Date(), ...input };
      rows.set(row.id, row);
      return row;
    },
    async findById(_db, id) {
      return rows.get(id) ?? null;
    },
    async findByName(_db, name) {
      return byName(name);
    },
    async update(_db, input: { providerId: number; patch: ProviderPatchInput }) {
      const row = rows.get(input.providerId);
      if (!row) return null;
      if (input.patch.name !== undefined) {
        const clash = byName(input.patch.name);
        if (clash && clash.id !== input.providerId) throw uniqueViolation('providers_name_uq');
      }
      const next = { ...row, ...input.patch };
      rows.set(input.providerId, next);
      return next;
    },
    async retire(_db, input) {
      const row = rows.get(input.providerId);
      if (!row) return false;
      rows.set(input.providerId, { ...row, status: 1 });
      return true;
    },
    async list(_db, query) {
      let all = [...rows.values()];
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
): MemoryChannelStore {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const recharges: MemoryRechargeRow[] = [];
  let nextRechargeId = 1;
  const byName = (name: string) => [...rows.values()].find((r) => r.name === name) ?? null;
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
      if (!row) return null;
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
      if (!row) return false;
      row.status = 1;
      return true;
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
      let all: ChannelListRow[] = [...rows.values()].map((row) => ({
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
  };
  return { store, rows, recharges };
}

// ── models ───────────────────────────────────────────────────────────────────

export interface MemoryModelRow extends ModelRecord {
  bindings: Array<{ channelId: number; weight: number; priority: number }>;
}

export interface MemoryModelStore {
  store: ModelStore;
  rows: Map<number, MemoryModelRow>;
}
export function createMemoryModelStore(seed: MemoryModelRow[] = []): MemoryModelStore {
  const rows = new Map(seed.map((r) => [r.id, { ...r, bindings: [...r.bindings] }]));
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const byExternal = (name: string) =>
    [...rows.values()].find((r) => r.externalName === name) ?? null;
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
        createdAt: new Date(0),
        updatedAt: new Date(0),
        bindings: [],
      };
      rows.set(row.id, row);
      return row;
    },
    async findById(_db, id) {
      const row = rows.get(id);
      return row ?? null;
    },
    async findByExternalName(_db, name) {
      return byExternal(name);
    },
    async updateMapping(_db, input: { mappingId: number; patch: ModelPatch }) {
      const row = rows.get(input.mappingId);
      if (!row) return null;
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
      if (!row) return false;
      row.status = 1;
      return true;
    },
    async listMappings(_db, query) {
      let all = [...rows.values()];
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
      return [...rows.values()].filter((r) => realModels.includes(r.realModel) && r.status === 0);
    },
    async listMappingRowsByChannelId(_db, channelId) {
      const out: Array<{ mappingId: number; externalName: string; realModel: string }> = [];
      for (const row of rows.values()) {
        if (row.bindings.some((b) => b.channelId === channelId)) {
          out.push({ mappingId: row.id, externalName: row.externalName, realModel: row.realModel });
        }
      }
      return out;
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
      return cards.get(id) ?? null;
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
  store: AuditStore;
  entries: AuditEntry[];
  /** 注入失败模式：置为 true 时 record 抛错（验证 best-effort 契约） */
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
  return { sink, store, entries, fail };
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
