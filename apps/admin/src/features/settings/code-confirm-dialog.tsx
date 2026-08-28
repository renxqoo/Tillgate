'use client';

// 6 位码确认小弹窗（受控哑件——只收码,确认即回调;提交/错误呈现由调用方编排）：
// variant=totp = TOTP step-up（集成写入/启停）;variant=email =
// 邮箱码自证（2FA 开关确认）。
// email 变体可携带 sendCode：输入框与「发送验证码」倒计时钮同排——可点态用
// 主题主色（Button 默认 variant）,冷却禁用态走 Button 内建主题感知样式,
// 不写死颜色。无效码由原生表单校验拦截（required + pattern）。

import { CountdownButton, FieldDescription, FieldLabel, FormItem, Input } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { FormDialog } from '@/components/form-dialog';

/** 发码编排（email 变体）：动作与冷却态由调用方持有，本弹窗只呈现 */
export interface SendCodeSlot {
  onSend: () => void;
  /** 冷却截止时刻（epoch ms；null/过期 = 可点击） */
  cooldownUntil: number | null;
  /** 发送请求进行中（禁用发送钮） */
  pending?: boolean;
}

export function CodeConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  variant = 'totp',
  sendCode,
  submitDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 码形经原生校验（6 位数字）才回调 */
  onConfirm: (code: string) => void;
  /** 动作词面（如「启用 GitHub 登录」——弹窗标题） */
  title: string;
  /** 码的来源：totp = 验证器 step-up;email = 本人邮箱确认码 */
  variant?: 'totp' | 'email';
  /** email 变体的发码编排（缺省 = 无发送行，纯输码） */
  sendCode?: SendCodeSlot;
  /** 外部条件禁用确认钮（如邮箱码未发送前） */
  submitDisabled?: boolean;
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
      submitDisabled={submitDisabled}
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
            <div className="flex items-center gap-2">
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
                className="flex-1"
              />
              {sendCode ? (
                <CountdownButton
                  cooldownUntil={sendCode.cooldownUntil}
                  disabled={sendCode.pending}
                  label={t('sendCode')}
                  countdownLabel={(seconds) => t('resendCountdown', { seconds })}
                  onClick={sendCode.onSend}
                />
              ) : null}
            </div>
            <FieldDescription>{t('codeHint')}</FieldDescription>
          </FormItem>
        </form>
      )}
    </FormDialog>
  );
}
