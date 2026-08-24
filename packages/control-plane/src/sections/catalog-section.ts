/**
 * catalog 域装配段：方法级委托与依赖装配从 facade 逐字搬迁；
 * 返回 { catalog } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { listCatalogSources } from '../application/catalog/list-catalog-sources';
import { compareCatalogFromSource } from '../application/catalog/compare-catalog';
import { catalogPriceHistory } from '../application/catalog/catalog-price-history';
import { importCatalog } from '../application/catalog/import-catalog';

export function createCatalogSection({
  env,
  stores,
  audit,
  fxDeps,
  sourceDeps,
}: SectionDeps): Pick<ControlPlane, 'catalog'> {
  return {
    catalog: {
      listSources: () => listCatalogSources(env.sources),
      comparison: (sourceId) =>
        compareCatalogFromSource(
          {
            ...sourceDeps,
            db: env.db,
            stores: { model: stores.model, channel: stores.channel },
            fx: fxDeps,
          },
          sourceId,
        ),
      priceHistory: (input) =>
        catalogPriceHistory({ db: env.db, stores: { audit: stores.audit } }, input),
      import: (input) =>
        importCatalog(
          {
            ...sourceDeps,
            db: env.db,
            stores: {
              provider: stores.provider,
              channel: stores.channel,
              model: stores.model,
            },
            cipher: env.cipher,
            channelRpm: env.catalogChannelRpm,
            channelBudget: env.catalogChannelBudget,
            fx: fxDeps,
            audit,
          },
          input,
        ),
    },
  };
}
