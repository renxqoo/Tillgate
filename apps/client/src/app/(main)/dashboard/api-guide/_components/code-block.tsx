'use client';

import { CopyButton } from '@ai-gateway/ui/components/shell/copy-button';

/** 代码示例块：右上角复制按钮，长代码横向滚动 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="relative rounded-md border bg-muted/40">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang ?? 'bash'}
        </span>
        <CopyButton text={code} label="复制" className="h-6 px-2 text-xs" />
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
