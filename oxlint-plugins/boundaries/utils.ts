import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// boundaries 插件共享的 workspace 发现与 exports 查表,
// 迁移自 scripts/check-package-boundaries.ts 的逐文件 import 检查部分。
// workspace 定位依赖本仓布局约定:workspace 只有一层(apps/*、packages/*),不嵌套。

export interface TargetWorkspace {
  name: string;
  dir: string;
  isApp: boolean;
  exports: Set<string>;
}

export interface SourceWorkspace {
  dir: string;
  name: string;
  isApp: boolean;
}

/** 从 lint 文件路径向上找所在 workspace:父目录名为 apps/ 或 packages/ 的目录即根 */
export function findWorkspace(filename: string): SourceWorkspace | null {
  let dir = dirname(filename);
  for (;;) {
    const group = basename(dirname(dir));
    if (group === 'apps' || group === 'packages') break;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  const cached = sourceCache.get(dir);
  if (cached !== undefined) return cached;
  const pkg = readPackageJson(join(dir, 'package.json'));
  const info: SourceWorkspace = {
    dir,
    name: typeof pkg.name === 'string' ? pkg.name : basename(dir),
    isApp: basename(dirname(dir)) === 'apps',
  };
  sourceCache.set(dir, info);
  return info;
}

/** 仓库根 = workspace 根往上两级(apps/admin → 仓库根) */
export function repoRootOf(workspaceDir: string): string {
  return dirname(dirname(workspaceDir));
}

/** 目标 workspace 查表(按包名),按仓库根缓存;只读,进程内复用 */
export function loadWorkspaces(root: string): Map<string, TargetWorkspace> {
  const cached = workspacesCache.get(root);
  if (cached !== undefined) return cached;
  const map = new Map<string, TargetWorkspace>();
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(base, entry.name);
      const pkg = readPackageJson(join(dir, 'package.json'));
      const { name } = pkg;
      if (typeof name !== 'string') continue;
      map.set(name, { name, dir, isApp: group === 'apps', exports: exportsOf(pkg) });
    }
  }
  workspacesCache.set(root, map);
  return map;
}

/** '@tillgate/ui/composition' → 目标包名 '@tillgate/ui' */
export function targetNameOf(spec: string): string {
  const short = spec.slice('@tillgate/'.length).split('/')[0] ?? '';
  return `@tillgate/${short}`;
}

/** '@tillgate/ui/composition' → 想要命中的 exports 键 './composition';根导入 → '.' */
export function wantedSubpath(spec: string): string {
  const rest = spec.slice('@tillgate/'.length);
  const short = rest.split('/')[0] ?? '';
  const subpath = rest.slice(short.length).replace(/^\/+/, '');
  return subpath === '' ? '.' : `./${subpath}`;
}

const sourceCache = new Map<string, SourceWorkspace>();
const workspacesCache = new Map<string, Map<string, TargetWorkspace>>();

function readPackageJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/** exports 字段规范化为子路径键集合,与 scripts 门禁口径一致 */
function exportsOf(pkg: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const exp = pkg.exports;
  if (typeof exp === 'string') {
    keys.add('.');
  } else if (exp != null && typeof exp === 'object') {
    for (const key of Object.keys(exp)) keys.add(key);
  }
  return keys;
}
