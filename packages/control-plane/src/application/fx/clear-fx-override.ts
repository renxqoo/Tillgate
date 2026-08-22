/**
 * 清除手动覆盖：回到 auto 态；清除后立即补一次 auto 行避免空窗（失败容忍显示 null）。
 */
import type { FxState } from '../../domain/fx/fx-rates';
import type { FxDeps } from './fx-shared';
import { currentState, doRefresh, writeConfig } from './fx-shared';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface ClearFxOverrideInput {
  readonly ctx: ControlContext;
}

export async function clearFxOverride(deps: FxDeps, input: ClearFxOverrideInput): Promise<FxState> {
  const adminId = adminIdOf(input.ctx);
  await writeConfig(
    deps,
    {
      mode: 'auto',
      overrideRate: null,
      currentRate: null,
      currentFxRateId: null,
      source: null,
      fetchedAt: null,
    },
    adminId,
  );
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'fx.override_clear',
    targetType: 'system_config',
    targetId: 'catalog_fx',
    detail: {},
  });
  // 清除后立即补一次 auto 行，避免空窗（失败容忍）
  try {
    await doRefresh(deps, true, null);
  } catch {
    // 同上：UI 提示汇率不可用
  }
  return currentState(deps);
}
