'use client';

import { Button, FieldDescription, FormItem } from '@tillgate/ui';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** SMTP 连接测试行（仅 smtp 弹窗渲染——连接+认证校验；不提交表单、不走 step-up） */
export function SmtpTestField({
  testing,
  onTest,
}: {
  testing: boolean;
  onTest: (form: HTMLFormElement) => void;
}) {
  const t = useTranslations('settings.integrations');
  return (
    <FormItem>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          variant="outline"
          disabled={testing}
          onClick={(e) => {
            const form = e.currentTarget.closest('form');
            if (form != null) onTest(form);
          }}
        >
          {testing ? <Loader2Icon className="animate-spin" /> : null}
          {testing ? t('testing') : t('testConnection')}
        </Button>
        <FieldDescription className="flex-1 basis-64">{t('testHint')}</FieldDescription>
      </div>
    </FormItem>
  );
}
