'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, MailIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import * as z from 'zod';

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
import { loginAction } from '@/server/actions/auth';

import { LoginCodeStep } from './login-code-step';
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
          method="post"
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
                      placeholder={t('passwordPlaceholder')}
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
