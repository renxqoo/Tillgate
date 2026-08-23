'use client';

import { useTranslations } from 'next-intl';

import { CopyButton } from '@tokenlens/ui';

/**
 * GitHub 风格代码框：顶栏（语言标签 + 复制按钮）+ shiki 双主题高亮体。
 * html 由服务端 highlight() 生成；亮暗切换靠 globals.css 的 .shiki 变量规则。
 */
export function CodeBlock({
  lang,
  html,
  text,
}: {
  lang?: string;
  html: string;
  text: string;
}) {
  const tUi = useTranslations('ui');
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang ?? 'shell'}
        </span>
        <CopyButton value={text} copyLabel={tUi('copy')} className="h-6 px-2 text-xs" />
      </div>
      <div
        className="code-block-body overflow-x-auto text-xs"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
