'use client';

// 邮箱验证码二次登录卡（纯个人自助，SELF 域）：只管「我」的二次登录开关与状态。
// 邮件通道（SMTP）是系统级配置——独立集成卡，2026-08-25 二次裁决推翻首裁
// 「挂 2FA 卡」：系统配置与个人自助分离，门控粒度对齐 settings:integrations。
// 通道状态提示不残留本卡（同日裁决 D1：完全移除，通道信息只在 SMTP 卡）。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { Loader2Icon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminMeInfo } from '@tillgate/api-client';

import { setTwoFactorAction } from '@/server/auth-actions';
import { useActionResult } from '@/components/action-toast';
import { TotpStepupDialog } from './totp-stepup-dialog';

export function EmailTwoFactorCard({ me }: { me: AdminMeInfo | null }) {
  // 未绑定验证器：2FA 开关不可达（ADR-0011——服务端同样拒绝）
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

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4" /> {t('twoFactor')}
        </CardTitle>
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
