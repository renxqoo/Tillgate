/**
 * 架构边界门禁：
 * 目录与出口约定不靠记忆，靠本测试执行。规则：
 * ① 分层白名单——domain 零基础设施（drizzle/pg/@tillgate/db 禁入）；
 *    application 零 SQL（drizzle 只允许出现在 adapters/postgres/**）；
 * ② 出口面封闭——index.ts / billing.ts / wallet.ts / settlement.ts 不泄漏
 *    Db/DbTx/drizzle 符号（文本级 + 导出符号扫描）；
 * ③ 账本零 round——src/domain 与 src/application 除登记豁免外不得出现
 *    toFixed/Math.round/round( 调用；
 * ④ 业务代码不 import ./composition（装配便捷件仅 app assembly 消费）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

interface SourceFile {
  readonly path: string; // 相对 src/
  readonly imports: string[];
  readonly code: string; // 剥注释后的代码面
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

/** 剥离块注释与行注释（符号检查不因注释误报） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 基础设施导入判定（分层白名单①：pg/drizzle/@tillgate/db 全家族） */
function isInfraImport(spec: string): boolean {
  return (
    spec === 'pg' ||
    spec === 'drizzle-orm' ||
    spec.startsWith('drizzle-orm/') ||
    spec === '@tillgate/db'
  );
}

/** drizzle 家族判定（全包唯一居所 = adapters/postgres） */
function isDrizzleImport(spec: string): boolean {
  return spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/');
}

const ROUND_PATTERNS: RegExp[] = [/\.toFixed\s*\(/, /Math\.round\s*\(/, /\bround\s*\(/];

/** 行是否命中 round 模式 */
function matchesRoundPattern(line: string): boolean {
  return ROUND_PATTERNS.some((p) => p.test(line));
}

/** 行是否命中登记豁免（lineIncludes 未指定 = 整文件豁免） */
function isExemptLine(
  line: string,
  exemptions: Array<{ file: string; lineIncludes?: string }>,
): boolean {
  return exemptions.some((e) => (e.lineIncludes ? line.includes(e.lineIncludes) : true));
}

const files: SourceFile[] = walk(srcDir).map((path) => {
  const source = readFileSync(`${srcDir}/${path}`, 'utf-8');
  return {
    path,
    imports: [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => defined(m[1])),
    code: stripComments(source),
  };
});

/** 源码文本的导出名提取(声明式导出 + 列表导出双形态;模块级纯函数) */
function exportedNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(
    /export\s+(?:declare\s+)?(?:type|interface|const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g,
  )) {
    names.push(defined(m[1]));
  }
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of defined(m[1]).split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('① 分层白名单（DESIGN §1 依赖方向的可执行形态）', () => {
  it('domain：零 drizzle/pg/@tillgate/db（仅 errors/decimal.js/node: 内建/域内相对引用）', () => {
    for (const f of files.filter((x) => x.path.startsWith('domain/'))) {
      for (const spec of f.imports) {
        expect(isInfraImport(spec), `${f.path} → ${spec}`).toBe(false);
      }
    }
  });

  it('application：零 SQL——不 import drizzle/pg/@tillgate/db（drizzle 只在 adapters/postgres/**）', () => {
    for (const f of files.filter((x) => x.path.startsWith('application/'))) {
      for (const spec of f.imports) {
        expect(isInfraImport(spec), `${f.path} → ${spec}`).toBe(false);
      }
    }
    // drizzle 的全包唯一居所：adapters/postgres（实现层）
    const drizzleHomes = files.filter((f) => f.imports.some(isDrizzleImport)).map((f) => f.path);
    expect(
      drizzleHomes.every((p) => p.startsWith('adapters/postgres/')),
      drizzleHomes.join(', '),
    ).toBe(true);
  });
});

describe('② 出口面封闭（§5.3：facade 与契约类型，不泄漏基础设施）', () => {
  const EXPOSED_ROOTS = ['index.ts', 'billing.ts', 'wallet.ts', 'settlement.ts'];

  it('文本级：不出现 Db/DbTx/drizzle 符号（签名零基础设施类型）', () => {
    for (const name of EXPOSED_ROOTS) {
      const { code } = defined(files.find((f) => f.path === name));
      expect(code.includes('DbTx'), name).toBe(false);
      expect(code.includes('drizzle'), name).toBe(false);
      expect(/\bDb\b/.test(code), name).toBe(false);
    }
  });

  it('导出符号扫描：导出名不含 Db/DbTx/drizzle', () => {
    for (const name of EXPOSED_ROOTS) {
      const { code } = defined(files.find((f) => f.path === name));
      for (const symbol of exportedNames(code)) {
        const banned = symbol === 'Db' || symbol === 'DbTx' || /drizzle/i.test(symbol);
        expect(banned, `${name} exports ${symbol}`).toBe(false);
      }
    }
  });

  it('运行时出口：index 的值导出键零基础设施符号', async () => {
    const mod = await import('../src/index.js');
    for (const key of Object.keys(mod)) {
      const banned = key === 'Db' || key === 'DbTx' || /drizzle/i.test(key);
      expect(banned, `index runtime export ${key}`).toBe(false);
    }
  });
});

describe('③ 账本零 round（DESIGN §4.5「零 round 架构锁死」）', () => {
  /**
   * 登记豁免（唯一合法例外；新增豁免必须在此登记并写明理由）：
   * - usage-projection.ts 投影系数 toFixed(3)：usage_logs 列的展示精度约定，
   *   非资金运算（资金金额全精度走 money.Decimal）；
   * - money.ts 序列化：金额值对象的出口序列化防线（当前实现零 round，
   *   登记防将来误引入时绕过扫描）。
   */
  const ROUND_EXEMPTIONS: Array<{ file: string; lineIncludes?: string }> = [
    { file: 'application/settlement/usage-projection.ts', lineIncludes: 'toFixed(3)' },
    { file: 'domain/money.ts' },
  ];

  it('src/domain 与 src/application 除登记豁免外零 toFixed/Math.round/round(', () => {
    const scanned = files.filter(
      (f) => f.path.startsWith('domain/') || f.path.startsWith('application/'),
    );
    expect(scanned.length).toBeGreaterThan(50); // 扫描面存在性自检
    for (const f of scanned) {
      const exemptions = ROUND_EXEMPTIONS.filter((e) => e.file === f.path);
      const lines = f.code.split('\n').filter((line) => {
        if (!matchesRoundPattern(line)) return false;
        // 豁免行剔除：登记文件的指定行（未指定 lineIncludes = 整文件豁免）
        return !isExemptLine(line, exemptions);
      });
      expect(lines, `${f.path}: ${lines.join(' | ')}`).toEqual([]);
    }
  });
});

describe('④ 装配单向（composition 只被 app assembly 消费）', () => {
  it('业务代码不 import ./composition（含 root 出口与各层）', () => {
    for (const f of files) {
      if (f.path === 'composition.ts') continue;
      for (const spec of f.imports) {
        const banned = /(^|\/)composition(\.js)?$/.test(spec);
        expect(banned, `${f.path} → ${spec}`).toBe(false);
      }
    }
  });
});
