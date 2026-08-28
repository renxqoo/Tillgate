import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import {
  findWorkspace,
  loadWorkspaces,
  repoRootOf,
  targetNameOf,
  wantedSubpath,
} from '../utils.ts';

// @tillgate/* import 边界:子路径必须命中目标包 package.json 的显式 exports,
// 禁止 @tillgate/x/src 深导入与未登记子路径;packages 不得 import apps。
// 迁移自 scripts/check-package-boundaries.ts 的 [deep-import]/[unknown-import] 检查,
// AST 解析替代原正则,动态 import() 同样覆盖;文件不在 workspace 内时不检查。

export default defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Internal @tillgate/* imports must hit an explicit exports subpath of the target package.',
    },
    messages: {
      unknown:
        "Import '{{spec}}' does not match any @tillgate/* workspace; check the package name.",
      deep: "Import '{{spec}}' bypasses the explicit exports of {{target}}; use a subpath registered in its package.json exports ({{registered}}).",
      'pkg-to-app':
        'Package {{source}} must not import app {{target}}; dependencies may not point from packages to apps.',
    },
  },
  create,
});

function create(context: Context) {
  const source = findWorkspace(context.filename);
  if (source === null) return {};
  // 闭包内不保留 null 收窄,提前解构为非空局部量
  const { dir: sourceDir, name: sourceName, isApp: sourceIsApp } = source;
  const targets = loadWorkspaces(repoRootOf(sourceDir));

  function check(spec: string, node: ESTree.Node): void {
    if (!spec.startsWith('@tillgate/')) return;
    const targetName = targetNameOf(spec);
    const target = targets.get(targetName);
    if (target === undefined) {
      context.report({ node, messageId: 'unknown', data: { spec } });
      return;
    }
    if (!sourceIsApp && target.isApp) {
      context.report({
        node,
        messageId: 'pkg-to-app',
        data: { source: sourceName, target: target.name },
      });
      return;
    }
    if (!target.exports.has(wantedSubpath(spec))) {
      const registered = [...target.exports].join(', ');
      context.report({
        node,
        messageId: 'deep',
        data: { spec, target: target.name, registered: registered === '' ? 'none' : registered },
      });
    }
  }

  function literalSource(
    node:
      | ESTree.ImportDeclaration
      | ESTree.ExportAllDeclaration
      | ESTree.ExportNamedDeclaration
      | ESTree.ImportExpression,
    sourceNode: ESTree.Expression | null,
  ): void {
    if (sourceNode === null || sourceNode === undefined) return;
    if (sourceNode.type !== 'Literal' || typeof sourceNode.value !== 'string') return;
    check(sourceNode.value, node);
  }

  return {
    ImportDeclaration: (node: ESTree.ImportDeclaration) => literalSource(node, node.source),
    ExportAllDeclaration: (node: ESTree.ExportAllDeclaration) => literalSource(node, node.source),
    ExportNamedDeclaration: (node: ESTree.ExportNamedDeclaration) =>
      literalSource(node, node.source),
    ImportExpression: (node: ESTree.ImportExpression) => literalSource(node, node.source),
  };
}
