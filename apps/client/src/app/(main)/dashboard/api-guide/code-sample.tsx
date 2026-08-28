import { CodeBlock } from '@/features/public/code-block';
import { highlight } from '@/features/public/highlight';

/** 服务端高亮包装：原始 code 供复制，shiki html 供展示 */
export async function CodeSample({ code, lang }: { code: string; lang?: string }) {
  const html = await highlight(code, lang);
  return <CodeBlock lang={lang} html={html} text={code} />;
}
