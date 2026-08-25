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

type SmtpState = 'ready' | 'off' | 'unconfigured';

export function EmailTwoFactorCard({
  me,
  smtp,
  smtpUnavailable,
  onSavedSmtp,
}: {
  me: AdminMeInfo | null;
  smtp: IntegrationSettingItem | null;
  /** 无 settings_integrations 权限/加载失败——隐藏配置入口（2FA 启停不受影响） */
  smtpUnavailable: boolean;
  onSavedSmtp: (item: IntegrationSettingItem) => void;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const ti = useTranslations('settings.integrations');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));
  const [dialogOpen, setDialogOpen] = useState(false);

  const smtpState: SmtpState =
    smtp == null || !smtp.configured ? 'unconfigured' : smtp.enabled ? 'ready' : 'off';

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4" /> {t('twoFactor')}
          </CardTitle>
          {!smtpUnavailable ? (
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              {ti('configure')}
            </Button>
          ) : null}
        </div>
        <CardDescription>{t('twoFactorDescription', { email: me?.email ?? '—' })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant={enabled ? 'destructive' : 'default'}
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const next = !enabled;
                const res = await setTwoFactorAction(next);
                if (
                  notify(
                    res ?? {},
                    tc('actionFailed'),
                    next ? t('enabledToast') : t('disabledToast'),
                  )
                ) {
                  setEnabled(next);
                }
              })
            }
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
      {smtp != null ? (
        <IntegrationFormDialog
          item={smtp}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={onSavedSmtp}
          includeEnabled
        />
      ) : null}
    </Card>
  );
}
