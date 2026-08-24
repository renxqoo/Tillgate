/**
 * 零覆盖模块补测（CI coverage 门禁欠账清偿——只补测试不降阈值）:
 * rbac/binding/totp/settings 四组 server actions 全分支、get-admin 守卫与
 * 菜单解析、menu-icons/locale/theme-boot 纯函数。装置复用 server-actions harness。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockCookieJar, mockFetch, type FetchCall } from './harness';

async function loadModule(path: string, responses: Array<{ status?: number; body?: unknown }>) {
  vi.resetModules();
  const { fetchStub, calls } = mockFetch(responses);
  vi.stubGlobal('fetch', fetchStub);
  const stubs = installNextStubs();
  const mod = await import(path);
  return { mod, calls, ...stubs };
}

function last(calls: FetchCall[]): FetchCall {
  return calls[calls.length - 1]!;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.doUnmock('next/headers');
  vi.doUnmock('next/cache');
  vi.doUnmock('next/navigation');
  vi.doUnmock('next-intl/server');
});

describe('rbac-actions 全分支', () => {
  it('角色三动作:成功 wire 形状 + errorKey 透传 + 网络失败回落', async () => {
    const { mod, calls } = await loadModule('../src/server/rbac-actions', [
      { status: 201, body: { id: 1 } },
      { status: 200, body: { id: 1 } },
    ]);
    expect(await mod.createRoleAction({ code: 'r', name: '角', permissions: [] })).toEqual({});
    expect(last(calls)).toMatchObject({ method: 'POST', url: 'http://localhost:8082/v1/roles' });
    expect(await mod.updateRoleAction(1, { name: 'n', status: 1, permissions: ['users:read'] })).toEqual({});
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: 'http://localhost:8082/v1/roles/1' });

    // errorKey 透传(control_plane.* 短码)
    const { mod: m3 } = await loadModule('../src/server/rbac-actions', [
      { status: 409, body: { error: { code: 'control_plane.role_in_use', message: 'x' } } },
    ]);
    expect(await m3.deleteRoleAction(1)).toEqual({ errorKey: 'role_in_use' });

    // 网络失败 → error 文案(非 errorKey)
    const { mod: m4 } = await loadModule('../src/server/rbac-actions', [{ status: 500, body: null }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('down');
      }),
    );
    const res = await m4.deleteRoleAction(1);
    expect(res.error).toBeTruthy();
    expect(res.errorKey).toBeUndefined();
  });

  it('权限三动作:成功 + 守卫矩阵 errorKey(has_children/in_use/code_taken/invalid)', async () => {
    const { mod } = await loadModule('../src/server/rbac-actions', [{ status: 200, body: {} }]);
    expect(
      await mod.updatePermissionAction(9, { name: 'n', status: 1, type: 'page', parentId: 2 }),
    ).toEqual({});

    for (const [code, invoke] of [
      ['permission_has_children', () => mod.deletePermissionAction(9)],
      ['permission_in_use', () => mod.deletePermissionAction(9)],
      ['permission_code_taken', () => mod.updatePermissionAction(9, { code: 'x:y' })],
      ['invalid_permission_input', () => mod.updatePermissionAction(9, { status: 9 as never })],
    ] as const) {
      vi.resetModules();
      vi.stubGlobal(
        'fetch',
        mockFetch([{ status: 409, body: { error: { code: `control_plane.${code}`, message: 'x' } } }])
          .fetchStub,
      );
      const fresh = await import('../src/server/rbac-actions');
      expect(await invoke.call(fresh as never), code).toMatchObject({ errorKey: code });
    }

    const { mod: okMod } = await loadModule('../src/server/rbac-actions', [{ status: 200, body: {} }]);
    expect(await okMod.deletePermissionAction(9)).toEqual({});
    expect(
      await okMod.createPermissionAction({
        parentId: 1,
        type: 'button',
        code: 'x:y',
        name: 'n',
        sortOrder: 0,
      }),
    ).toEqual({});
  });
});

describe('binding-actions 全分支', () => {
  it('create/update/delete:成功 + errorKey(endpoint_bound/endpoint_not_found/invalid) + 网络回落', async () => {
    const { mod } = await loadModule('../src/server/binding-actions', [
      { status: 201, body: { id: 5 } },
      { status: 200, body: { id: 5 } },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await mod.createBindingAction({ method: 'GET', path: '/v1/x', permissionId: 1 }),
    ).toEqual({});
    expect(await mod.updateBindingAction(5, { method: 'POST', path: '/v1/y' })).toEqual({});
    expect(await mod.deleteBindingAction(5)).toEqual({});

    for (const code of ['endpoint_bound', 'endpoint_not_found', 'invalid_endpoint_input'] as const) {
      const { mod: m } = await loadModule('../src/server/binding-actions', [
        { status: 409, body: { error: { code: `control_plane.${code}`, message: 'x' } } },
      ]);
      expect(await m.updateBindingAction(5, { path: '/v1/z' })).toMatchObject({ errorKey: code });
    }

    const { mod: net } = await loadModule('../src/server/binding-actions', [{ status: 200, body: null }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('down');
      }),
    );
    const res = await net.createBindingAction({ method: 'GET', path: '/v1/x', permissionId: 1 });
    expect(res.error).toBeTruthy();
  });
});

describe('totp-actions 全分支', () => {
  it('enroll:成功含服务端渲染 qrSvg;ApiError 上浮;网络回落', async () => {
    const { mod } = await loadModule('../src/server/totp-actions', [
      { status: 200, body: { secret: 'S', otpauthUrl: 'otpauth://totp/x' } },
    ]);
    const res = await mod.enrollTotpAction();
    expect(res.enrollment?.secret).toBe('S');
    expect(res.enrollment?.qrSvg).toContain('<svg');

    const { mod: m2 } = await loadModule('../src/server/totp-actions', [
      { status: 409, body: { error: { code: 'x', message: '已绑定' } } },
    ]);
    expect((await m2.enrollTotpAction()).error).toBe('已绑定');

    const { mod: m3 } = await loadModule('../src/server/totp-actions', [{ status: 200, body: null }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('down');
      }),
    );
    expect((await m3.enrollTotpAction()).error).toBe('fetchError');
  });

  it('confirm/disable:码形状拦截(6 数字/10 大写字母数字合法,其余拒);成功与失败', async () => {
    const { mod } = await loadModule('../src/server/totp-actions', [
      { status: 200, body: { recoveryCodes: ['A', 'B'] } },
    ]);
    expect((await mod.confirmTotpAction('bad')).error).toBe('invalidCode');
    expect((await mod.disableTotpAction('12')).error).toBe('invalidCode');
    expect(await mod.confirmTotpAction('123456')).toEqual({ recoveryCodes: ['A', 'B'] });

    const { mod: m2 } = await loadModule('../src/server/totp-actions', [
      { status: 400, body: { error: { code: 'x', message: '验码失败' } } },
    ]);
    expect((await m2.confirmTotpAction('ABCDEF1234')).error).toBe('验码失败');

    const { mod: m3 } = await loadModule('../src/server/totp-actions', [
      { status: 200, body: { ok: true } },
    ]);
    expect(await m3.disableTotpAction('ABCDEF1234')).toEqual({ ok: true });
  });
});

describe('settings-actions 计费时区', () => {
  it('读:成功透传;失败回落 null+unavailable;写:PUT 形状,失败原样抛', async () => {
    const { mod } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { timezone: 'Asia/Shanghai' } },
    ]);
    expect(await mod.getBillingTimezoneAction()).toEqual({ timezone: 'Asia/Shanghai' });

    const { mod: m2, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { ok: true } },
    ]);
    expect(await m2.updateBillingTimezoneAction('UTC')).toEqual({ ok: true });
    expect(last(calls)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/settings/billing-timezone',
      body: { timezone: 'UTC' },
    });

    const { mod: m3 } = await loadModule('../src/server/settings-actions', [
      { status: 500, body: { error: { code: 'x', message: '炸' } } },
    ]);
    expect(await m3.getBillingTimezoneAction()).toEqual({ timezone: null, error: 'unavailable' });
  });
});

describe('get-admin 守卫与菜单解析', () => {
  async function loadGetAdmin(
    responses: Array<{ status?: number; body?: unknown }>,
    navKeys: string[] = ['nav.groupSystem', 'nav.users'],
  ) {
    // 自带全套桩（每路径单次注册）——requireMenus 的 t.has 需自定义 i18n 桩,
    // 叠加 installNextStubs 的同路径 doMock 在 doUnmock 后不可靠
    vi.resetModules();
    const { fetchStub, calls } = mockFetch(responses);
    vi.stubGlobal('fetch', fetchStub);
    const { jar } = mockCookieJar();
    const known = new Set(navKeys);
    const redirectCalls: string[] = [];
    vi.doMock('next/headers', () => ({
      cookies: async () => jar,
      headers: async () => new Map([['accept-language', 'en']]),
    }));
    vi.doMock('next/cache', () => ({ revalidatePath: () => undefined }));
    vi.doMock('next/navigation', () => ({
      redirect: (path: string) => {
        redirectCalls.push(path);
        throw Object.assign(new Error(`redirect:${path}`), { __redirect: path });
      },
    }));
    vi.doMock('next-intl/server', () => ({
      getTranslations: async () =>
        Object.assign((key: string) => key, {
          has: (key: string) => known.has(key),
        }) as never,
      getLocale: async () => 'en',
    }));
    const mod = await import('../src/server/get-admin');
    return { mod, calls, redirectCalls };
  }

  const meBody = {
    id: 9,
    email: 'ops@x.dev',
    displayName: null,
    lastLoginAt: null,
    role: { id: 2, code: 'viewer', name: '只读', isSuper: false },
    permissions: ['users:read'],
  };

  it('userFromAdminMe:displayName 回落 email;hasPerm 三态', async () => {
    const { mod } = await loadGetAdmin([{ status: 200, body: meBody }]);
    expect(mod.userFromAdminMe(meBody as never).name).toBe('ops@x.dev');
    expect(mod.hasPerm(meBody as never, 'users:read')).toBe(true);
    expect(mod.hasPerm(meBody as never, 'users:update')).toBe(false);
    expect(mod.hasPerm({} as never, 'users:read')).toBe(false);
  });

  it('requireAdmin:200 回 me;401 redirect /login', async () => {
    const { mod, redirectCalls } = await loadGetAdmin([{ status: 200, body: meBody }]);
    expect((await mod.requireAdmin()).id).toBe(9);

    const { mod: m2, redirectCalls: rc2 } = await loadGetAdmin([{ status: 401, body: {} }]);
    await expect(m2.requireAdmin()).rejects.toMatchObject({ __redirect: '/login' });
    expect(rc2).toContain('/login');
  });

  it('requirePermission:持码放行;缺码 redirect /dashboard', async () => {
    const { mod, redirectCalls } = await loadGetAdmin([{ status: 200, body: meBody }]);
    expect((await mod.requirePermission('users:read')).id).toBe(9);
    expect(redirectCalls).toHaveLength(0);

    const { mod: m2, redirectCalls: rc2 } = await loadGetAdmin([{ status: 200, body: meBody }]);
    await expect(m2.requirePermission('admins:read')).rejects.toMatchObject({
      __redirect: '/dashboard',
    });
    expect(rc2).toContain('/dashboard');
  });

  it('requireMenus:i18n_key 命中走词条,未命中回落 DB name', async () => {
    const menusBody = {
      groups: [
        {
          id: 1,
          i18nKey: 'nav.groupSystem',
          name: '系统管理',
          items: [
            { name: '用户', path: '/dashboard/users', icon: 'Users', id: 10 },
            { name: '自定义页', path: null, icon: null, id: 11 },
          ],
        },
      ],
    };
    const { mod } = await loadGetAdmin([{ status: 200, body: menusBody }]);
    const groups = await mod.requireMenus();
    expect(groups[0]!.label).toBe('nav.groupSystem'); // 命中词条
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['用户', '自定义页']);
    expect(groups[0]!.items[0]).toMatchObject({ path: '/dashboard/users', icon: 'Users' });

    // 词条未命中(nav.groupSystem 不在已知集)→ 回落 DB name
    const { mod: m2 } = await loadGetAdmin([{ status: 200, body: menusBody }], []);
    expect((await m2.requireMenus())[0]!.label).toBe('系统管理');
  });
});

describe('config/lib 纯函数补零', () => {
  it('menuIconOf:已知名命中;未知名与 null 兜底 ChartBar', async () => {
    const { menuIconOf } = await import('../src/config/menu-icons');
    expect(menuIconOf('Users')).toBeTruthy();
    expect(menuIconOf('Plug')).toBeTruthy();
    expect(menuIconOf('NotExist')).toBeTruthy(); // 兜底组件
    expect(menuIconOf(null)).toBeTruthy();
    expect(menuIconOf(undefined)).toBeTruthy();
  });

  it('isLocale:en/zh 收;其余与空拒', async () => {
    const { isLocale, LOCALES, LOCALE_COOKIE } = await import('../src/lib/locale');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect([...LOCALES]).toEqual(['en', 'zh']);
    expect(LOCALE_COOKIE).toBe('NEXT_LOCALE');
  });

  it('getThemeBootCode:含 storage key 与媒体查询,幂等', async () => {
    const { getThemeBootCode } = await import('../src/config/theme-boot');
    const code = getThemeBootCode();
    expect(code).toContain("localStorage.getItem('theme')");
    expect(code).toContain('(prefers-color-scheme: dark)');
    expect(getThemeBootCode()).toBe(code);
  });
});

describe('admins-actions 全分支', () => {
  it('create:成功;emailTaken 短码文案;他码 ApiError 上浮;网络回落', async () => {
    const { mod } = await loadModule('../src/server/admins-actions', [
      { status: 201, body: {} },
      { status: 409, body: { error: { code: 'control_plane.admin_email_taken', message: 'x' } } },
      { status: 400, body: { error: { code: 'y', message: '参数错' } } },
    ]);
    expect(await mod.createAdminAction({ email: 'a@b.c', password: '12345678', roleId: 1 })).toEqual({});
    expect((await mod.createAdminAction({ email: 'a@b.c', password: '12345678', roleId: 1 })).error).toBe('emailTaken');
    expect((await mod.createAdminAction({ email: 'a@b.c', password: '12345678', roleId: 1 })).error).toBe('参数错');

    const { mod: net } = await loadModule('../src/server/admins-actions', []);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
    expect((await net.createAdminAction({ email: 'a@b.c', password: '12345678', roleId: 1 })).error).toBe('createFailed');
  });

  it('updateRole/toggleStatus:成功 + ApiError 上浮', async () => {
    const { mod, calls } = await loadModule('../src/server/admins-actions', [
      { status: 200, body: {} },
      { status: 403, body: { error: { code: 'x', message: '不可自改' } } },
      { status: 200, body: {} },
      { status: 404, body: { error: { code: 'x', message: '不存在' } } },
    ]);
    expect(await mod.updateAdminRoleAction(7, 2)).toEqual({});
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: 'http://localhost:8082/v1/admins/7', body: { roleId: 2 } });
    expect((await mod.updateAdminRoleAction(7, 2)).error).toBe('不可自改');
    expect(await mod.toggleAdminStatusAction(7, 1)).toEqual({});
    expect((await mod.toggleAdminStatusAction(7, 1)).error).toBe('不存在');
  });
});

describe('password-actions 全分支', () => {
  const okInput = { oldPassword: 'old12345', newPassword: 'new12345', confirmPassword: 'new12345' };

  it('校验拦截(required/mismatch/tooShort)不发请求;成功换 token', async () => {
    const { mod, calls } = await loadModule('../src/server/password-actions', [
      { status: 200, body: { token: 'fresh' } },
    ]);
    expect((await mod.changeMyPasswordAction({ ...okInput, oldPassword: '' })).error).toBe('errors.required');
    expect((await mod.changeMyPasswordAction({ ...okInput, confirmPassword: 'zzz' })).error).toBe('errors.mismatch');
    expect((await mod.changeMyPasswordAction({ ...okInput, newPassword: '123', confirmPassword: '123' })).error).toBe('errors.tooShort');
    expect(calls).toHaveLength(0);
    expect(await mod.changeMyPasswordAction(okInput)).toEqual({});
    expect(last(calls)).toMatchObject({ method: 'POST', url: 'http://localhost:8082/v1/me/password' });
  });

  it('ApiError 上浮;网络回落 fetchError', async () => {
    const { mod } = await loadModule('../src/server/password-actions', [
      { status: 400, body: { error: { code: 'x', message: '旧密码错误' } } },
    ]);
    expect((await mod.changeMyPasswordAction(okInput)).error).toBe('旧密码错误');
    const { mod: net } = await loadModule('../src/server/password-actions', []);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
    expect((await net.changeMyPasswordAction(okInput)).error).toBe('fetchError');
  });
});

describe('cookies-actions 全分支', () => {
  it('get/set 缺省与显式 options', async () => {
    const { mod } = await loadModule('../src/server/cookies-actions', []);
    expect(await mod.getValueFromCookie('missing')).toBeUndefined();
    await mod.setValueToCookie('k', 'v');
    await mod.setValueToCookie('k2', 'v2', { path: '/x', maxAge: 10 });
    expect(await mod.getValueFromCookie('k')).toBe('v');
  });
});

describe('totp 网络失败补支', () => {
  it('disable 网络失败回落 fetchError', async () => {
    const { mod } = await loadModule('../src/server/totp-actions', []);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
    expect((await mod.disableTotpAction('123456')).error).toBe('fetchError');
  });
});
