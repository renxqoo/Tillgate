'use client';

import { useState, useTransition } from 'react';

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, MailIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormItem,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@tillgate/ui';

import { useActionResult } from '@/components/action-toast';

import { EmailCodeStep } from './email-code-step';
import { TotpStep } from './totp-step';

interface Values {
  email: string;
  password: string;
}

/**
 * 登录三态编排器：密码步表单 + 第一步通过后的两步验证切换
 * （TOTP/恢复码步或邮箱验证码步，验证步自持输入与提交状态）。
 */
export function LoginForm() {
  const t = useTranslations('auth');
  const tUi = useTranslations('ui');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [showPwd, setShowPwd] = useState(false);
  // 邮箱验证码二次登录：第一步通过后进入验证码步
  const [challenge, setChallenge] = useState<string | null>(null);
  // TOTP 步凭证快照：第一步校验通过后的 email/password，验证步不回读登录表单
  const [totpCredentials, setTotpCredentials] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const schema = z.object({
    email: z.string().email(t('invalidEmail')),
    password: z.string().min(1, t('passwordRequired')),
  });

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  function onSubmit(values: Values) {
    startTransition(async () => {
      const fd = new FormData();
      fd.append('email', values.email);
      fd.append('password', values.password);
      const { loginAction } = await import('@/server/auth-actions');
      const res = await loginAction(fd);
      if (res?.totpRequired) {
        setTotpCredentials({ email: values.email, password: values.password });
        return;
      }
      if (res?.challengeId) setChallenge(res.challengeId);
      else notify(res ?? {}, t('loginFailed'));
    });
  }

  if (totpCredentials) {
    return (
      <TotpStep
        email={totpCredentials.email}
        password={totpCredentials.password}
        onBack={() => setTotpCredentials(null)}
      />
    );
  }

  if (challenge) {
    return <EmailCodeStep challenge={challenge} onBack={() => setChallenge(null)} />;
  }

  return (
    <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('loginTitle')}</CardTitle>
        <CardDescription>{t('loginDescription')}</CardDescription>
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
                <FormItem data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="admin-email">{t('email')}</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <MailIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="admin-email"
                      autoComplete="off"
                      placeholder="admin@example.com"
                      className="h-11"
                      {...field}
                    />
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </FormItem>
              )}
            />
            <Controller
              control={form.control}
              name="password"
              render={({ field, fieldState }) => (
                <FormItem data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="admin-password">{t('password')}</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LockIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="admin-password"
                      type={showPwd ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder={t('passwordPlaceholder')}
                      className="h-11"
                      {...field}
                    />
                    <InputGroupAddon align="inline-end">
                      <button
                        type="button"
                        onClick={() => setShowPwd((s) => !s)}
                        aria-label={showPwd ? tUi('hidePassword') : tUi('showPassword')}
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        {showPwd ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </InputGroupAddon>
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </FormItem>
              )}
            />
          </FieldGroup>

          <Button type="submit" disabled={pending} className="h-10 w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {t('submit')}
          </Button>

          <FieldDescription className="text-center">{t('noAccountHint')}</FieldDescription>
        </form>
      </CardContent>
    </Card>
  );
}
