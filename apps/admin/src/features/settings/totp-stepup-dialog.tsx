'use client';

// TOTP step-up 小弹窗（ADR-0011：启/停与 2FA 开关的二次确认入口）：
// 受控哑件——只收 6 位验证器码，确认即回调；提交/错误呈现由调用方编排。
// 无效码由原生表单校验拦截（required + pattern）。

import { FieldDescription, FieldLabel, FormItem, Input } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { FormDialog } from '@/components/form-dialog';

export function TotpStepupDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 码形经原生校验（6 位数字）才回调 */
  onConfirm: (totpCode: string) => void;
  /** 动作词面（如「启用 GitHub 登录」——弹窗标题） */
  title: string;
}) {
  const t = useTranslations('settings.stepup');
  const tc = useTranslations('common');
  const formId = 'totp-stepup-form';
  const [code, setCode] = useState('');

  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={(next) => {
        if (next) setCode('');
        onOpenChange(next);
      }}
      title={title}
      description={t('dialogDescription')}
      submitLabel={tc('confirm')}
    >
      {() => (
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('totpCode');
            setCode('');
            onConfirm(typeof value === 'string' ? value : '');
          }}
        >
          <FormItem>
            <FieldLabel htmlFor="totp-stepup-code">{t('codeLabel')}</FieldLabel>
            <Input
              id="totp-stepup-code"
              name="totpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              required
              pattern="\d{6}"
              autoFocus
            />
            <FieldDescription>{t('codeHint')}</FieldDescription>
          </FormItem>
        </form>
      )}
    </FormDialog>
  );
}
