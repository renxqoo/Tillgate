/**
 * 架构边界门禁：
 *   ① workspace 依赖白名单——apps/admin 运行时只准 @tillgate/{ui,api-client}；
 *   ② 禁 @tillgate 深导入（src 直连）；
 *   ③ 页面（src/app）不得引用 server 内部模块（唯一例外：*-actions 动词）；
 *   ④ client 组件（"use client" 文件）禁止 import @tillgate/api-client/next
 *      （BFF 子出口带 next/headers——进浏览器包即构建期炸，这里静态先行拦截；
 *      client 侧 locale 常量走 app 自持 @/lib/locale，与 api-client 侧同值孪生）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defined } from './defined';

const SRC = join(import.meta.dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p: string) => relative(join(SRC, '..'), p);

const WORKSPACE_IMPORT = /from ['"]@tillgate\/([a-z-]+)(\/[^'"]*)?['"]/g;
const ALLOWED_PACKAGES = new Set(['ui', 'api-client']);
const ALLOWED_SUBENTRY: Record<string, Set<string>> = {
  ui: new Set(['']), // 仅根出口（设计系统纪律：组件经根出口消费）
  'api-client': new Set(['', '/next']),
};

describe('apps/admin 架构边界', () => {
  it('workspace import 白名单：仅 ui 与 api-client（零能力包直依赖，总纲 P5）', () => {
    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(WORKSPACE_IMPORT)) {
        const pkg = m[1] as string;
        const sub = m[2] ?? '';
        if (!ALLOWED_PACKAGES.has(pkg)) {
          violations.push(`${rel(f)} → @tillgate/${pkg}${sub}`);
        } else if (!defined(ALLOWED_SUBENTRY[pkg], 'ALLOWED_SUBENTRY[pkg]').has(sub)) {
          violations.push(`${rel(f)} → 非法子出口 @tillgate/${pkg}${sub}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('禁 @tillgate 深导入（src 直连）', () => {
    const violations = files
      .map((f) => [f, readFileSync(f, 'utf8')] as const)
      .filter(([, src]) => /@tillgate\/[a-z-]+\/src/.test(src))
      .map(([f]) => rel(f));
    expect(violations).toEqual([]);
  });

  it('页面层不引用 server 内部（例外：动词文件 *-actions 与 layout 守卫）', () => {
    const violations: string[] = [];
    for (const f of files.filter((p) => rel(p).startsWith('src/app/'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from ['"](@\/server\/[^'"]+)['"]/g)) {
        const target = defined(m[1], 'm[1]').replace('@/server/', '');
        const allowed =
          target.endsWith('-actions') ||
          target === 'admin-api' ||
          target === 'get-admin' ||
          target === 'admin-list' ||
          target === 'auth-actions';
        if (!allowed) violations.push(`${rel(f)} → ${m[1]}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('client 组件禁 import @tillgate/api-client/next（BFF 专用，含 next/headers）', () => {
    const violations: string[] = [];
    for (const f of files.filter((p) => p.endsWith('.tsx'))) {
      const src = readFileSync(f, 'utf8');
      if (!src.startsWith('"use client"') && !src.startsWith("'use client'")) continue;
      if (/from ['"]@tillgate\/api-client\/next['"]/.test(src)) {
        violations.push(rel(f));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('零旧仓残留（@ai-gateway 引用清零）', () => {
    const violations = files
      .filter((f) => /@ai-gateway/.test(readFileSync(f, 'utf8')))
      .map((f) => rel(f));
    expect(violations).toEqual([]);
  });

  it('受控 Select 必带 items（Base UI 无 items 时 Value 回显原始值而非标签——原型级坑，静态锁死）', () => {
    const violations: string[] = [];
    for (const f of files.filter((p) => p.endsWith('.tsx'))) {
      const src = readFileSync(f, 'utf8').replace(/=>/g, '==');
      for (const m of src.matchAll(/<Select\b[^>]*>/g)) {
        if (m[0].includes('value=') && !m[0].includes('items=')) {
          violations.push(`${rel(f)}:${src.slice(0, m.index ?? 0).split('\n').length}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
