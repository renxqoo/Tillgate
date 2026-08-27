/**
 * settings 域装配段（admin settings 面）：方法级委托与依赖装配从 facade 逐字搬迁；
 * 返回 { settings } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { readBillingTimezone } from '../application/settings/read-billing-timezone';
import { updateBillingTimezone } from '../application/settings/update-billing-timezone';
import { listIntegrations } from '../application/integrations/list-integrations';
import { updateIntegration } from '../application/integrations/update-integration';
import { probeSmtp } from '../application/integrations/probe-smtp';

export function createSettingsSection({
  settingsDeps,
  integrationDeps,
  smtpProbeDeps,
}: SectionDeps): Pick<ControlPlane, 'settings'> {
  return {
    settings: {
      billingTimezone: {
        read: () => readBillingTimezone(settingsDeps),
        update: (input) => updateBillingTimezone(settingsDeps, input),
      },
      integrations: {
        list: () => listIntegrations(integrationDeps),
        update: (input) => updateIntegration(integrationDeps, input),
        probeSmtp: (input) => probeSmtp(smtpProbeDeps, input),
      },
    },
  };
}
