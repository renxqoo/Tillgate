'use client';

// 集成单卡（哑件）：标题左、配置按钮右上与标题对齐（用户裁决）；内容面
// 状态徽章 + 启停按钮 + Turnstile 停用联动警告（DESIGN §5 D11）。
// 卡面不显示配置字段值（2026-08-25 用户裁决：与 2FA/TOTP 卡同形态，配置收进弹窗）。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import {
  AtSignIcon,
  CreditCardIcon,
  GitBranchIcon,
  GlobeIcon,
  MailIcon,
  ShieldAlertIcon,
  WalletIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';

import type { IntegrationSettingItem } from '@/server/settings-actions';
import { updateIntegrationAction } from '@/server/settings-actions';
import { IntegrationFormDialog } from './integration-form-dialog';
import { INTEGRATION_ICON, i18nKey } from './integration-format';
import { TotpStepupDialog } from '../totp-stepup-dialog';
import { ToggleRow } from './toggle-row';

const ICONS: Record<string, LucideIcon> = {
  globe: GlobeIcon,
  github: GitBranchIcon,
  chrome: AtSignIcon,
  mail: MailIcon,
  shield: ShieldAlertIcon,
  wallet: WalletIcon,
  card: CreditCardIcon,
};

export function IntegrationCard({
  item,
  signupGiftOn,
  totpEnabled,
}: {
  item: IntegrationSettingItem;
  /** 注册送礼开启（Turnstile 停用联动警告的数据源） */
  signupGiftOn: boolean;
  /** 当前管理员已绑定验证器（ADR-0011——未绑定者敏感按钮置灰引导绑定） */
  totpEnabled: boolean;
}) {
  const t = useTranslations('settings.integrations');
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stepupOpen, setStepupOpen] = useState(false);
  const [current, setCurrent] = useState(item);
  const Icon = ICONS[INTEGRATION_ICON[current.key] ?? 'globe'] ?? GlobeIcon;

  const toggleEnabled = (totpCode: string): void => {
    const next = !current.enabled;
    setPending(true);
    void (async () => {
      try {
        const saved = await updateIntegrationAction(current.key, { totpCode, enabled: next });
        setCurrent(saved);
        if (current.key === 'captcha.turnstile' && !next && signupGiftOn) {
          // Turnstile 加固（DESIGN §5 D11）：警告不阻断——停用已生效，风险显式留痕
          toast.warning(t('captchaWarning'));
        }
      } catch {
        toast.error(tc('actionFailed'));
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <Card className="flex h-full w-full flex-col">
      <CardHeader>
        {/* 用户裁决：设置按钮放卡片右上方、与标题垂直对齐 */}
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4" /> {t(`cards.${i18nKey(current.key)}`)}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={!totpEnabled}
            title={totpEnabled ? undefined : ts('stepupRequired')}
            onClick={() => setDialogOpen(true)}
          >
            {t('configure')}
          </Button>
        </div>
        <CardDescription>{t(`descriptions.${i18nKey(current.key)}`)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <ToggleRow
          enabled={current.enabled}
          configured={current.configured}
          pending={pending}
          totpEnabled={totpEnabled}
          stepupTitle={totpEnabled ? undefined : ts('stepupRequired')}
          onRequestToggle={() => setStepupOpen(true)}
        />
        {current.key === 'captcha.turnstile' && current.enabled && signupGiftOn ? (
          <p className="text-xs text-amber-600">{t('captchaWarning')}</p>
        ) : null}
        {current.rotatedAt != null ? (
          <p className="text-xs text-muted-foreground">
            {t('rotatedAt', { at: current.rotatedAt })}
          </p>
        ) : null}
      </CardContent>
      <IntegrationFormDialog
        item={current}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={(saved) => setCurrent(saved)}
      />
      <TotpStepupDialog
        open={stepupOpen}
        onOpenChange={setStepupOpen}
        title={`${current.enabled ? t('disable') : t('enable')} — ${t(`cards.${i18nKey(current.key)}`)}`}
        onConfirm={(code) => toggleEnabled(code)}
      />
    </Card>
  );
}
