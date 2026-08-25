/**
 * 凭据表单提交方式契约（安全回归，2026-08-25）：features/auth 的所有 <form>
 * 必须声明 method="post"——React 注水前用户按回车会触发原生提交，缺省
 * method=GET 会把 email/password 拼进 URL（nginx access log、浏览器历史、
 * 代理层留痕；实测 GET /login?email=...&password=...）。注水后 onSubmit
 * 拦截不受影响；method 只约束预水合的原生提交走 POST 体。
 * 页面侧配套防线：/login 的 stripAuthParams 307 清洗（仅善后，防不了日志）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const authDir = join(import.meta.dirname, '..', 'src', 'features', 'auth');

/** 提取源码中全部 <form …> 开标签（多行标签原样截取到 '>'） */
function formTags(source: string): string[] {
  const tags: string[] = [];
  let i = 0;
  while ((i = source.indexOf('<form', i)) >= 0) {
    const end = source.indexOf('>', i);
    tags.push(source.slice(i, end));
    i = end;
  }
  return tags;
}

describe('auth 表单 method=post 契约', () => {
  it('features/auth 下每个 <form> 开标签都声明 method="post"（预水合提交不进 URL）', () => {
    const files = readdirSync(authDir).filter((f) => f.endsWith('.tsx'));
    let checked = 0;
    for (const name of files) {
      const tags = formTags(readFileSync(join(authDir, name), 'utf8'));
      for (const tag of tags) {
        expect(tag, `${name} 缺 method="post": ${tag.slice(0, 60)}…`).toContain('method="post"');
        checked += 1;
      }
    }
    expect(checked, '守护面缩小：auth 表单数少于现状 6').toBeGreaterThanOrEqual(6);
  });
});
