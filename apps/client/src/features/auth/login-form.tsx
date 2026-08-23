'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, MailIcon, ShieldCheckIcon } from 'lucide-react';
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
} from '@tokenlens/ui';

import { actionResult } from '@/features/shared/action-result';
import { loginAction, verifyLoginCodeAction } from '@/server/actions/auth';

import { OAuthButtons } from './oauth-buttons';
import type { OAuthOption } from './oauth-options';

interface LoginValues {
  email: string;
  password: string;
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
  const [code, setCode] = useState('');

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
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('codeTitle')}</CardTitle>
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
            className="space-y-4"
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
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    autoFocus
                  />
                </InputGroup>
                <FieldDescription>{t('codeNoticeLogin')}</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={pending || code.length !== 6} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              {t('verifyAndLogin')}
            </Button>
            <button
              type="button"
              className="w-full cursor-pointer text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setChallenge(null);
                setCode('');
              }}
            >
              {t('backToLogin')}
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('loginTitle')}</CardTitle>
        <CardDescription>{t('loginDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                      autoComplete="email"
                      placeholder="you@example.com"
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
                      autoComplete="current-password"
                      {...field}
                    />
                    <InputGroupAddon align="inline-end">
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-label={showPassword ? tUi('hidePassword') : tUi('showPassword')}
                        className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
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

          <Button type="submit" disabled={pending} className="w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {t('loginSubmit')}
          </Button>

          <FieldDescription className="text-center">
            {t('noAccount')}
            <Link href="/register" className="ml-1 text-foreground underline-offset-2 hover:underline">
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
