/**
 * fx 单元共享内部：配置读写、生效态计算、ECB 拉取与懒刷新。
 * 真相在 fx_rates 追加表与审计；system_configs 只是缓存视图。
 * 写路径唯一入口 = 本单元五个用例（state/refresh/setOverride/clearOverride/setBuffer）。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { FxStore } from '../../ports/fx-store';
import {
  applyBuffer,
  EMPTY_FX_CONFIG,
  normalizeRate,
  type FxConfig,
  type FxState,
} from '../../domain/fx/fx-rates';
import { controlPlaneErrors } from '../../errors';

/** 可注入 fetch(bun 类型加宽了全局 fetch——注入面收窄为可调用视图) */
export type FetchLike = (...args: Parameters<typeof fetch>) => Promise<Response>;

export interface FxEnv {
  /** ECB/frankfurter 拉取地址（无 key 公共源） */
  readonly sourceUrl: string;
  /** auto 行拉取节奏（ECB 每工作日一发，4h 懒检查足够新鲜） */
  readonly autoTtlMs: number;
  readonly fetchTimeoutMs: number;
  /** fetch 可注入（测试不打真 ECB） */
  readonly fetch?: FetchLike;
  /** 时钟（测试注入；缺省真实时钟） */
  readonly now?: () => Date;
}

export interface FxDeps {
  readonly db: Db;
  readonly stores: { readonly fx: FxStore };
  readonly audit: AuditSink;
  readonly env: FxEnv;
}

export async function readConfig(deps: FxDeps): Promise<FxConfig> {
  const row = await deps.stores.fx.readConfig(deps.db);
  return { ...EMPTY_FX_CONFIG, ...((row ?? {}) as Partial<FxConfig>) };
}

export async function writeConfig(
  deps: FxDeps,
  next: Partial<FxConfig>,
  adminId: number | null,
): Promise<void> {
  const merged = { ...(await readConfig(deps)), ...next };
  await deps.stores.fx.upsertConfig(deps.db, { value: merged, adminId });
}

/** 对外汇率状态：base = 追加表生效行；effective = base×(1+buffer/100)（override 态不叠点差） */
export async function currentState(deps: FxDeps): Promise<FxState> {
  const config = await readConfig(deps);
  const current = await deps.stores.fx.current(deps.db);
  const base = current?.rate ?? null;
  const effective =
    base == null || config.mode === 'override' ? base : applyBuffer(base, config.bufferPct);
  return {
    mode: config.mode,
    baseRate: base,
    effectiveRate: effective,
    bufferPct: config.bufferPct,
    source: current?.source ?? null,
    fxRateId: current?.fxRateId ?? null,
    fetchedAt: current?.fetchedAt ?? null,
  };
}

async function fetchEcbRate(deps: FxDeps): Promise<string> {
  const doFetch = deps.env.fetch ?? fetch;
  const res = await doFetch(deps.env.sourceUrl, {
    signal: AbortSignal.timeout(deps.env.fetchTimeoutMs),
  });
  if (!res.ok) {
    throw controlPlaneErrors.business('fx_fetch_failed', { status: res.status });
  }
  const j = (await res.json()) as { rates?: { CNY?: unknown } };
  return normalizeRate(String(j.rates?.CNY ?? ''));
}

export async function doRefresh(
  deps: FxDeps,
  force: boolean,
  adminId: number | null,
): Promise<void> {
  const now = deps.env.now ?? (() => new Date());
  if (!force) {
    const config = await readConfig(deps);
    const fresh =
      config.fetchedAt != null &&
      now().getTime() - Date.parse(config.fetchedAt) < deps.env.autoTtlMs;
    if (fresh) return;
  }
  const rate = await fetchEcbRate(deps);
  const row = await deps.stores.fx.insertRate(deps.db, { rate, source: 'ecb', mode: 'auto' });
  await writeConfig(
    deps,
    { currentRate: rate, currentFxRateId: row.id, source: 'ecb', fetchedAt: now().toISOString() },
    adminId,
  );
}
