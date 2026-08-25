/**
 * 消费侧 reader 工厂（DESIGN §5 D4/D9 细分）：整体快照 + 进程内 TTL 缓存 + 单飞刷新。
 * - resolve()：严格异步读（发送/资金面）——读失败 fail-loud，不静默降级到旧凭据；
 * - refresh()：强制重读绕过 TTL（支付回调路由预刷缓存——消除轮换后 latest() 盲窗）；
 * - latest()：同步取最近快照（identity getter/capabilities 等 UX 面）——过期触发
 *   后台刷新（错误只经 onError 记日志，同步面不抛）；从未加载 = 全关快照。
 *
 * 缓存代次（review 修复 A-2）：invalidate() 递增 epoch——在飞读完成时若代次已变，
 * 结果不进缓存（旧快照不得把 cachedAt 刷成完成时刻）；严格读只复用同代在飞。
 */
import { INTEGRATION_CACHE_TTL_MS } from '../../domain/integrations/keys';
import type { Db } from '@tillgate/db';
import type { SecretCipher } from '../../ports/secret-cipher';
import type {
  IntegrationSettingsRow,
  IntegrationSettingsStore,
} from '../../ports/integration-settings-store';
import { resolveIntegrationSnapshot } from './resolve-snapshot';
import { specOf } from '../../domain/integrations/specs';
import type { IntegrationSnapshot } from './snapshot-types';

export interface IntegrationReaderDeps {
  readonly db: Db;
  readonly stores: { readonly integrationSettings: IntegrationSettingsStore };
  readonly cipher: SecretCipher;
  /** 缓存 TTL（缺省 = 词表常量 60s——单一真相在 domain/keys） */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** 观测出口（后台刷新失败 / secret 解密失败——缺省丢弃） */
  readonly onError?: (error: unknown) => void;
}

export interface IntegrationSettingsReader {
  /** 当前快照（缓存命中 O(1)；过期后单飞重读，读失败向调用方抛错——fail-loud 面） */
  resolve(): Promise<IntegrationSnapshot>;
  /** 强制重读（绕过 TTL；同代单飞合并——DESIGN D9 修订） */
  refresh(): Promise<IntegrationSnapshot>;
  /** 最近快照（同步契约：stale-OK；过期触发后台刷新；从未加载 = 全关快照——UX 面） */
  latest(): IntegrationSnapshot;
  /** 本进程缓存失效（写路径完成后调用——作废在飞读的缓存资格；跨进程靠 TTL 收敛） */
  invalidate(): void;
}

/** reader 可变缓存态（代次 + 双占位——module-level 助手的共享焦点） */
interface ReaderState {
  cached: IntegrationSnapshot;
  cachedAt: number;
  epoch: number;
  inflight: Promise<IntegrationSnapshot> | null;
  inflightEpoch: number;
  background: Promise<void> | null;
}

export function createIntegrationSettingsReader(
  deps: IntegrationReaderDeps,
): IntegrationSettingsReader {
  const ttlMs = deps.ttlMs ?? INTEGRATION_CACHE_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  // 初始与失效都置于负无穷：全关快照恒视为过期（首读必触发加载）
  const state: ReaderState = {
    cached: allOffSnapshot(deps.cipher),
    cachedAt: Number.NEGATIVE_INFINITY,
    epoch: 0,
    inflight: null,
    inflightEpoch: 0,
    background: null,
  };
  return {
    resolve: () =>
      now() - state.cachedAt < ttlMs ? Promise.resolve(state.cached) : strictRead(deps, state, now),
    refresh: () => strictRead(deps, state, now),
    latest: () => {
      if (now() - state.cachedAt >= ttlMs && state.inflight == null && state.background == null) {
        state.background = refreshInBackground(deps, () => readSnapshot(deps, state, now)).finally(
          () => {
            state.background = null;
          },
        );
      }
      return state.cached;
    },
    invalidate: () => {
      state.epoch += 1;
      state.cachedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** 严格读（同代单飞合并；失败向等待方抛错——fail-loud 面） */
function strictRead(
  deps: IntegrationReaderDeps,
  state: ReaderState,
  now: () => number,
): Promise<IntegrationSnapshot> {
  if (state.inflight != null && state.inflightEpoch === state.epoch) return state.inflight;
  state.inflight = (async () => {
    try {
      return await readSnapshot(deps, state, now);
    } finally {
      state.inflight = null;
    }
  })();
  state.inflightEpoch = state.epoch;
  return state.inflight;
}

/** 读 + 解密失败观测 + 同代缓存落位 */
async function readSnapshot(
  deps: IntegrationReaderDeps,
  state: ReaderState,
  now: () => number,
): Promise<IntegrationSnapshot> {
  const myEpoch = state.epoch;
  const rows = await deps.stores.integrationSettings.readAll(deps.db);
  // 解密失败观测（review 修复 M3）：密文损坏/双键不等的行不再静默 degrade——
  // 显式探测 secret 字段并按 <key>.<field> 上报（resolveSnapshot 自身仍 fail-safe）
  const failures = detectDecryptFailures(deps.cipher, rows);
  if (failures.length > 0) {
    deps.onError?.(new Error(`integration settings decrypt failures: ${failures.join(', ')}`));
  }
  const snapshot = resolveIntegrationSnapshot({ cipher: deps.cipher, rows, nowMs: now() });
  if (myEpoch === state.epoch) {
    state.cached = snapshot;
    state.cachedAt = now();
  }
  return snapshot;
}

/** 后台刷新（latest 同步面）：失败只经 onError 出口，不抛（DESIGN §5 D9 细分） */
async function refreshInBackground(
  deps: IntegrationReaderDeps,
  read: () => Promise<IntegrationSnapshot>,
): Promise<void> {
  try {
    await read();
  } catch (error) {
    deps.onError?.(error);
  }
}

/** secret 字段解密探测（≤7 行 × 少数字段——低 QPS 读路径可忽略） */
function detectDecryptFailures(
  cipher: SecretCipher,
  rows: readonly IntegrationSettingsRow[],
): string[] {
  const failures: string[] = [];
  for (const row of rows) {
    for (const field of specOf(row.key).fields) {
      if (!field.secret) continue;
      const value = row.config[field.name];
      if (typeof value !== 'string' || value.length === 0) continue;
      try {
        cipher.decrypt(value);
      } catch {
        failures.push(`${row.key}.${field.name}`);
      }
    }
  }
  return failures;
}

/** 全关快照（从未加载时的同步面缺省——词表外零行解析结果） */
function allOffSnapshot(cipher: SecretCipher): IntegrationSnapshot {
  return resolveIntegrationSnapshot({ cipher, rows: [], nowMs: 0 });
}
