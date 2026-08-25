'use client';

// 邮箱验证码二次登录卡（纯个人自助，SELF 域）：只管「我」的二次登录开关与状态。
// 开关确认 = 邮箱码自证（admin-email-2fa,2026-08-25 D2=A）：点开关 → 向本人邮箱
// 发确认码 → 输码确认生效；取消 TOTP 前置（未绑验证器也可开启——D2）。
// 邮件通道（SMTP）是系统级配置——独立集成卡,2026-08-25 二次裁决;通道不可用
// 在发码步即被拒（503）,不再等点击开关后报错。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { Loader2Icon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { AdminMeInfo } from '@tillgate/api-client';

import { requestTwoFactorCodeAction, setTwoFactorAction } from '@/server/auth-actions';
import { useActionResult } from '@/components/action-toast';
import { CodeConfirmDialog } from './code-confirm-dialog';

export function EmailTwoFactorCard({ me }: { me: AdminMeInfo | null }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));
  const [sending, setSending] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  /** 第一步：向本人邮箱发确认码（冷却/SMTP 未生效在此步反馈） */
  function beginToggle(): void {
    setSending(true);
    void (async () => {
      try {
        const res = await requestTwoFactorCodeAction();
        if (res.error != null || res.challengeId == null) {
          toast.error(res.error ?? tc('actionFailed'));
          return;
        }
        setChallengeId(res.challengeId);
        setConfirmOpen(true);
      } finally {
        setSending(false);
      }
    })();
  }

  /** 第二步：输码确认 → 开关生效（成功审计在后端；成功即关弹窗,失败保持开可重试） */
  function confirmToggle(code: string): void {
    if (challengeId == null) return;
    startTransition(async () => {
      const next = !enabled;
      const res = await setTwoFactorAction(next, challengeId, code);
      if (notify(res ?? {}, tc('actionFailed'), next ? t('enabledToast') : t('disabledToast'))) {
        setEnabled(next);
        setConfirmOpen(false);
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
          {/* D2：不再按 TOTP 绑定置灰——邮箱码即确认凭证 */}
          <Button
            variant={enabled ? 'destructive' : 'default'}
            size="sm"
            disabled={pending || sending}
            onClick={beginToggle}
          >
            {(pending || sending) && <Loader2Icon className="animate-spin" />}
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
      <CodeConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="email"
        title={`${enabled ? t('disable') : t('enable')} — ${t('twoFactor')}`}
        onConfirm={confirmToggle}
      />
    </Card>
  );
}
