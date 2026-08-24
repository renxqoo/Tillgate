/**
 * 更新资源节点（全字段——用户裁决放开 enforced 锁与「码即身份」不可改;
 * 结构合法性仍强制校验:码形状/全局唯一(排除自身)/父子类型一致/group 无码/
 * source 与 status 词表）。误改 enforced 码的后果:路由 guard 仍查代码侧注册表,
 * DB 码漂移只影响角色可绑定性——超管 isSuper 免疫,可自行改回(启动对账降级告警)。
 */
import { controlPlaneErrors } from '../../errors';
import type { PermissionNode } from '../../ports/rbac-store';
import type { UpdatePermissionRow } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,30}:[a-z][a-z0-9_-]{1,31}$/;

/** 类型→合法父类型（group 顶层） */
const PARENT_TYPE: Record<'group' | 'page' | 'button', 'group' | 'page' | null> = {
  group: null,
  page: 'group',
  button: 'page',
};

export async function updatePermission(
  deps: RbacDeps,
  input: UpdatePermissionRow,
): Promise<PermissionNode> {
  const node = await deps.stores.permission.findById(deps.db, input.id);
  if (node == null) {
    throw controlPlaneErrors.business('permission_not_found', { id: input.id });
  }
  const next = {
    ...node,
    ...('name' in input && input.name !== undefined ? { name: input.name } : {}),
    ...('i18nKey' in input && input.i18nKey !== undefined ? { i18nKey: input.i18nKey } : {}),
    ...('description' in input && input.description !== undefined
      ? { description: input.description }
      : {}),
    ...('icon' in input && input.icon !== undefined ? { icon: input.icon } : {}),
    ...('path' in input && input.path !== undefined ? { path: input.path } : {}),
    ...('sortOrder' in input && input.sortOrder !== undefined
      ? { sortOrder: input.sortOrder }
      : {}),
    ...('status' in input && input.status !== undefined ? { status: input.status } : {}),
    ...('code' in input && input.code !== undefined ? { code: input.code } : {}),
    ...('type' in input && input.type !== undefined ? { type: input.type } : {}),
    ...('parentId' in input && input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...('source' in input && input.source !== undefined ? { source: input.source } : {}),
  };

  if (next.name.trim() === '') {
    throw controlPlaneErrors.business('invalid_permission_input', {});
  }
  if (next.status !== 0 && next.status !== 1) {
    throw controlPlaneErrors.business('invalid_permission_input', { status: next.status });
  }
  if (next.source !== 'enforced' && next.source !== 'custom') {
    throw controlPlaneErrors.business('invalid_permission_input', { source: next.source });
  }
  // 码形状:button 必码;page 可码(有则须合法);group 无码
  if (next.type === 'button' && (next.code == null || !CODE_PATTERN.test(next.code))) {
    throw controlPlaneErrors.business('invalid_permission_input', { code: next.code ?? null });
  }
  if (next.type === 'page' && next.code != null && !CODE_PATTERN.test(next.code)) {
    throw controlPlaneErrors.business('invalid_permission_input', { code: next.code });
  }
  if (next.type === 'group' && next.code != null) {
    throw controlPlaneErrors.business('invalid_permission_input', { code: next.code });
  }
  // 码改动的全局唯一性(排除自身)
  if (next.code !== node.code && next.code != null) {
    if (await deps.stores.permission.codeTaken(deps.db, next.code)) {
      throw controlPlaneErrors.business('permission_code_taken', { code: next.code });
    }
  }
  // 父子一致性(类型未变也复验——parentId 改动或类型改动交叉)
  const expectedParent = PARENT_TYPE[next.type];
  if (expectedParent == null) {
    if (next.parentId != null) {
      throw controlPlaneErrors.business('invalid_permission_input', {
        parentRequired: null,
        type: next.type,
      });
    }
  } else {
    if (next.parentId == null) {
      throw controlPlaneErrors.business('invalid_permission_input', {
        parentRequired: next.type,
      });
    }
    const parent = await deps.stores.permission.findById(deps.db, next.parentId);
    if (parent == null) {
      throw controlPlaneErrors.business('permission_not_found', { id: next.parentId });
    }
    if (parent.type !== expectedParent) {
      throw controlPlaneErrors.business('invalid_permission_input', {
        parentType: parent.type,
        expected: expectedParent,
      });
    }
  }

  const updated = await deps.stores.permission.update(deps.db, {
    id: input.id,
    ...('name' in input ? { name: next.name } : {}),
    ...('i18nKey' in input ? { i18nKey: next.i18nKey } : {}),
    ...('description' in input ? { description: next.description } : {}),
    ...('icon' in input ? { icon: next.icon } : {}),
    ...('path' in input ? { path: next.path } : {}),
    ...('sortOrder' in input ? { sortOrder: next.sortOrder } : {}),
    ...('status' in input ? { status: next.status } : {}),
    ...('code' in input ? { code: next.code } : {}),
    ...('type' in input ? { type: next.type } : {}),
    ...('parentId' in input ? { parentId: next.parentId } : {}),
    ...('source' in input ? { source: next.source } : {}),
  });
  if (updated == null) {
    throw controlPlaneErrors.business('permission_not_found', { id: input.id });
  }
  return updated;
}
