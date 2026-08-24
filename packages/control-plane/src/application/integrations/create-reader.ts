/**
 * 消费侧 reader 工厂（DESIGN §5 D4/D9 细分）：整体快照 + 进程内 TTL 缓存 + 单飞刷新。
 * - resolve()：严格异步读（发送/资金面）——读失败 fail-loud，不静默降级到旧凭据；
 * - latest()：同步取最近快照（identity getter/capabilities 等 UX 面）——过期触发
 *   后台刷新（错误只经 onError 记日志，同步面不抛）；从未加载 = 全关快照。
 */
import { INTEGRATION_CACHE_TTL_MS } from '../../domain/integrations/keys';
import type { Db } from '@tillgate/db';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { IntegrationSettingsStore } from '../../ports/integration-settings-store';
import { resolveIntegrationSnapshot } from './resolve-snapshot';
import type { IntegrationSnapshot } from './snapshot-types';

export interface IntegrationReaderDeps {
  readonly db: Db;
  readonly stores: { readonly integrationSettings: IntegrationSettingsStore };
  readonly cipher: SecretCipher;
  /** 缓存 TTL（缺省 = 词表常量 60s——单一真相在 domain/keys） */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** 后台刷新失败钩子（latest() 面的错误出口——缺省丢弃） */
  readonly onError?: (error: unknown) => void;
}

export interface IntegrationSettingsReader {
  /** 当前快照（缓存命中 O(1)；过期后单飞重读，读失败向调用方抛错——fail-loud 面） */
  resolve(): Promise<IntegrationSnapshot>;
  /** 最近快照（同步契约：stale-OK；过期触发后台刷新；从未加载 = 全关快照——UX 面） */
  latest(): IntegrationSnapshot;
  /** 本进程缓存失效（写路径完成后调用；跨进程靠 TTL 收敛） */
  invalidate(): void;
}

export function createIntegrationSettingsReader(
  deps: IntegrationReaderDeps,
): IntegrationSettingsReader {
  const ttlMs = deps.ttlMs ?? INTEGRATION_CACHE_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  let cached: IntegrationSnapshot = allOffSnapshot(deps.cipher);
  // 初始与失效都置于负无穷：全关快照恒视为过期（首读必触发加载）
  let cachedAt = Number.NEGATIVE_INFINITY;
  /** resolve() 严格读的单飞占位（失败向等待方抛错——fail-loud 面） */
  let inflight: Promise<IntegrationSnapshot> | null = null;
  /** latest() 后台刷新占位（失败吞掉——与严格读互不串扰） */
  let background: Promise<void> | null = null;

  async function refresh(): Promise<IntegrationSnapshot> {
    const rows = await deps.stores.integrationSettings.readAll(deps.db);
    const snapshot = resolveIntegrationSnapshot({ cipher: deps.cipher, rows, nowMs: now() });
    cached = snapshot;
    cachedAt = now();
    return snapshot;
  }

  return {
    async resolve(): Promise<IntegrationSnapshot> {
      if (now() - cachedAt < ttlMs) return cached;
      if (inflight != null) return inflight;
      inflight = (async () => {
        try {
          return await refresh();
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    latest(): IntegrationSnapshot {
      if (now() - cachedAt >= ttlMs && inflight == null && background == null) {
        background = refreshInBackground(deps, refresh).finally(() => {
          background = null;
        });
      }
      return cached;
    },
    invalidate(): void {
      cachedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** 后台刷新（latest 同步面）：失败只经 onError 出口，不抛（DESIGN §5 D9 细分） */
async function refreshInBackground(
  deps: IntegrationReaderDeps,
  refresh: () => Promise<IntegrationSnapshot>,
): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    deps.onError?.(error);
  }
}

/** 全关快照（从未加载时的同步面缺省——词表外零行解析结果） */
function allOffSnapshot(cipher: SecretCipher): IntegrationSnapshot {
  return resolveIntegrationSnapshot({ cipher, rows: [], nowMs: 0 });
}
