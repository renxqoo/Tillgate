'use client';

import { useState, useTransition } from 'react';

import { Loader2Icon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FormItem,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@tillgate/ui';

import { useActionResult } from '@/components/action-toast';

/**
 * 邮箱验证码二次登录步（模块级组件）：code 输入与提交状态自持，
 * 返回/重新进入时随卸载归零（与原「返回时清 code」语义一致，与 client 端
 * LoginCodeStep 判例同构）。
 */
export function EmailCodeStep({ challenge, onBack }: { challenge: string; onBack: () => void }) {
  const t = useTranslations('auth');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [code, setCode] = useState('');

  return (
    <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('twoFactorTitle')}</CardTitle>
        <CardDescription>{t('twoFactorSent')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const { verifyLoginAction } = await import('@/server/auth-actions');
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
            onClick={onBack}
          >
            {t('backToLogin')}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
