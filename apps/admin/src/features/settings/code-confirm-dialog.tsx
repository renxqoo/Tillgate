'use client';

// 6 位码确认小弹窗（受控哑件——只收码,确认即回调;提交/错误呈现由调用方编排）：
// variant=totp = TOTP step-up（ADR-0011,集成写入/启停）;variant=email =
// 邮箱码自证（admin-email-2fa D2=A,2FA 开关确认——码已发到本人邮箱）。
// 无效码由原生表单校验拦截（required + pattern）。

import { FieldDescription, FieldLabel, FormItem, Input } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { FormDialog } from '@/components/form-dialog';

export function CodeConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  variant = 'totp',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 码形经原生校验（6 位数字）才回调 */
  onConfirm: (code: string) => void;
  /** 动作词面（如「启用 GitHub 登录」——弹窗标题） */
  title: string;
  /** 码的来源：totp = 验证器 step-up;email = 本人邮箱确认码 */
  variant?: 'totp' | 'email';
}) {
  const t = useTranslations(variant === 'email' ? 'settings.emailCode' : 'settings.stepup');
  const tc = useTranslations('common');
  const formId = `code-confirm-${variant}`;
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
            const value = new FormData(e.currentTarget).get('code');
            setCode('');
            onConfirm(typeof value === 'string' ? value : '');
          }}
        >
          <FormItem>
            <FieldLabel htmlFor={`${formId}-input`}>{t('codeLabel')}</FieldLabel>
            <Input
              id={`${formId}-input`}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder=""
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
