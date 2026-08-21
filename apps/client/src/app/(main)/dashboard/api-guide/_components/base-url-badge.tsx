'use client';

import { useEffect, useState } from 'react';

import { CopyButton } from '@ai-gateway/ui/components/shell/copy-button';

/**
 * 当前部署的推理 Base URL（面板与网关同域：生产由 nginx 分流 /v1，
 * dev 由 Next rewrites 转发）——用户照这个地址 + 自己的 Key 调用。
 */
export function BaseUrlBadge() {
  const [base, setBase] = useState('https://<你的域名>/v1');
  useEffect(() => {
    setBase(`${window.location.origin}/v1`);
  }, []);
  return (
    <div className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
      <span className="text-xs text-muted-foreground">Base URL</span>
      <code className="text-xs font-medium">{base}</code>
      <CopyButton text={base} label="复制" className="h-6 px-2 text-xs" />
    </div>
  );
}
