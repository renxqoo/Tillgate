'use client';

import { Button } from '@tillgate/ui';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** 启停按钮 + 状态行（哑件拆分——主组件复杂度收口）；canManage=false 只渲染状态行 */
export function ToggleRow(input: {
  enabled: boolean;
  configured: boolean;
  pending: boolean;
  totpEnabled: boolean;
  stepupTitle: string | undefined;
  onRequestToggle: () => void;
  canManage: boolean;
}) {
  const t = useTranslations('settings.integrations');
  return (
    <div className="flex items-center gap-3">
      {input.canManage ? (
        <Button
          variant={input.enabled ? 'destructive' : 'default'}
          size="sm"
          disabled={input.pending || !input.totpEnabled || (!input.enabled && !input.configured)}
          title={input.stepupTitle}
          onClick={input.onRequestToggle}
        >
          {input.pending && <Loader2Icon className="animate-spin" />}
          {input.enabled ? t('disable') : t('enable')}
        </Button>
      ) : null}
      <span className="text-sm text-muted-foreground">
        <span className={input.enabled ? 'text-green-600' : ''}>
          {input.enabled ? t('enabledState') : t('disabledState')}
        </span>
        <span className="mx-1">·</span>
        <span>{input.configured ? t('configuredState') : t('unconfiguredState')}</span>
      </span>
    </div>
  );
}
