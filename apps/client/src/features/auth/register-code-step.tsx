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
import { registerVerifyAction } from '@/server/actions/auth';

/**
 * 注册第二步步的邮箱验证码卡（模块级组件）：code 状态随本组件自持，
 * 返回/重新进入时随卸载归零（与原「返回时清 code」语义一致）。
 */
export function RegisterCodeStep({
  challenge,
  affCode,
  onBack,
}: {
  challenge: string;
  affCode: string | null;
  onBack: () => void;
}) {
  const t = useTranslations('auth');
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState('');

  return (
    <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('codeTitle')}</CardTitle>
        <CardDescription>{t('codeSentRegister')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await registerVerifyAction(challenge, code, affCode);
              actionResult(res ?? {}, t('verifyFailed'));
              // 成功会 redirect，不会回到这里
            });
          }}
          className="space-y-4"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="register-code">{t('codeLabel')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <ShieldCheckIcon />
                </InputGroupAddon>
                <InputGroupInput
                  id="register-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={t('codePlaceholder')}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                />
              </InputGroup>
              <FieldDescription>{t('codeNoticeRegister')}</FieldDescription>
            </Field>
          </FieldGroup>
          <Button type="submit" disabled={pending || code.length !== 6} className="w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {t('verifyAndRegister')}
          </Button>
          <button
            type="button"
            className="w-full cursor-pointer text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={onBack}
          >
            {t('backToRegister')}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
