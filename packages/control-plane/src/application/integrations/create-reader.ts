/**
 * 消费侧 reader 工厂（DESIGN §5 D4）：整体快照 + 进程内 TTL 缓存 + 单飞刷新。
 * 读失败 fail-loud（不静默降级到旧凭据）；写路径同进程可 invalidate 立即失效。
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
}

export interface IntegrationSettingsReader {
  /** 当前快照（缓存命中 O(1)；过期后单飞重读，读失败向调用方抛错） */
  resolve(): Promise<IntegrationSnapshot>;
  /** 本进程缓存失效（写路径完成后调用；跨进程靠 TTL 收敛） */
  invalidate(): void;
}

export function createIntegrationSettingsReader(
  deps: IntegrationReaderDeps,
): IntegrationSettingsReader {
  const ttlMs = deps.ttlMs ?? INTEGRATION_CACHE_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  let cached: IntegrationSnapshot | null = null;
  let cachedAt = 0;
  let inflight: Promise<IntegrationSnapshot> | null = null;

  async function refresh(): Promise<IntegrationSnapshot> {
    const rows = await deps.stores.integrationSettings.readAll(deps.db);
    const snapshot = resolveIntegrationSnapshot({ cipher: deps.cipher, rows, nowMs: now() });
    cached = snapshot;
    cachedAt = now();
    return snapshot;
  }

  return {
    async resolve(): Promise<IntegrationSnapshot> {
      if (cached != null && now() - cachedAt < ttlMs) return cached;
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
    invalidate(): void {
      cached = null;
    },
  };
}
