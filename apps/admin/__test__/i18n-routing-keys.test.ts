import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** routing 模块 i18n key 守护：t('...') 字面量（含带参调用）⊆ messages.zh/en 的 routing 段（双向对照） */
const FEATURE_DIR = join(__dirname, '../src/features/routing');
const PAGE = join(__dirname, '../src/app/(main)/dashboard/routing/page.tsx');

/** 参与扫描的文件：页面 + features/routing 全部 .tsx（哑件与编排器都算） */
function routingFiles(): string[] {
  const dirFiles = readdirSync(FEATURE_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(FEATURE_DIR, f));
  return [PAGE, ...dirFiles].filter(
    (file, index, all) => all.indexOf(file) === index, // 路径去重（页面在独立目录不会重复，防御未来移动）
  );
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of routingFiles()) {
    const src = readFileSync(file, 'utf8');
    // 收字面量 t('key') 与带参 t('key', {...})——动态 t(variable)（如
    // validateForm 的 field 标签键）无法静态守护，靠 bounds/表单测试间接受理
    for (const m of src.matchAll(/\bt\('([a-zA-Z]\w*)'(?:\s*,[^;]*?)?\)/g)) keys.add(m[1] ?? '');
  }
  return keys;
}

function routingSection(locale: 'zh' | 'en'): Set<string> {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../messages/${locale}.json`), 'utf8'),
  ) as Record<string, Record<string, unknown>>;
  return new Set(Object.keys(messages.routing ?? {}));
}

describe('i18n routing key 守护', () => {
  it('t() 字面量（含带参）⊆ messages.routing（zh/en 同键集；缺失会 NEXT_INTL 运行时崩溃）', () => {
    const zh = routingSection('zh');
    const en = routingSection('en');
    expect([...zh].toSorted()).toEqual([...en].toSorted()); // 两语言键集一致
    const used = usedKeys();
    const missing = [...used].filter((k) => !zh.has(k));
    expect(missing, `missing keys: ${missing.join(', ')}`).toEqual([]);
  });
});
