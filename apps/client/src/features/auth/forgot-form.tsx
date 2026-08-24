'use client';

/**
 * 找回密码 · 发起（仅邮箱——第一步不收集密码,新密码在邮件链接打开的
 * /reset-password 页设置)。提交后无论邮箱是否存在都进入「已发送」态
 * （防枚举在 API 侧,前端无从也无须区分）。
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
import { ArrowLeftIcon, Loader2Icon, MailCheckIcon, MailIcon } from 'lucide-react';

import { forgotAction } from '@/server/actions/auth';
import { actionResult } from '@/features/shared/action-result';

export function ForgotForm() {
  const t = useTranslations('auth');
  const [pending, startTransition] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);

  const schema = z.object({ email: z.string().email(t('invalidEmail')) });
  const form = useForm<{ email: string }>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  if (sentTo != null) {
    return (
      <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
        <CardHeader className="text-center">
          <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MailCheckIcon className="size-6" />
          </span>
          <CardTitle className="text-2xl">{t('forgotTitle')}</CardTitle>
          <CardDescription>{t('forgotSentDesc', { email: sentTo })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-xs text-muted-foreground">{t('forgotSentHint')}</p>
          <Link
            href="/login"
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium underline-offset-2 hover:bg-accent"
          >
            <ArrowLeftIcon className="size-4" />
            {t('backToLogin')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('forgotTitle')}</CardTitle>
        <CardDescription>{t('forgotDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          autoComplete="off"
          onSubmit={form.handleSubmit((v) =>
            startTransition(async () => {
              const fd = new FormData();
              fd.append('email', v.email);
              const res = await forgotAction(fd);
              if (res?.ok) setSentTo(v.email);
              else actionResult(res ?? {}, t('forgotFailed'));
            }),
          )}
          className="space-y-6"
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="forgot-email">{t('emailLabel')}</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <MailIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="forgot-email"
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
          </FieldGroup>
          <Button type="submit" disabled={pending} className="h-10 w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {t('forgotSubmit')}
          </Button>
          <FieldDescription className="text-center">
            <Link
              href="/login"
              className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
            >
              <ArrowLeftIcon className="size-3" />
              {t('backToLogin')}
            </Link>
          </FieldDescription>
        </form>
      </CardContent>
    </Card>
  );
}
