'use client';

import { FieldDescription, FieldLabel, FormItem, Input } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

/** step-up 码框（敏感写操作强制 TOTP——原生校验 6 位；窄输入+旁注贴近保存动作） */
export function StepupField({ itemId }: { itemId: string }) {
  const t = useTranslations('settings.integrations');
  return (
    <FormItem gap={1.5}>
      <FieldLabel htmlFor={`integration-stepup-${itemId}`}>{t('stepupCodeLabel')}</FieldLabel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Input
          id={`integration-stepup-${itemId}`}
          name="totpCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder=""
          required
          pattern="\d{6}"
          className="w-28 text-center font-mono"
        />
        <FieldDescription className="flex-1 basis-64">{t('stepupCodeHint')}</FieldDescription>
      </div>
    </FormItem>
  );
}
