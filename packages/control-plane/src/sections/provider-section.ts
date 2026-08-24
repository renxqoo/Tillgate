/**
 * providers 域装配段：方法级委托与依赖装配从 facade 逐字搬迁；
 * 返回 { providers } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { createProvider } from '../application/providers/create-provider';
import { updateProvider } from '../application/providers/update-provider';
import { deleteProvider } from '../application/providers/delete-provider';
import { undeleteProvider } from '../application/providers/undelete-provider';
import { listProviders } from '../application/providers/list-providers';

export function createProviderSection({
  env,
  stores,
  audit,
}: SectionDeps): Pick<ControlPlane, 'providers'> {
  return {
    providers: {
      create: (input) =>
        createProvider(
          {
            db: env.db,
            stores: { provider: stores.provider },
            capabilities: env.capabilities,
            defaultProtocol: env.defaultProtocol,
            audit,
          },
          input,
        ),
      update: (input) =>
        updateProvider(
          {
            db: env.db,
            stores: { provider: stores.provider },
            capabilities: env.capabilities,
            audit,
          },
          input,
        ),
      delete: (input) =>
        deleteProvider(
          { db: env.db, stores: { provider: stores.provider, channel: stores.channel }, audit },
          input,
        ),
      undelete: (input) =>
        undeleteProvider({ db: env.db, stores: { provider: stores.provider }, audit }, input),
      list: (query) => listProviders({ db: env.db, stores: { provider: stores.provider } }, query),
    },
  };
}
