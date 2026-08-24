/**
 * fx 域装配段：方法级委托与依赖装配从 facade 逐字搬迁（五个动词共用 fxDeps）；
 * 返回 { fx } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { fxState } from '../application/fx/fx-state';
import { refreshFx } from '../application/fx/refresh-fx';
import { setFxOverride } from '../application/fx/set-fx-override';
import { clearFxOverride } from '../application/fx/clear-fx-override';
import { setFxBuffer } from '../application/fx/set-fx-buffer';

export function createFxSection({ fxDeps }: SectionDeps): Pick<ControlPlane, 'fx'> {
  return {
    fx: {
      state: () => fxState(fxDeps),
      refresh: (input) => refreshFx(fxDeps, input),
      setOverride: (input) => setFxOverride(fxDeps, input),
      clearOverride: (input) => clearFxOverride(fxDeps, input),
      setBuffer: (input) => setFxBuffer(fxDeps, input),
    },
  };
}
