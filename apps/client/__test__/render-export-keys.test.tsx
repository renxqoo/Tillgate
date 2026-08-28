// @vitest-environment jsdom
/**
 * ExportKeys 渲染规格（jsdom）：
 *  - 点击导出触发全量 server action 并走完整下载链路
 *    （Blob → objectURL → anchor.click → revoke），文件名与 BOM 落到字节；
 *  - action 失败以 toast 呈现后端文案，不触发下载。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { defined } from './defined';

vi.mock('@/server/actions/keys', () => ({
  exportKeysAction: vi.fn(),
}));

vi.mock('@tillgate/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof UiModule>();
  return { ...actual, toast: { error: vi.fn(), success: vi.fn() } };
});

import type * as UiModule from '@tillgate/ui';
import { toast } from '@tillgate/ui';
import { exportKeysAction } from '@/server/actions/keys';
import type { KeyRow } from '@tillgate/api-client';
import { ExportKeys } from '../src/features/keys/export-keys';

function keyRow(id: number, over: Partial<KeyRow> = {}): KeyRow {
  return {
    id,
    keyPreview: `sk-prev-${id}`,
    name: `key-${id}`,
    remark: null,
    subscriptionId: null,
    status: 0,
    rpmLimit: null,
    tpmLimit: null,
    dailySpendLimit: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(exportKeysAction).mockReset();
  vi.mocked(toast.error).mockClear();
  createObjectURL = vi.fn(() => 'blob:mock');
  revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExportKeys（B18 全量导出下载链路）', () => {
  it('成功：生成含 BOM 的 TSV Blob 并触发 anchor 下载、及时 revoke', async () => {
    const user = userEvent.setup();
    vi.mocked(exportKeysAction).mockResolvedValue({
      rows: [keyRow(1), keyRow(2, { name: '中文' })],
    });
    // anchor 由组件 createElement 生成、不挂 DOM——桩 createElement 捕获实例；
    // click 仅计数（拦截真实导航）
    const realCreate = document.createElement.bind(document);
    const created: Element[] = [];
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag.toLowerCase() === 'a') created.push(el);
      return el;
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ExportKeys />);

    await user.click(screen.getByRole('button', { name: /export/i }));

    const anchor = created[0] as HTMLAnchorElement;
    expect(clickSpy).toHaveBeenCalledTimes(1);

    expect(exportKeysAction).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Blob.text() 按 spec 以 UTF-8 解码并剥前导 BOM（浏览器同此），可见内容断言
    // 表头 + 全量行；BOM 物理字节由 size 差 3 证明（字节层断言见 export-keys.test.ts）
    const blob = defined(createObjectURL.mock.calls[0], 'createObjectURL call')[0] as Blob;
    const text = await blob.text();
    expect(text.startsWith('name\tkeyPreview\tstatus\tcreatedAt\n')).toBe(true);
    expect(text).toContain('中文\tsk-prev-2\tactive\t2026-08-01T00:00:00Z');
    expect(blob.size).toBe(new TextEncoder().encode(text).byteLength + 3);
    expect(anchor.download).toMatch(/^api-keys-\d{4}-\d{2}-\d{2}\.tsv$/);
    expect(anchor.href).toBe('blob:mock');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('失败：toast 呈现后端错误文案，不触发下载（无脏文件落地）', async () => {
    const user = userEvent.setup();
    vi.mocked(exportKeysAction).mockResolvedValue({ error: 'upstream down' });
    render(<ExportKeys />);

    await user.click(screen.getByRole('button', { name: /export/i }));

    expect(toast.error).toHaveBeenCalledWith('upstream down');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
