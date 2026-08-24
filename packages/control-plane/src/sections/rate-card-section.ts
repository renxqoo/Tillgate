/**
 * rates 域装配段：方法级委托与依赖装配从 facade 逐字搬迁；
 * 返回 { rates } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { createRateCard } from '../application/rates/create-rate-card';
import { updateRateCard } from '../application/rates/update-rate-card';
import { deleteRateCard } from '../application/rates/delete-rate-card';
import { listRateCards } from '../application/rates/list-rate-cards';
import { listRateCardUsers } from '../application/rates/list-rate-card-users';
import { checkRateCardHealth } from '../application/rates/check-rate-card-health';

export function createRateCardSection({
  env,
  stores,
  audit,
  auditTx,
}: SectionDeps): Pick<ControlPlane, 'rates'> {
  return {
    rates: {
      createCard: (input) =>
        createRateCard({ db: env.db, stores: { rateCard: stores.rateCard }, audit }, input),
      updateCard: (input) =>
        updateRateCard({ db: env.db, stores: { rateCard: stores.rateCard }, auditTx }, input),
      deleteCard: (input) =>
        deleteRateCard({ db: env.db, stores: { rateCard: stores.rateCard }, audit }, input),
      listCards: (query) =>
        listRateCards({ db: env.db, stores: { rateCard: stores.rateCard } }, query),
      listCardUsers: (input) =>
        listRateCardUsers({ db: env.db, stores: { rateCard: stores.rateCard } }, input),
      cardHealth: (rateCardId) =>
        checkRateCardHealth({ db: env.db, stores: { rateCard: stores.rateCard } }, rateCardId),
      findGlobalCoefficient: (rateCardId) =>
        stores.rateCard.findGlobalCoefficient(env.db, rateCardId),
    },
  };
}
