import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';
import { dirname, resolve } from 'node:path';

import { findWorkspace } from '../utils.ts';

// 相对 import 不得越出所在 workspace 根(阻止用 ../ 绕过 exports),
// 并禁止指向 apps/ 目录的深路径 import。
// 迁移自 scripts/check-package-boundaries.ts 的 [escape-import]/[app-import] 检查;
// 文件不在 workspace 内时不检查。

export default defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Relative imports must stay inside the current workspace root and must not reach into apps/.',
    },
    messages: {
      escape:
        "Relative import '{{spec}}' escapes the {{workspace}} workspace root; import via package exports instead.",
      'app-path':
        "Import '{{spec}}' references the apps tree directly; apps are not importable by path.",
    },
  },
  create,
});

function create(context: Context) {
  const source = findWorkspace(context.filename);
  if (source === null) return {};
  // 闭包内不保留 null 收窄,提前解构为非空局部量
  const { dir: workspaceDir, name: workspaceName } = source;

  function check(spec: string, node: ESTree.Node): void {
    if (spec.startsWith('.')) {
      const resolved = resolve(dirname(context.filename), spec);
      if (resolved !== workspaceDir && !resolved.startsWith(`${workspaceDir}/`)) {
        context.report({ node, messageId: 'escape', data: { spec, workspace: workspaceName } });
      }
      return;
    }
    if (spec.startsWith('apps/') || spec.includes('/apps/')) {
      context.report({ node, messageId: 'app-path', data: { spec } });
    }
  }

  function literalSource(
    node: ESTree.Node,
    sourceNode: ESTree.Expression | null | undefined,
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
