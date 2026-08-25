'use client';

// OAuth 登录组合卡（2026-08-25 用户裁决：基地址不独立占卡）：
// 基础地址（oauth.base——OAuth 登录总闸：回调白名单 + 前端落点，base 不生效
// 则两个 provider 全部失效）+ GitHub + Google 三个集成行共居一卡。
// 每行独立启停/配置（各自一次 step-up，单 key 单 PUT 不变）。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import { GlobeIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import type { IntegrationSettingItem } from '@/server/settings-actions';
import { updateIntegrationAction } from '@/server/settings-actions';
import { TotpStepupDialog } from '../totp-stepup-dialog';
import { IntegrationFormDialog } from './integration-form-dialog';
import { i18nKey } from './integration-format';
import { ToggleRow } from './toggle-row';

export function OAuthCard({
  base,
  github,
  google,
  totpEnabled,
}: {
  base: IntegrationSettingItem;
  github: IntegrationSettingItem;
  google: IntegrationSettingItem;
  totpEnabled: boolean;
}) {
  const t = useTranslations('settings.integrations');
  const ts = useTranslations('settings');

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GlobeIcon className="size-4" /> {t('cards.oauth_login')}
        </CardTitle>
        <CardDescription>{t('descriptions.oauth_login')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <OAuthRow item={base} totpEnabled={totpEnabled} stepupTitle={ts('stepupRequired')} />
        <OAuthRow item={github} totpEnabled={totpEnabled} stepupTitle={ts('stepupRequired')} />
        <OAuthRow item={google} totpEnabled={totpEnabled} stepupTitle={ts('stepupRequired')} />
        <p className="text-xs text-muted-foreground">{t('oauthBaseGateHint')}</p>
      </CardContent>
    </Card>
  );
}

/** 组合卡内单行：label + 启停（经 step-up）+ 配置弹窗；行为与独立集成卡一致 */
function OAuthRow({
  item,
  totpEnabled,
  stepupTitle,
}: {
  item: IntegrationSettingItem;
  totpEnabled: boolean;
  stepupTitle: string | undefined;
}) {
  const t = useTranslations('settings.integrations');
  const tc = useTranslations('common');
  const [current, setCurrent] = useState(item);
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stepupOpen, setStepupOpen] = useState(false);

  const toggleEnabled = (totpCode: string): void => {
    const next = !current.enabled;
    setPending(true);
    void (async () => {
      try {
        setCurrent(await updateIntegrationAction(current.key, { totpCode, enabled: next }));
      } catch {
        toast.error(tc('actionFailed'));
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t(`cards.${i18nKey(current.key)}`)}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!totpEnabled}
          title={stepupTitle}
          onClick={() => setDialogOpen(true)}
        >
          {t('configure')}
        </Button>
      </div>
      <ToggleRow
        enabled={current.enabled}
        configured={current.configured}
        pending={pending}
        totpEnabled={totpEnabled}
        stepupTitle={stepupTitle}
        onRequestToggle={() => setStepupOpen(true)}
      />
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
    </div>
  );
}
