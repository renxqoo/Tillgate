// 权限节点域共享件：类型词表与父子约束（纯函数，无 React 依赖）

import type { PermissionNode } from '@tillgate/api-client';

export type NodeType = 'group' | 'page' | 'button';

/** 展示排序：分组 → 页面 → 按钮 */
export const TYPE_ORDER: Record<NodeType, number> = { group: 0, page: 1, button: 2 };

/** 按节点类型取合法父选项(button→页面页,page→分组,group→无) */
export function parentOptionsOf(nodes: PermissionNode[], type: NodeType): PermissionNode[] {
  if (type === 'button') return nodes.filter((n) => n.type === 'page');
  if (type === 'page') return nodes.filter((n) => n.type === 'group');
  return [];
}
