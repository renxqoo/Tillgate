/**
 * fx 状态读（含懒拉）：auto 态且（表无可用行 或 时间过期）才拉；
 * 拉取失败降级返回现状——绝不阻塞目录浏览。
 */
import type { FxState } from '../../domain/fx/fx-rates';
import type { FxDeps } from './fx-shared';
import { currentState, doRefresh, readConfig } from './fx-shared';

export async function fxState(deps: FxDeps): Promise<FxState> {
  const now = deps.env.now ?? (() => new Date());
  // 懒拉（auto 态）：表里没有可用行（真相在 fx_rates，配置缓存可能失真）或时间过期才拉
  const current = await deps.stores.fx.current(deps.db);
  const config = await readConfig(deps);
  const staleByTime =
    config.fetchedAt == null || now().getTime() - Date.parse(config.fetchedAt) > deps.env.autoTtlMs;
  if (config.mode === 'auto' && (current == null || staleByTime)) {
    try {
      await doRefresh(deps, current == null, null);
    } catch {
      // 拉取失败容忍：currentState 显示 null，UI 标注汇率不可用
    }
  }
  return currentState(deps);
}
