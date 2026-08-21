'use client';

import { useTranslations } from 'next-intl';

import { CopyButton } from '@ai-gateway/ui/components/shell/copy-button';

/**
 * 推理 Base URL 徽章：值由服务端从请求 Host 推导后传入（与页内全部示例同源，
 * 用户复制任何示例都不需要再改域名）。
 */
export function BaseUrlBadge({ base }: { base: string }) {
  const tUi = useTranslations('ui');
  return (
    <div className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
      <span className="text-xs text-muted-foreground">Base URL</span>
      <code className="text-xs font-medium">{base}</code>
      <CopyButton text={base} label={tUi('copy')} className="h-6 px-2 text-xs" />
    </div>
  );
}
