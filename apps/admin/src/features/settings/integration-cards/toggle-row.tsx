// 启停按钮 + 状态行（哑件：独立集成卡与 OAuth 组合卡行共用）

import { Button } from '@tillgate/ui';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function ToggleRow(input: {
  enabled: boolean;
  configured: boolean;
  pending: boolean;
  totpEnabled: boolean;
  stepupTitle: string | undefined;
  onRequestToggle: () => void;
}) {
  const t = useTranslations('settings.integrations');
  return (
    <div className="flex items-center gap-3">
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
