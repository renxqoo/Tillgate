/**
 * 告警通知渠道页列表消费（回归）：GET /v1/notifications 契约是裸数组
 * （openapi + routes-notifications.test.ts 双锁），页面曾按 {rows}/{list} 信封误读，
 * 导致「创建成功提示但列表恒空」。此处直调 RSC 页面组件，断言裸数组整行透传进 DataTable。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockFetch } from './harness';

/** React 元素形态（服务端组件直调返回的纯对象树，不渲染 DOM） */
interface ElementLike {
  type: unknown;
  props: { children?: unknown } & Record<string, unknown>;
}

/** 深度收集后代元素（children 可为元素/数组/文本/null） */
function collectElements(node: unknown, out: ElementLike[] = []): ElementLike[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node == null || typeof node !== 'object' || !('type' in node) || !('props' in node)) {
    return out;
  }
  const el = node as ElementLike;
  out.push(el);
  collectElements(el.props.children, out);
  return out;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.doUnmock('next/headers');
  vi.doUnmock('next/cache');
  vi.doUnmock('next/navigation');
  vi.doUnmock('next-intl/server');
  vi.doUnmock('@/server/get-admin');
});

describe('通知渠道页（R-9：裸数组消费）', () => {
  it('GET 返回裸数组（含 email 渠道行）→ DataTable.rows 整行透传，不丢数据', async () => {
    vi.resetModules();
    const emailRow = {
      id: 9,
      name: 'ops-mail',
      type: 'email',
      config: { recipients: ['ops@example.com'] },
      events: ['billing_dead', 'balance_low'],
      status: 0,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    };
    const { fetchStub } = mockFetch([{ status: 200, body: [emailRow] }]);
    vi.stubGlobal('fetch', fetchStub);
    installNextStubs();
    vi.doMock('@/server/get-admin', () => ({
      requirePermission: async () => ({ permissions: ['growth:read'] }),
    }));
    const [{ DataTable }, { default: NotificationsPage }] = await Promise.all([
      import('../src/components/data-table'),
      import('../src/app/(main)/dashboard/notifications/page'),
    ]);

    const table = collectElements(await NotificationsPage()).find((el) => el.type === DataTable);
    expect(table).toBeDefined();
    expect(table?.props.rows).toEqual([emailRow]);
  });

  it('GET 失败（网络异常）→ 空表兜底，页面不抛', async () => {
    vi.resetModules();
    const { fetchStub } = mockFetch([{ throwError: true }]);
    vi.stubGlobal('fetch', fetchStub);
    installNextStubs();
    vi.doMock('@/server/get-admin', () => ({
      requirePermission: async () => ({ permissions: ['growth:read'] }),
    }));
    const [{ DataTable }, { default: NotificationsPage }] = await Promise.all([
      import('../src/components/data-table'),
      import('../src/app/(main)/dashboard/notifications/page'),
    ]);

    const table = collectElements(await NotificationsPage()).find((el) => el.type === DataTable);
    expect(table?.props.rows).toEqual([]);
  });
});
