/**
 * RBAC 行操作按钮显隐契约（源码静态断言,与本目录既有源码断言用例同款装置）：
 * 编辑/删除入口必须挂按钮权限（admins:update / admins:delete——与 endpoint_bindings
 * 绑定码同源,前端藏掉的后端必 403,前端放行的后端必过）。
 * 覆盖五页：角色管理 / 权限资源 / 接口绑定 / 设置（2026-08-25 D1 裁决：
 * settings:update 时区写、settings:integrations 集成卡区操作位——SMTP 独立卡
 * 亦在其中）/ 营销（growth:update 保存钮）。显隐仅 UX,权威判定在 admin-api ACL。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const feature = (name: string) => join(import.meta.dirname, '..', 'src', 'features', 'rbac', name);
const settingsFeature = (name: string) =>
  join(import.meta.dirname, '..', 'src', 'features', 'settings', name);
const page = (name: string) =>
  join(import.meta.dirname, '..', 'src', 'app', '(main)', 'dashboard', name, 'page.tsx');

const src = (path: string) => readFileSync(path, 'utf8');

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('RBAC 行操作按钮权限显隐', () => {
  it('角色管理：编辑弹窗+菜单项挂 canUpdate,删除项挂 canDelete;皆无则占位 —', () => {
    // 目录化拆分后行操作住 index.tsx(见 rule/component-split.md)
    const s = src(join(feature('roles-content'), 'index.tsx'));
    // 弹窗渲染 + 菜单项两处守卫
    expect(count(s, '{canUpdate && (')).toBe(2);
    expect(count(s, '{canDelete && (')).toBe(1);
    expect(s).toContain('!canUpdate && !canDelete');
  });

  it('权限资源：编辑弹窗+菜单项挂 canUpdate,删除项挂 canDelete（子节点预检在内层）', () => {
    const s = src(join(feature('permissions-content'), 'index.tsx'));
    expect(count(s, '{canUpdate && (')).toBe(2);
    expect(count(s, '{canDelete && (')).toBe(1);
    expect(s).toContain('disabled={hasChildren}');
    expect(s).toContain('!canUpdate && !canDelete');
  });

  it('接口绑定：编辑弹窗+菜单项挂 canUpdate,解绑项挂 canDelete;皆无则占位 —', () => {
    const s = src(join(feature('bindings-content'), 'index.tsx'));
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

  it('设置页：server 端按 settings:update / settings:integrations 计算并下传（SMTP 独立卡后在集成卡区）', () => {
    const pageSrc = src(page('settings'));
    expect(pageSrc, '设置页缺时区写门控').toContain("hasPerm(me, 'settings:update')");
    expect(pageSrc, '设置页缺集成操作门控').toContain("hasPerm(me, 'settings:integrations')");
    const assembler = src(settingsFeature('index.tsx'));
    expect(assembler).toContain('canUpdate={canUpdateTimezone}');
    expect(assembler).toContain('canManage={canManageIntegrations}');
    // 2FA/TOTP 卡属 SELF 域不挂码——组装器不向其传任何权限布尔（二次裁决后亦无 SMTP 入口）
    expect(assembler).toContain('<EmailTwoFactorCard me={me} />');
    const timezone = src(settingsFeature('billing-timezone-card.tsx'));
    expect(timezone).toContain('{canUpdate ? ('); // 无权 → 只读展示,无选择器/保存钮
    const card = src(settingsFeature(join('integration-cards', 'integration-card.tsx')));
    expect(count(card, '{canManage ? (')).toBe(1); // 配置钮（标题行）
    expect(count(card, '{input.canManage ? (')).toBe(1); // 启停钮（ToggleRow）
  });

  it('营销页：growth:update 计算下传;无权保存钮隐藏且三输入禁用', () => {
    const pageSrc = src(page('marketing'));
    expect(pageSrc, '营销页缺 update 门控').toContain("hasPerm(me, 'growth:update')");
    const content = src(
      join(import.meta.dirname, '..', 'src', 'features', 'billing', 'marketing-content.tsx'),
    );
    expect(content).toContain('{canUpdate ? (');
    expect(count(content, 'disabled={!canUpdate}')).toBe(3);
  });
});
