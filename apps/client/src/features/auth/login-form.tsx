'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import {
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  LockIcon,
  MailIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@tillgate/ui';

import { actionResult } from '@/features/shared/action-result';
import { loginAction, verifyLoginCodeAction } from '@/server/actions/auth';

import { OAuthButtons } from './oauth-buttons';
import type { OAuthOption } from './oauth-options';

interface LoginValues {
  email: string;
  password: string;
}

/**
 * 两步登录的邮箱验证码步（模块级组件）：code 状态随本组件自持，
 * 返回/重新进入时随卸载归零（与原「返回时清 code」语义一致）。
 */
function LoginCodeStep({
  challenge,
  next,
  onBack,
}: {
  challenge: string;
  next: string | null;
  onBack: () => void;
}) {
  const t = useTranslations('auth');
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState('');

  return (
    <Card className="[--card-spacing:--spacing(7)] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('codeTitle')}</CardTitle>
        <CardDescription>{t('codeSentLogin')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await verifyLoginCodeAction(challenge, code, next);
              actionResult(res ?? {}, t('verifyFailed'));
              // 成功会 redirect，不会回到这里
            });
          }}
          className="space-y-6"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="login-code">{t('codeLabel')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <ShieldCheckIcon />
                </InputGroupAddon>
                <InputGroupInput
                  id="login-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={t('codePlaceholder')}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                />
              </InputGroup>
              <FieldDescription>{t('codeNoticeLogin')}</FieldDescription>
            </Field>
          </FieldGroup>
          <Button type="submit" disabled={pending || code.length !== 6} className="h-10 w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {t('verifyAndLogin')}
          </Button>
          <button
            type="button"
            className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={onBack}
          >
            {t('backToLogin')}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}

export function LoginForm({
  next,
  oauthOptions = [],
}: {
  next: string | null;
  oauthOptions?: OAuthOption[];
}) {
  const t = useTranslations('auth');
  const tUi = useTranslations('ui');
  const [pending, startTransition] = useTransition();
  const [showPassword, setShowPassword] = useState(false);
  // 两步登录：第一步通过后进入邮箱验证码步（capabilities.emailCodeRequired）
  const [challenge, setChallenge] = useState<string | null>(null);

  const loginSchema = z.object({
    email: z.string().email(t('invalidEmail')),
    password: z.string().min(1, t('passwordRequired')),
  });

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  function onSubmit(values: LoginValues) {
    startTransition(async () => {
      const fd = new FormData();
      fd.append('email', values.email);
      fd.append('password', values.password);
      const res = await loginAction(fd);
      if (res?.challengeId) setChallenge(res.challengeId);
      else actionResult(res ?? {}, t('loginFailed'));
    });
  }

  if (challenge) {
    return <LoginCodeStep challenge={challenge} next={next} onBack={() => setChallenge(null)} />;
  }

  return (
    <Card className="[--card-spacing:--spacing(7)] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('loginTitle')}</CardTitle>
        <CardDescription>{t('loginDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          autoComplete="off"
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-6"
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="login-email">{t('emailLabel')}</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <MailIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="login-email"
                      autoComplete="off"
                      placeholder="you@example.com"
                      className="h-11"
                      {...field}
                    />
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="password"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="login-password">{t('passwordLabel')}</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LockIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      className="h-11"
                      {...field}
                    />
                    <InputGroupAddon align="inline-end">
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-label={showPassword ? tUi('hidePassword') : tUi('showPassword')}
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </InputGroupAddon>
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>

          <div className="flex justify-end">
            <Link
              href="/forgot"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {t('forgotLink')}
            </Link>
          </div>

          <Button type="submit" disabled={pending} className="h-10 w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {t('loginSubmit')}
          </Button>

          <FieldDescription className="text-center">
            {t('noAccount')}
            <Link
              href="/register"
              className="ml-1 text-foreground underline-offset-2 hover:underline"
            >
              {t('registerNow')}
            </Link>
          </FieldDescription>
        </form>
        <div className="mt-4">
          <OAuthButtons options={oauthOptions} />
        </div>
      </CardContent>
    </Card>
  );
}
