// 纯净性门禁(机器锁定): src 及其依赖闭包禁止 Next 专有依赖、workspace 兄弟包、
// 测试依赖与样式后门外挂——这是 P7「纯 React 设计系统」的可执行边界
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(import.meta.dirname, '../..');
const SRC_DIR = join(PKG_ROOT, 'src');

// 禁止出现在 src import 说明符里的模块前缀(总纲 §3/P7 + 本包 DESIGN 裁决)
const FORBIDDEN_SPECIFIERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^next(\/|$)/, reason: 'Next.js 专有依赖' },
  { pattern: /^next-themes$/, reason: 'Next 主题库(用本包 ThemeProvider)' },
  { pattern: /^next-intl$/, reason: 'Next i18n 框架' },
  { pattern: /^geist$/, reason: 'Next 字体库(用 @fontsource-variable)' },
  { pattern: /^@tillgate\//, reason: 'ui 禁止依赖 workspace 兄弟包(含 api-client)' },
  { pattern: /^vitest$/, reason: '测试依赖不得进入运行时源码' },
  { pattern: /^@testing-library\//, reason: '测试依赖不得进入运行时源码' },
];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  const importRe =
    /import\s+(?:type\s+)?[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importRe)) {
    specifiers.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return specifiers;
}

function relative(file: string): string {
  return file.replace(`${PKG_ROOT}/`, '');
}

describe('src 依赖纯净性', () => {
  const files = walk(SRC_DIR);

  it('扫描到源码文件(防目录漂移导致空跑)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('所有 import 说明符不含禁止模块', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of extractImports(source)) {
        const hit = FORBIDDEN_SPECIFIERS.find((rule) => rule.pattern.test(specifier));
        if (hit) {
          violations.push(`${relative(file)}: "${specifier}" (${hit.reason})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json 依赖闭包不含 Next 生态', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    const forbiddenDeps: string[] = [];
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        const hit = FORBIDDEN_SPECIFIERS.slice(0, 4).find((rule) => rule.pattern.test(name));
        if (hit) {
          forbiddenDeps.push(`${section}: ${name}`);
        }
      }
    }
    expect(forbiddenDeps).toEqual([]);
  });

  it('react/react-dom 以 peer 声明(devDeps 仅供本地测试)', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.peerDependencies)).toEqual(
      expect.arrayContaining(['react', 'react-dom']),
    );
  });
});
