'use client';

import { Button, Input } from '@tillgate/ui';
import { Loader2Icon, StoreIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** 导入动作区：渠道未就绪时补录密钥 + 导入按钮（pending/选中计数受控，提交回调上抛） */
export function CatalogImportArea({
  needsKey,
  channelReady,
  sourceName,
  apiKey,
  onApiKeyChange,
  pending,
  selectedCount,
  sourceKind,
  onImport,
}: {
  needsKey: boolean;
  channelReady: boolean;
  sourceName: string;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  pending: boolean;
  selectedCount: number;
  sourceKind: 'channel' | 'reference';
  onImport: () => void;
}) {
  const t = useTranslations('modelMarket');
  return (
    <div className="ml-auto flex items-center gap-2">
      {needsKey && !channelReady ? (
        <Input
          type="password"
          placeholder={t('apiKeyPlaceholder', { source: sourceName })}
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          className="w-72"
        />
      ) : null}
      <Button disabled={pending || selectedCount === 0} onClick={onImport}>
        {pending ? <Loader2Icon className="mr-1 animate-spin" /> : <StoreIcon className="mr-1" />}
        {sourceKind === 'reference'
          ? t('importDraftCount', { count: selectedCount })
          : t('importSelectedCount', { count: selectedCount })}
      </Button>
    </div>
  );
}
