/**
 * RBAC 行操作按钮显隐契约（源码静态断言,与本目录既有源码断言用例同款装置）：
 * 编辑/删除入口必须挂按钮权限（admins:update / admins:delete——与 endpoint_bindings
 * 绑定码同源,前端藏掉的后端必 403,前端放行的后端必过）。
 * 覆盖三页：角色管理 / 权限资源 / 接口绑定。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const feature = (name: string) => join(import.meta.dirname, '..', 'src', 'features', 'rbac', name);
const page = (name: string) =>
  join(import.meta.dirname, '..', 'src', 'app', '(main)', 'dashboard', name, 'page.tsx');

const src = (path: string) => readFileSync(path, 'utf8');

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('RBAC 行操作按钮权限显隐', () => {
  it('角色管理：编辑弹窗+菜单项挂 canUpdate,删除项挂 canDelete;皆无则占位 —', () => {
    const s = src(feature('roles-content.tsx'));
    // 弹窗渲染 + 菜单项两处守卫
    expect(count(s, '{canUpdate && (')).toBe(2);
    expect(count(s, '{canDelete && (')).toBe(1);
    expect(s).toContain('!canUpdate && !canDelete');
  });

  it('权限资源：编辑弹窗+菜单项挂 canUpdate,删除项挂 canDelete（子节点预检在内层）', () => {
    const s = src(feature('permissions-content.tsx'));
    expect(count(s, '{canUpdate && (')).toBe(2);
    expect(count(s, '{canDelete && (')).toBe(1);
    expect(s).toContain('disabled={hasChildren}');
    expect(s).toContain('!canUpdate && !canDelete');
  });

  it('接口绑定：编辑弹窗+菜单项挂 canUpdate,解绑项挂 canDelete;皆无则占位 —', () => {
    const s = src(feature('bindings-content.tsx'));
    expect(count(s, 'canUpdate && editing?.id === row.id')).toBe(1);
    expect(count(s, '{canUpdate && (')).toBe(1);
    expect(count(s, '{canDelete && (')).toBe(1);
    expect(s).toContain('canUpdate || canDelete ?');
  });

  it('三个页面按 admins:update / admins:delete 计算并下传', () => {
    for (const path of [page('roles'), page('permissions'), page('endpoints')]) {
      const s = src(path);
      expect(s, `${path} 缺 update 门控`).toContain("hasPerm(me, 'admins:update')");
      expect(s, `${path} 缺 delete 门控`).toContain("hasPerm(me, 'admins:delete')");
    }
  });
});
