/**
 * 手动覆盖汇率（冻结基准直到 clearOverride）：manual/override 行追加 + 缓存视图切换 + 审计。
 */
import type { FxState } from '../../domain/fx/fx-rates';
import { normalizeRate } from '../../domain/fx/fx-rates';
import type { FxDeps } from './fx-shared';
import { currentState, writeConfig } from './fx-shared';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface SetFxOverrideInput {
  readonly ctx: ControlContext;
  readonly rate: string;
}

export async function setFxOverride(deps: FxDeps, input: SetFxOverrideInput): Promise<FxState> {
  const rate = normalizeRate(input.rate);
  const adminId = adminIdOf(input.ctx);
  const row = await deps.stores.fx.insertRate(deps.db, {
    rate,
    source: 'manual',
    mode: 'override',
    operatorAdminId: adminId,
  });
  const now = (deps.env.now ?? (() => new Date()))();
  await writeConfig(
    deps,
    {
      mode: 'override',
      overrideRate: rate,
      currentRate: rate,
      currentFxRateId: row.id,
      source: 'manual',
      fetchedAt: now.toISOString(),
    },
    adminId,
  );
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'fx.override',
    targetType: 'system_config',
    targetId: 'catalog_fx',
    detail: { rate, fxRateId: row.id },
  });
  return currentState(deps);
}
