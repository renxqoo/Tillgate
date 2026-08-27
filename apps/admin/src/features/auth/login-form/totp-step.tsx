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
 * TOTP/恢复码验证步（模块级组件）：code 输入与提交状态自持，
 * 返回/重新进入时随卸载归零（与原「进入/返回时清 code」语义一致）；
 * email/password 是第一步校验通过后的快照，本步不回读登录表单。
 */
export function TotpStep({
  email,
  password,
  onBack,
}: {
  email: string;
  password: string;
  onBack: () => void;
}) {
  const t = useTranslations('auth');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [code, setCode] = useState('');

  return (
    <Card className="[--card-spacing:--spacing(7)] py-[33px] shadow-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('totpTitle')}</CardTitle>
        <CardDescription>{t('totpHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const { loginTotpAction } = await import('@/server/auth-actions');
              const res = await loginTotpAction(email, password, code);
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
            onClick={onBack}
          >
            {t('backToLogin')}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
