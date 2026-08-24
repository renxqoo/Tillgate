/**
 * 架构门禁（机器锁定 DESIGN §3/§7 消费面与铁律 3/14 纪律）：
 *  - @tillgate/* 说明符白名单恰为 ui(. / .styles.css) 与 api-client(. / ./next)；
 *  - 全源码禁 @ai-gateway（旧仓残留零容忍）；
 *  - tsconfig paths 恰 @/*（禁止把 workspace 包映射回源码绕过 exports——v1 病灶）；
 *  - process.env 只许出现在 server/ 与 config/（features/app/i18n/middleware 禁直读 env）；
 *  - server/actions/*.ts 首行必须是 "use server"。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const TS_EXTS = ['.ts', '.tsx', '.mts'];
const allSrc = listFiles(SRC, TS_EXTS);
const rel = (p: string) => p.slice(SRC.length + 1);

const ALLOWED_SPECIFIERS = new Set([
  '@tillgate/ui',
  '@tillgate/ui/styles.css',
  '@tillgate/api-client',
  '@tillgate/api-client/next',
]);

function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

describe('apps/client 架构门禁', () => {
  it('src 下每个文件的 import 说明符里，@tillgate/* 只允许白名单两条依赖', () => {
    const offenders: string[] = [];
    for (const file of allSrc) {
      const text = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(text)) {
        if (spec.startsWith('@tillgate/') && !ALLOWED_SPECIFIERS.has(spec)) {
          offenders.push(`${rel(file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('全源码禁止 @ai-gateway 引用（旧仓残留零容忍）', () => {
    const offenders = allSrc.filter((f) => readFileSync(f, 'utf8').includes('@ai-gateway'));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('tsconfig paths 恰为 @/*（禁止 workspace 源码映射绕过 exports）', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'));
    expect(Object.keys(tsconfig.compilerOptions.paths)).toEqual(['@/*']);
    expect(tsconfig.compilerOptions.paths['@/*']).toEqual(['./src/*']);
  });

  it('process.env 只出现在 server/ 与 config/（features/app/i18n/middleware 禁直读）', () => {
    const offenders = allSrc.filter((f) => {
      const r = rel(f);
      if (r.startsWith('server/') || r.startsWith('config/')) return false;
      return readFileSync(f, 'utf8').includes('process.env');
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('server/actions/*.ts 首行必须是 "use server"', () => {
    const actionFiles = listFiles(join(SRC, 'server', 'actions'), ['.ts']);
    expect(actionFiles.length).toBeGreaterThan(0);
    const offenders = actionFiles.filter(
      (f) => !readFileSync(f, 'utf8').startsWith("'use server'"),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
});
