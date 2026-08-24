'use client';

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
import { useState, useTransition } from 'react';

import {
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  LockIcon,
  MailIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { loginAction, loginTotpAction, verifyLoginAction } from '@/server/auth-actions';
import { useActionResult } from '@/components/action-toast';

interface Values {
  email: string;
  password: string;
}

// eslint-disable-next-line max-lines-per-function -- 登录三态流程表单（密码/TOTP/恢复码 + 两步切换状态机）整段平铺，拆分需抽流程子组件（存量棘轮，行为等价优先）
export function LoginForm() {
  const t = useTranslations('auth');
  const tUi = useTranslations('ui');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [showPwd, setShowPwd] = useState(false);
  // 邮箱验证码二次登录：第一步通过后进入验证码步
  const [challenge, setChallenge] = useState<string | null>(null);
  const [totpPending, setTotpPending] = useState(false);
  const [code, setCode] = useState('');

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
      const res = await loginAction(fd);
      if (res?.totpRequired) {
        setCode('');
        setTotpPending(true);
        return;
      }
      if (res?.challengeId) setChallenge(res.challengeId);
      else notify(res ?? {}, t('loginFailed'));
    });
  }

  if (totpPending) {
    return (
      <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t('totpTitle')}</CardTitle>
          <CardDescription>{t('totpHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const values = form.getValues();
                const res = await loginTotpAction(values.email, values.password, code);
                notify(res ?? {}, t('loginFailed'));
              });
            }}
            className="space-y-6"
          >
            <FieldGroup>
              <FormItem>
                <FieldLabel htmlFor="admin-totp-code">{t('codeLabelTotp')}</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <ShieldCheckIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="admin-totp-code"
                    autoComplete="one-time-code"
                    placeholder={t('totpCodePlaceholder')}
                    className="uppercase tracking-widest"
                    value={code}
                    onChange={(e) =>
                      setCode(
                        e.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 10),
                      )
                    }
                    autoFocus
                  />
                </InputGroup>
                <FieldDescription>{t('totpRecoveryHint')}</FieldDescription>
              </FormItem>
            </FieldGroup>
            <Button
              type="submit"
              disabled={pending || !/^([0-9]{6}|[A-Z0-9]{10})$/.test(code)}
              className="h-10 w-full"
            >
              {pending && <Loader2Icon className="animate-spin" />}
              {t('verifyAndLogin')}
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setTotpPending(false);
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

  if (challenge) {
    return (
      <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t('twoFactorTitle')}</CardTitle>
          <CardDescription>{t('twoFactorSent')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const res = await verifyLoginAction(challenge, code);
                notify(res ?? {}, t('verifyFailed'));
              });
            }}
            className="space-y-6"
          >
            <FieldGroup>
              <FormItem>
                <FieldLabel htmlFor="admin-2fa-code">{t('codeLabel')}</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <ShieldCheckIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="admin-2fa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder={t('codePlaceholder')}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    autoFocus
                  />
                </InputGroup>
                <FieldDescription>{t('twoFactorHint')}</FieldDescription>
              </FormItem>
            </FieldGroup>
            <Button type="submit" disabled={pending || code.length !== 6} className="h-10 w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              {t('verifyAndLogin')}
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
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
    <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('loginTitle')}</CardTitle>
        <CardDescription>{t('loginDescription')}</CardDescription>
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
