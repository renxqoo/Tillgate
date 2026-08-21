/**
 * i18n 门禁（CI 步骤 + 本地 `bun run check:i18n`）：
 *
 * 1. CJK 零残留：apps/{client,admin}/src、packages/ui/src 的字符串字面量 /
 *    JSX 文本不得含中文（中文只允许出现在 messages/zh.json 与注释里）。
 *    基于 TypeScript AST 判定——注释/JSDoc 不误报。
 * 2. 目录键完备：两 app 的 en.json 与 zh.json 递归键完全一致（漏译即红）。
 * 3. ui 命名空间同源：两 app 目录的 ui 段必须逐字一致（共享组件依赖同一套键）。
 * 4. 引用键存在：源码里静态 t('key') 调用（含 t 别名）必须能解析到目录叶子键
 *    ——键拼错、命名空间错配直接红。动态键（变量/模板插值）不在静态可达范围。
 * 5. 消息可解析：全部目录值按 ICU 语法解析（intl-messageformat，与 next-intl 同核）
 *    ——未转义的 <tag>、非法语法直接红（运行时 INVALID_MESSAGE 提前到 CI）。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { IntlMessageFormat } from 'intl-messageformat';

const ROOT = path.resolve(import.meta.dir, '..');
const SCAN_ROOTS = [
  path.join(ROOT, 'apps/client/src'),
  path.join(ROOT, 'apps/admin/src'),
  path.join(ROOT, 'packages/ui/src'),
];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// 刻意保留的中文 UI 文案：语言切换器以目标语言原生书写呈现徽标（EN ↔ 中）
const ALLOWLIST: Record<string, Set<string>> = {
  'packages/ui/src/components/shell/header/locale-switcher.tsx': new Set(['中']),
};

let failures = 0;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 测试文件豁免：中文测试标题是仓库测试规范；fixture 里的 CJK（如 URL 编码用例）是功能性数据
      if (entry.name === '__tests__') continue;
      out.push(...listTsFiles(full));
    } else if (/\.test\.tsx?$/.test(entry.name)) continue;
    else if (/\.(tsx?|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 收集源文件中「会渲染/输出」的中文文本位置（跳过注释） */
function cjkInCode(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const hits: Array<{ line: number; text: string }> = [];

  const allowed = ALLOWLIST[path.relative(ROOT, file)];
  const check = (text: string, pos: number | undefined) => {
    if (!CJK.test(text)) return;
    if (allowed?.has(text.trim())) return;
    hits.push({
      line: pos === undefined ? 0 : source.getLineAndCharacterOfPosition(pos).line + 1,
      text: text.slice(0, 60),
    });
  };

  function walk(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node.text, node.getStart(source));
    } else if (ts.isTemplateExpression(node)) {
      // 模板串只查静态片段，插值表达式递归走正常访问
      check(node.head.text, node.head.getStart(source));
      for (const span of node.templateSpans) {
        check(span.literal.text, span.literal.getStart(source));
      }
    } else if (ts.isJsxText(node)) {
      check(node.getText(source), node.getStart(source));
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return hits;
}

for (const root of SCAN_ROOTS) {
  for (const file of listTsFiles(root)) {
    for (const hit of cjkInCode(file)) {
      failures += 1;
      console.error(`[cjk] ${path.relative(ROOT, file)}:${hit.line}  ${hit.text}`);
    }
  }
}

/** 递归取 JSON 键集合（点路径） */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix || '(root)'];
  return Object.entries(obj).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

function diffKeys(name: string, enKeys: Set<string>, zhKeys: Set<string>): void {
  for (const missing of [...enKeys].filter((k) => !zhKeys.has(k))) {
    failures += 1;
    console.error(`[catalog] ${name}: zh 缺键 ${missing}`);
  }
  for (const extra of [...zhKeys].filter((k) => !enKeys.has(k))) {
    failures += 1;
    console.error(`[catalog] ${name}: en 缺键 ${extra}`);
  }
}

type Catalog = Record<string, unknown>;
const loadCatalog = (app: string, locale: string): Catalog =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `apps/${app}/messages/${locale}.json`), 'utf8'));

const clientEn = loadCatalog('client', 'en');
const clientZh = loadCatalog('client', 'zh');
const adminEn = loadCatalog('admin', 'en');
const adminZh = loadCatalog('admin', 'zh');

diffKeys('client', new Set(keyPaths(clientEn)), new Set(keyPaths(clientZh)));
diffKeys('admin', new Set(keyPaths(adminEn)), new Set(keyPaths(adminZh)));

for (const locale of ['en', 'zh'] as const) {
  const a = loadCatalog('client', locale).ui;
  const b = loadCatalog('admin', locale).ui;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failures += 1;
    console.error(`[catalog] 两 app 的 ui 命名空间（${locale}）不一致——共享组件依赖同一套键`);
  }
}

// ── 4. 引用键存在性：静态 t('key') 调用 × 目录叶子路径 ──

/** 取对象的叶子点路径（数组段跳过——索引访问是动态键，静态检查不覆盖） */
function leafPaths(obj: unknown, prefix = '', out: Set<string> = new Set()): Set<string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** 在候选命名空间里取键对应的原始目录值（找不到返回 undefined） */
function findMessage(catalog: Catalog, namespaces: string[], key: string): unknown {
  for (const ns of namespaces) {
    let node: unknown = catalog[ns];
    if (node === undefined) continue;
    let ok = true;
    for (const part of key.split('.')) {
      if (node !== null && typeof node === 'object' && part in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[part];
      } else {
        ok = false;
        break;
      }
    }
    if (ok) return node;
  }
  return undefined;
}

interface FileRefs {
  /** 翻译器别名 → 候选命名空间集合（同文件多次绑定同名 t 时取并集，避免误判） */
  aliasNs: Map<string, Set<string>>;
  /** 无别名绑定（await getTranslations('ns') 直调等）收集到的命名空间 */
  looseNs: Set<string>;
  /** 静态键调用（翻译器名 + 键 + 行号 + t.rich 渲染函数名） */
  calls: Array<{ fn: string; key: string; line: number; richNames?: string[] }>;
}

const TRANSLATOR_FNS = new Set(['getTranslations', 'useTranslations']);

function collectI18nRefs(file: string): FileRefs {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const refs: FileRefs = { aliasNs: new Map(), looseNs: new Set(), calls: [] };

  function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
    return node === undefined ? undefined : ts.isAwaitExpression(node) ? unwrap(node.expression) : node;
  }

  function walk(node: ts.Node): void {
    // const X = getTranslations('ns') / useTranslations('ns') → 记录别名绑定
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const init = unwrap(node.initializer);
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        TRANSLATOR_FNS.has(init.expression.text) &&
        init.arguments.length > 0 &&
        ts.isStringLiteral(init.arguments[0])
      ) {
        {
          const set = refs.aliasNs.get(node.name.text) ?? new Set<string>();
          set.add(init.arguments[0].text);
          refs.aliasNs.set(node.name.text, set);
        }
      }
    }
    // getTranslations('ns') / useTranslations('ns')（含未赋值给变量的直调）
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TRANSLATOR_FNS.has(node.expression.text)) {
      if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        refs.looseNs.add(node.arguments[0].text);
      }
    }
    // t.rich('key', { name: (chunks) => ... })：记录渲染函数名（供目录值富文本标签核对）
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'rich' &&
      ts.isIdentifier(node.expression.expression) &&
      /^t([A-Z]\w*)?$/.test(node.expression.expression.text) &&
      node.arguments.length > 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      const richNames: string[] = [];
      for (const prop of node.arguments[1].properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
        ) {
          richNames.push(prop.name.text);
        }
      }
      refs.calls.push({
        fn: node.expression.expression.text,
        key: node.arguments[0].text,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        richNames,
      });
    }
    // t('key') / tUi('key')：翻译器名匹配 t 或 t 开头驼峰别名，首参为字符串字面量
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^t([A-Z]\w*)?$/.test(node.expression.text) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      !node.arguments[0].text.includes('${')
    ) {
      refs.calls.push({
        fn: node.expression.text,
        key: node.arguments[0].text,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return refs;
}

for (const app of ['client', 'admin'] as const) {
  const catalog = loadCatalog(app, 'en');
  const leafs = leafPaths(catalog);
  const appRoot = path.join(ROOT, `apps/${app}/src`);
  for (const file of listTsFiles(appRoot)) {
    const refs = collectI18nRefs(file);
    if (refs.calls.length === 0) continue;
    const rel = path.relative(ROOT, file);
    for (const call of refs.calls) {
      // 解析候选命名空间：显式别名优先，其次文件内全部绑定
      const aliasAll = [...refs.aliasNs.values()].flatMap((set) => [...set]);
      const candidates = refs.aliasNs.has(call.fn)
        ? [...refs.aliasNs.get(call.fn)!]
        : [...new Set([...aliasAll, ...refs.looseNs])];
      const resolved = candidates.some((ns) => leafs.has(`${ns}.${call.key}`));
      if (!resolved) {
        failures += 1;
        console.error(`[ref] ${rel}:${call.line}  ${call.fn}('${call.key}') 未解析到目录键（候选命名空间: ${candidates.join(', ') || '无绑定'}）`);
        continue;
      }
      // t.rich 交叉核对：目录值必须用 <name>…</name> 富文本标签（写 {name} 会把渲染函数当 child 注入，运行时崩溃）
      if (call.richNames && call.richNames.length > 0) {
        const message = findMessage(catalog, candidates, call.key);
        if (typeof message === 'string') {
          for (const name of call.richNames) {
            if (!message.includes(`<${name}`)) {
              failures += 1;
              console.error(`[rich] ${rel}:${call.line}  ${call.fn}.rich('${call.key}') 的 '${name}' 渲染函数在目录值中无 <${name}> 标签（当前值疑似用了 {${name}} 占位符）`);
            }
          }
        }
      }
    }
  }
}

// ── 5. ICU 消息可解析（提前拦截运行时 INVALID_MESSAGE）──
for (const app of ['client', 'admin'] as const) {
  for (const locale of ['en', 'zh'] as const) {
    const catalog = loadCatalog(app, locale);
    const checkParse = (obj: unknown, prefix: string): void => {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          checkParse(v, p);
        } else if (typeof v === 'string') {
          try {
            // 占位符按 ICU 语法安全存在；plurals 等完整语法由解析器校验
            new IntlMessageFormat(v, locale === 'zh' ? 'zh-CN' : 'en-US');
          } catch (e) {
            failures += 1;
            console.error(`[parse] apps/${app}/messages/${locale}.json ${p}: ${(e as Error).message.split('\n')[0]}`);
          }
        }
      }
    };
    checkParse(catalog, '');
  }
}

if (failures > 0) {
  console.error(`\ncheck:i18n 失败：${failures} 处（中文只允许出现在 zh.json 与注释；目录键须完备且 ui 段同源；静态 t() 引用键必须存在；ICU 消息须可解析）`);
  process.exit(1);
}
console.log('check:i18n 通过：无 CJK 字面量残留，目录键完备，ui 段同源，静态引用键可解析，ICU 消息合法');
