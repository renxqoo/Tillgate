/**
 * 强制/按 TTL 刷新 fx：force=false 尊重 TTL（新鲜即跳过）；force=true 无条件拉。
 */
import type { FxState } from '../../domain/fx/fx-rates';
import type { FxDeps } from './fx-shared';
import { currentState, doRefresh } from './fx-shared';
import { adminIdOf, type ControlContext } from '../context';

export interface RefreshFxInput {
  readonly ctx: ControlContext;
  readonly force?: boolean;
}

export async function refreshFx(deps: FxDeps, input: RefreshFxInput): Promise<FxState> {
  await doRefresh(deps, input.force === true, adminIdOf(input.ctx));
  return currentState(deps);
}
