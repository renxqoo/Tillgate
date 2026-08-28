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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@tillgate/ui';

import { actionResult } from '@/features/shared/action-result';
import { verifyLoginCodeAction } from '@/server/actions/auth';

/**
 * 两步登录的邮箱验证码步（模块级组件）：code 状态随本组件自持，
 * 返回/重新进入时随卸载归零（与原「返回时清 code」语义一致）。
 */
export function LoginCodeStep({
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
          method="post"
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
