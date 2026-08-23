/**
 * shiki 服务端高亮（api-guide 专用）：
 * - 双主题 github-light / github-dark，defaultColor:false 输出 CSS 变量
 *   （--shiki-light/--shiki-dark），实际颜色由 globals.css 按 .dark 类切换
 * - highlighter 进程级单例（首次加载词表约百毫秒，之后每块 ~1ms）
 */
import { createHighlighter, type Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: ['bash', 'python', 'javascript'],
  });
  return highlighterPromise;
}

/** 显示标签 → shiki 语言 id（标签给人读，高亮按正规语言走） */
function shikiLang(label: string | undefined): string {
  const l = (label ?? 'bash').toLowerCase();
  if (l.startsWith('python')) return 'python';
  if (l.startsWith('javascript')) return 'javascript';
  return 'bash';
}

export async function highlight(code: string, label?: string): Promise<string> {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, {
    lang: shikiLang(label),
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
}
