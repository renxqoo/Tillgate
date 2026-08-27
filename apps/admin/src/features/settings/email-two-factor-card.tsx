'use client';

// 邮箱验证码二次登录卡（纯个人自助，SELF 域）：只管「我」的二次登录开关与状态。
// 开关确认 = 邮箱码自证：点开关只开弹窗，
// 弹窗内手动「发送验证码」（60s 冷却倒计时，CountdownButton——关弹窗再开
// 倒计时连续），输码确认生效；取消 TOTP 前置（未绑验证器也可开启）。
// 邮件通道（SMTP）是系统级配置——独立集成卡;通道不可用
// 在发码步即被拒（503）,不再等点击开关后报错。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { AdminMeInfo } from '@tillgate/api-client';

import { requestTwoFactorCodeAction, setTwoFactorAction } from '@/server/auth-actions';
import { useActionResult } from '@/components/action-toast';
import { CodeConfirmDialog } from './code-confirm-dialog';

/** 服务端挑战冷却（装配 challenge.cooldownMs=60s——与后端同拍展示） */
const SEND_COOLDOWN_MS = 60_000;

export function EmailTwoFactorCard({ me }: { me: AdminMeInfo | null }) {
  const t = useTranslations('settings');
  const te = useTranslations('settings.emailCode');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);

  /** 发码（弹窗内手动触发）：成功记 challengeId 并启动 60s 冷却倒计时 */
  function sendCode(): void {
    setSending(true);
    void (async () => {
      try {
        const res = await requestTwoFactorCodeAction();
        if (res.error != null || res.challengeId == null) {
          toast.error(res.error ?? tc('actionFailed'));
          return;
        }
        setChallengeId(res.challengeId);
        setCooldownUntil(Date.now() + SEND_COOLDOWN_MS);
        toast.success(te('sentToast'));
      } finally {
        setSending(false);
      }
    })();
  }

  /** 输码确认 → 开关生效（成功即关弹窗,失败保持开可重试；成功审计在后端） */
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
          {/* 不按 TOTP 绑定置灰——邮箱码即确认凭证 */}
          <Button
            variant={enabled ? 'destructive' : 'default'}
            size="sm"
            disabled={pending}
            onClick={() => setConfirmOpen(true)}
          >
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
        submitDisabled={challengeId == null}
        sendCode={{
          onSend: sendCode,
          cooldownUntil,
          pending: sending,
        }}
        onConfirm={confirmToggle}
      />
    </Card>
  );
}
