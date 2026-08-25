'use client';

// 邮箱验证码二次登录卡（原组装器内联 2FA 块拆出，组装见 ./index.tsx）：2FA 启停 +
// 邮件通道（SMTP）配置入口。SMTP 无独立集成卡——邮件通道是本卡功能的
// 实现细节，配置按钮在卡右上（与集成卡同位用户裁决）、启停开关在弹窗内
// （2026-08-25 用户裁决：不另立邮件服务配置面）。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { Loader2Icon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminMeInfo } from '@tillgate/api-client';

import { setTwoFactorAction } from '@/server/auth-actions';
import { useActionResult } from '@/components/action-toast';
import type { IntegrationSettingItem } from '@/server/settings-actions';
import { IntegrationFormDialog } from './integration-cards/integration-form-dialog';
import { TotpStepupDialog } from './totp-stepup-dialog';

export function EmailTwoFactorCard({
  me,
  smtp,
  smtpUnavailable,
  canManageIntegrations,
  onSavedSmtp,
}: {
  me: AdminMeInfo | null;
  smtp: IntegrationSettingItem | null;
  /** 集成列表加载失败——隐藏 SMTP 配置入口（2FA 启停不受影响） */
  smtpUnavailable: boolean;
  /** settings:integrations 持有者可见 SMTP 配置入口（2026-08-25 用户裁决 D1；2FA 启停属 SELF 域不挂码） */
  canManageIntegrations: boolean;
  onSavedSmtp: (item: IntegrationSettingItem) => void;
}) {
  // 未绑定验证器：2FA 开关与 SMTP 配置均不可达（ADR-0011——服务端同样拒绝）
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));
  const [stepupOpen, setStepupOpen] = useState(false);
  const totpEnabled = me?.totpEnabled === true;
  const stepupTitle = totpEnabled ? undefined : t('stepupRequired');

  function confirmTwoFactor(code: string): void {
    startTransition(async () => {
      const next = !enabled;
      const res = await setTwoFactorAction(next, code);
      if (notify(res ?? {}, tc('actionFailed'), next ? t('enabledToast') : t('disabledToast'))) {
        setEnabled(next);
      }
    });
  }

  const smtpState = smtpStateOf(smtp);

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4" /> {t('twoFactor')}
          </CardTitle>
          <SmtpConfigEntry
            smtp={smtp}
            visible={!smtpUnavailable && canManageIntegrations}
            totpEnabled={totpEnabled}
            stepupTitle={stepupTitle}
            onSaved={onSavedSmtp}
          />
        </div>
        <CardDescription>{t('twoFactorDescription', { email: me?.email ?? '—' })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant={enabled ? 'destructive' : 'default'}
            size="sm"
            disabled={pending || !totpEnabled}
            title={stepupTitle}
            onClick={() => setStepupOpen(true)}
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {enabled ? t('disable') : t('enable')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('currentStatus')}
            <span className={enabled ? 'text-green-600' : ''}>
              {enabled ? t('enabledState') : t('disabledState')}
            </span>
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t(`smtpState.${smtpState}`)}</p>
      </CardContent>
      <TotpStepupDialog
        open={stepupOpen}
        onOpenChange={setStepupOpen}
        title={`${enabled ? t('disable') : t('enable')} — ${t('twoFactor')}`}
        onConfirm={(code) => confirmTwoFactor(code)}
      />
    </Card>
  );
}

/** SMTP 配置入口（右上按钮 + 配置弹窗，哑件拆分——主组件复杂度收口，铁律 22 ②） */
function SmtpConfigEntry(input: {
  smtp: IntegrationSettingItem | null;
  visible: boolean;
  totpEnabled: boolean;
  stepupTitle: string | undefined;
  onSaved: (item: IntegrationSettingItem) => void;
}) {
  const ti = useTranslations('settings.integrations');
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!input.visible) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!input.totpEnabled}
        title={input.stepupTitle}
        onClick={() => setDialogOpen(true)}
      >
        {ti('configure')}
      </Button>
      {input.smtp != null ? (
        <IntegrationFormDialog
          item={input.smtp}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={input.onSaved}
          includeEnabled
        />
      ) : null}
    </>
  );
}

/** 邮件通道三态（模块级纯函数——主组件复杂度收口） */
function smtpStateOf(smtp: IntegrationSettingItem | null): 'ready' | 'off' | 'unconfigured' {
  if (smtp == null || !smtp.configured) return 'unconfigured';
  return smtp.enabled ? 'ready' : 'off';
}
