/**
 * settings 域装配段（admin settings 面）：方法级委托与依赖装配从 facade 逐字搬迁；
 * 返回 { settings } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { readBillingTimezone } from '../application/settings/read-billing-timezone';
import { updateBillingTimezone } from '../application/settings/update-billing-timezone';
import { readDebitFloorDefault } from '../application/settings/read-debit-floor-default';
import { updateDebitFloorDefault } from '../application/settings/update-debit-floor-default';
import { readBillingReservation } from '../application/settings/read-billing-reservation';
import { updateBillingReservation } from '../application/settings/update-billing-reservation';
import { readBillingReservationLimit } from '../application/settings/read-billing-reservation-limit';
import { updateBillingReservationLimit } from '../application/settings/update-billing-reservation-limit';
import { readPlatformCurrency } from '../application/settings/read-platform-currency';
import { updatePlatformCurrency } from '../application/settings/update-platform-currency';
import { listIntegrations } from '../application/integrations/list-integrations';
import { updateIntegration } from '../application/integrations/update-integration';
import { probeSmtp } from '../application/integrations/probe-smtp';

export function createSettingsSection({
  settingsDeps,
  currencyDeps,
  integrationDeps,
  smtpProbeDeps,
}: SectionDeps): Pick<ControlPlane, 'settings'> {
  return {
    settings: {
      billingTimezone: {
        read: () => readBillingTimezone(settingsDeps),
        update: (input) => updateBillingTimezone(settingsDeps, input),
      },
      debitFloorDefault: {
        read: () => readDebitFloorDefault(settingsDeps),
        update: (input) => updateDebitFloorDefault(settingsDeps, input),
      },
      billingReservation: {
        read: () => readBillingReservation(settingsDeps),
        update: (input) => updateBillingReservation(settingsDeps, input),
      },
      billingReservationLimit: {
        read: () => readBillingReservationLimit(settingsDeps),
        update: (input) => updateBillingReservationLimit(settingsDeps, input),
      },
      platformCurrency: {
        read: () => readPlatformCurrency(settingsDeps),
        update: (input) => updatePlatformCurrency(currencyDeps, input),
      },
      integrations: {
        list: () => listIntegrations(integrationDeps),
        update: (input) => updateIntegration(integrationDeps, input),
        probeSmtp: (input) => probeSmtp(smtpProbeDeps, input),
      },
    },
  };
}
