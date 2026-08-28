import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

// 一文件一组件/hook:判断 .tsx 内是否存在两个及以上的组件/hook 定义,
// 规范依据 rule/component-split.md §2。判定采用 React 社区通行命名启发式:
// useXxx 视为 hook,大写开头视为组件;非函数初始化的大写常量不在此列。
// .ts 文件合法承载多个纯函数与 hook,不受本规则约束。

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const HOOK_PATTERN = /^use[A-Z]/;
const COMPONENT_PATTERN = /^[A-Z]/;
const ANONYMOUS_FUNCTION = '(anonymous)';

function isFunctionLike(node: ESTree.Node | null | undefined): node is FunctionNode {
  if (node === null || node === undefined) return false;
  const { type } = node;
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ArrowFunctionExpression'
  );
}

// 命中启发式则返回该名字,否则返回 null
function componentName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  if (HOOK_PATTERN.test(name) || COMPONENT_PATTERN.test(name)) return name;
  return null;
}

function readMax(options: Context['options']): number {
  const first: unknown = options[0];
  if (typeof first === 'object' && first !== null && 'max' in first) {
    const max: unknown = first.max;
    if (typeof max === 'number' && Number.isInteger(max) && max >= 1) return max;
  }
  return 1;
}

// 沿 parent 链返回 fnNode 最近一层外层函数的显示名;无外层函数(模块顶层)返回 null。
// 名字来源:声明 id,或上一层(箭头/匿名函数)的 VariableDeclarator id / Property key。
function enclosingFunctionName(fnNode: FunctionNode): string | null {
  let current: ESTree.Node | null = fnNode.parent;
  while (current !== null && !isFunctionLike(current)) {
    current = current.parent;
  }
  if (current === null) return null;

  const ownName = current.type === 'ArrowFunctionExpression' ? null : (current.id?.name ?? null);
  if (ownName !== null) return ownName;
  const owner = current.parent;
  if (owner?.type === 'VariableDeclarator' && owner.id.type === 'Identifier') {
    return owner.id.name;
  }
  if (owner?.type === 'Property' && owner.key.type === 'Identifier') {
    return owner.key.name;
  }
  return ANONYMOUS_FUNCTION;
}

function create(context: Context) {
  if (!context.filename.endsWith('.tsx')) return {};
  const max = readMax(context.options);
  const seen = new Set<number>();
  const state = { count: 0, previous: null as string | null };

  function collect(name: string, fnNode: FunctionNode, reportNode: ESTree.Node): void {
    // const X = function X() {} 会同时命中 VariableDeclarator 与 FunctionExpression
    // 两条访问路径,按函数节点起始位置去重,同一函数只计一次。
    if (seen.has(fnNode.range[0])) return;
    seen.add(fnNode.range[0]);
    state.count += 1;

    const outer = enclosingFunctionName(fnNode);
    if (outer !== null) {
      context.report({ node: reportNode, messageId: 'nested', data: { name, outer } });
      return;
    }
    if (state.count > max) {
      context.report({
        node: reportNode,
        messageId: 'exceed',
        data: { name, index: state.count, previous: state.previous, max },
      });
    }
    state.previous = name;
  }

  return {
    FunctionDeclaration(node: ESTree.Function): void {
      const name = componentName(node.id?.name);
      if (name !== null) collect(name, node, node);
    },
    FunctionExpression(node: ESTree.Function): void {
      const name = componentName(node.id?.name);
      if (name !== null) collect(name, node, node);
    },
    VariableDeclarator(node: ESTree.VariableDeclarator): void {
      if (node.id.type !== 'Identifier' || !isFunctionLike(node.init)) return;
      const name = componentName(node.id.name);
      if (name !== null) collect(name, node.init, node);
    },
  };
}

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce at most one component/hook definition per .tsx file, per rule/component-split.md.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ max: 1 }],
    messages: {
      exceed:
        "'{{name}}' is component/hook #{{index}} in this file (after '{{previous}}'); at most {{max}} allowed. Split into separate files per rule/component-split.md (one verb, one file).",
      nested:
        "'{{name}}' is defined inside '{{outer}}'; nested component/hook definitions are re-created on every render. Hoist it to module scope or move it to its own file.",
    },
  },
  create,
});
