/**
 * 设置点差（%）：预填价 = 目录美元价 × 基准 ×(1+buffer/100)；点差不叠在覆盖值上。
 */
import type { FxState } from '../../domain/fx/fx-rates';
import { normalizeBuffer } from '../../domain/fx/fx-rates';
import type { FxDeps } from './fx-shared';
import { currentState, writeConfig } from './fx-shared';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface SetFxBufferInput {
  readonly ctx: ControlContext;
  readonly bufferPct: string;
}

export async function setFxBuffer(deps: FxDeps, input: SetFxBufferInput): Promise<FxState> {
  const bufferPct = normalizeBuffer(input.bufferPct);
  const adminId = adminIdOf(input.ctx);
  await writeConfig(deps, { bufferPct }, adminId);
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'fx.buffer',
    targetType: 'system_config',
    targetId: 'catalog_fx',
    detail: { bufferPct },
  });
  return currentState(deps);
}
