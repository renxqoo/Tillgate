/**
 * i18n 门禁：en/zh 词表 key 树全等（双语对齐是行为规格——漏译即 UI 缺字）；
 * 代码中实际使用的命名空间 ⊆ 词表顶层命名空间。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defined } from './defined';

const MESSAGES = join(import.meta.dirname, '..', 'messages');
const SRC = join(import.meta.dirname, '..', 'src');
const en: Record<string, unknown> = JSON.parse(readFileSync(join(MESSAGES, 'en.json'), 'utf8'));
const zh: Record<string, unknown> = JSON.parse(readFileSync(join(MESSAGES, 'zh.json'), 'utf8'));

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') keys.push(...flatten(value as never, path));
    else keys.push(path);
  }
  return keys;
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

describe('i18n 词表门禁', () => {
  it('en 与 zh 的 key 树全等', () => {
    expect(flatten(zh)).toEqual(flatten(en));
  });

  it('代码中使用的命名空间都在词表内（未知命名空间 = 运行时整段缺字）', () => {
    const files = listFiles(SRC, ['.ts', '.tsx']);
    const used = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/[ug]etTranslations\(\s*['"]([^'"]+)['"]/g)) {
        used.add(defined(m[1], 'regex match[1]'));
      }
    }
    expect([...used].toSorted()).toEqual([...used].filter((ns) => ns in en).toSorted());
  });
});
