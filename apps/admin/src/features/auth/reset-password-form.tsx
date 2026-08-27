'use client';

/**
 * 设置初始密码页表单（新建管理员邀请邮件的一次性链接打开）：
 * 新密码 + 确认 → 提交（token 单次消费）→ 成功态：去登录按钮 + 3 秒倒计时
 * 自动跳登录。token 缺失/无效给出明确指引（联系管理员重发邀请）。
 * 前端 8 位下限与 admin-api identity 密码策略（minLength 8）同口径,权威校验在服务端。
 */
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
} from '@tillgate/ui';
import { CheckCircle2Icon, KeyRoundIcon, Loader2Icon } from 'lucide-react';

import { resetPasswordAction } from '@/server/auth-actions';

const COUNTDOWN_SECONDS = 3;
const PASSWORD_MIN_LENGTH = 8;

export function ResetPasswordForm({ token }: { readonly token: string | null }) {
  const t = useTranslations('auth');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (!done) return;
    const timer = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          clearInterval(timer);
          router.replace('/login');
          return 0;
        }
        return n - 1;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [done, router]);

  if (token == null) {
    return (
      <Card className="shadow-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t('resetTitle')}</CardTitle>
          <CardDescription>{t('resetTokenMissing')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/login"
            className="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground"
          >
            {t('backToLogin')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="shadow-sm">
        <CardHeader className="text-center">
          <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-green-500/10 text-green-600">
            <CheckCircle2Icon className="size-6" />
          </span>
          <CardTitle className="text-2xl">{t('resetSuccessTitle')}</CardTitle>
          <CardDescription>{t('resetSuccessDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="h-10 w-full" onClick={() => router.replace('/login')}>
            {t('goLoginNow')}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t('countdownAuto', { seconds: countdown })}
          </p>
        </CardContent>
      </Card>
    );
  }

  const passwordValid = password.length >= PASSWORD_MIN_LENGTH;
  const canSubmit = passwordValid && confirm === password && !pending;

  return (
    <Card className="shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('resetTitle')}</CardTitle>
        <CardDescription>{t('resetDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirm) {
              setMismatch(true);
              return;
            }
            setMismatch(false);
            startTransition(async () => {
              const res = await resetPasswordAction(token, password);
              if (res?.ok) setDone(true);
              else toast.error(res?.error ?? t('resetFailed'));
            });
          }}
          className="space-y-6"
        >
          <FieldGroup>
            <Field data-invalid={password !== '' && !passwordValid}>
              <FieldLabel htmlFor="reset-password">{t('resetNewPasswordLabel')}</FieldLabel>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                placeholder={t('newPasswordPlaceholder')}
                className="h-11"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {password !== '' && !passwordValid && (
                <FieldError errors={[{ message: t('passwordMinLength', { min: 8 }) }]} />
              )}
            </Field>
            <Field data-invalid={mismatch}>
              <FieldLabel htmlFor="reset-confirm">{t('resetConfirmLabel')}</FieldLabel>
              <Input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                placeholder={t('confirmPasswordPlaceholder')}
                className="h-11"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch && <FieldError errors={[{ message: t('resetMismatch') }]} />}
            </Field>
          </FieldGroup>
          <Button type="submit" disabled={!canSubmit} className="h-10 w-full">
            {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            {t('resetSubmit')}
          </Button>
          <FieldDescription className="text-center">{t('resetOnceHint')}</FieldDescription>
        </form>
      </CardContent>
    </Card>
  );
}
