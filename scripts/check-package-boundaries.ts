/**
 * 仓库级包边界门禁(总纲 §5.5 / P0:目录约定必须由机器验证,进 CI 即 test 链)。
 * 检查项:
 * 1. package graph 无环(内部 workspace 依赖 DFS);
 * 2. packages/* 不得依赖 apps/*;
 * 3. 跨包 import 只能命中目标 package 的显式 exports 子路径(禁止 @tillgate/x/src 深导入
 *    与未登记子路径);
 * 4. 相对 import 不得越出所在 workspace 根(阻止用 ../ 绕过 exports);
 * 5. 根 tsconfig paths 不得把 @tillgate/* 映射回源码(阻止 alias 绕过 exports)。
 * 用法:bun scripts/check-package-boundaries.ts(违规输出清单并 exit 1)。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

interface Workspace {
  name: string;
  dir: string;
  exports: Set<string>; // exports 字段的键('.'、'./composition' 等)
  internalDeps: Set<string>; // @tillgate/* 依赖(deps+devDeps+peerDeps)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function listDirs(glob: string): string[] {
  const base = join(ROOT, glob.replace('/*', ''));
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(base, e.name));
}

/** 从 package.json 三类依赖字段收集 @tillgate/* 依赖 */
function internalDepsOf(pkg: Record<string, unknown>): Set<string> {
  const internalDeps = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps != null && typeof deps === 'object') {
      for (const dep of Object.keys(deps as Record<string, unknown>)) {
        if (dep.startsWith('@tillgate/')) internalDeps.add(dep);
      }
    }
  }
  return internalDeps;
}

const workspaceDirs = [...listDirs('packages/*'), ...listDirs('apps/*')];
const workspaces: Workspace[] = [];
const byName = new Map<string, Workspace>();

for (const dir of workspaceDirs) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = readJson(pkgPath);
  const name = pkg.name as string;
  const exports = new Set<string>();
  const exp = pkg.exports;
  if (typeof exp === 'string') {
    exports.add('.');
  } else if (exp != null && typeof exp === 'object') {
    for (const key of Object.keys(exp as Record<string, unknown>)) exports.add(key);
  }
  const internalDeps = internalDepsOf(pkg);
  const ws: Workspace = { name, dir, exports, internalDeps };
  workspaces.push(ws);
  byName.set(name, ws);
}

const appNames = new Set(
  workspaces.filter((w) => w.dir.includes(`${ROOT}/apps/`)).map((w) => w.name),
);
const violations: string[] = [];

// ---- 1/2. 依赖图:无环 + packages 不依赖 apps ----
{
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(workspaces.map((w) => [w.name, WHITE] as const));
  const stack: string[] = [];

  const visit = (name: string): void => {
    const state = color.get(name);
    if (state === GRAY) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ');
      violations.push(`[cycle] ${cycle}`);
      return;
    }
    if (state === BLACK) return;
    color.set(name, GRAY);
    stack.push(name);
    const ws = byName.get(name);
    if (ws != null) {
      for (const dep of ws.internalDeps) {
        if (dep === name) violations.push(`[self-loop] ${name}`);
        else visit(dep);
      }
    }
    stack.pop();
    color.set(name, BLACK);
  };
  for (const w of workspaces) visit(w.name);

  for (const w of workspaces) {
    const isPackage = w.dir.includes(`${ROOT}/packages/`);
    if (!isPackage) continue;
    for (const dep of w.internalDeps) {
      if (appNames.has(dep)) {
        violations.push(`[pkg→app] ${w.name} 依赖 app ${dep}(禁止反向)`);
      }
      if (!byName.has(dep)) {
        violations.push(`[unknown-dep] ${w.name} 依赖不存在的 workspace ${dep}`);
      }
    }
  }
}

// ---- 3/4. 源码 import 扫描(exports 命中 + 相对路径越界) ----
function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @tillgate/* import 检查:子路径必须命中目标包的显式 exports */
function checkInternalImport(spec: string, file: string): void {
  const rest = spec.slice('@tillgate/'.length);
  // split 恒返回非空数组;空段(形如 '@tillgate/')落入 unknown-import 口径
  const pkgShort = rest.split('/')[0] ?? '';
  const target = byName.get(`@tillgate/${pkgShort}`);
  if (target == null) {
    violations.push(`[unknown-import] ${relative(ROOT, file)} → ${spec}(非 workspace 包)`);
    return;
  }
  const subpath = rest.slice(pkgShort.length).replace(/^\/+/, '');
  const wanted = subpath === '' ? '.' : `./${subpath}`;
  if (!target.exports.has(wanted)) {
    violations.push(
      `[deep-import] ${relative(ROOT, file)} → ${spec}(未命中 ${target.name} 的显式 exports;已登记: ${[...target.exports].join(', ') || '无'})`,
    );
  }
}

function checkFile(file: string, ws: Workspace): void {
  const source = readFileSync(file, 'utf-8');
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec == null) continue;
    if (spec.startsWith('@tillgate/')) {
      checkInternalImport(spec, file);
      continue;
    }
    if (spec.startsWith('.')) {
      const fromDir = resolve(file, '..');
      const resolved = resolve(fromDir, spec);
      const wsRoot = resolve(ws.dir);
      if (!resolved.startsWith(`${wsRoot}/`) && resolved !== wsRoot) {
        violations.push(`[escape-import] ${relative(ROOT, file)} → ${spec}(越出 ${ws.name} 根)`);
      }
      continue;
    }
    if (spec.startsWith('apps/') || spec.includes('/apps/')) {
      violations.push(`[app-import] ${relative(ROOT, file)} → ${spec}`);
    }
  }
}

for (const ws of workspaces) {
  for (const sub of ['src', '__test__', 'test']) {
    const dir = join(ws.dir, sub);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const file of walkTs(dir)) checkFile(file, ws);
    }
  }
}

// ---- 5. tsconfig paths 不得映射 @tillgate/* 回源码 ----
for (const tsconfigPath of [join(ROOT, 'tsconfig.base.json'), join(ROOT, 'tsconfig.next.json')]) {
  if (!existsSync(tsconfigPath)) continue;
  const raw = readFileSync(tsconfigPath, 'utf-8');
  if (/"(?:paths)"[\s\S]*?@tillgate\//.test(raw)) {
    violations.push(
      `[alias-bypass] ${relative(ROOT, tsconfigPath)} 的 paths 含 @tillgate/* 源码映射`,
    );
  }
}

if (violations.length > 0) {
  console.error(`包边界门禁失败(${violations.length} 项):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`包边界门禁通过:${workspaces.length} 个 workspace,图无环,深导入/越界/alias 绕过为零。`);
