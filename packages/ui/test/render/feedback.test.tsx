import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ConfirmDialog,
  CopyButton,
  FormDialog,
  Input,
  ThemeProvider,
  Toaster,
} from '../../src/index';

function installClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe('CopyButton', () => {
  it('点击复制 value 并进入已复制状态', async () => {
    const writeText = installClipboard();
    render(<CopyButton value="sk-123" />);
    const button = screen.getByRole('button', { name: 'Copy' });
    await userEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('sk-123');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(button).toHaveAttribute('data-copied', 'true');
  });

  it('文案可注入', () => {
    installClipboard();
    render(<CopyButton value="x" copyLabel="复制" copiedLabel="已复制" />);
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('打开时渲染标题与必填文案按钮', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="删除渠道?"
        description="删除后不可恢复"
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('删除渠道?')).toBeInTheDocument();
    expect(screen.getByText('删除后不可恢复')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('异步确认 pending 锁按钮, resolve 后自动关闭', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (resolveConfirm = resolve)));
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="确认"
        confirmLabel="确认"
        cancelLabel="取消"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    // pending 期间按钮禁用且未关闭(Spinner 的 status 标签会并入可访问名, 用正则匹配)
    expect(screen.getByRole('button', { name: /确认/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    resolveConfirm();
    await act(async () => {});
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('onConfirm 抛错: 保持打开并回调 onError', async () => {
    const onError = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="确认"
        confirmLabel="确认"
        cancelLabel="取消"
        onConfirm={() => Promise.reject(new Error('boom'))}
        onError={onError}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('destructive 色调渲染警示图标与危险按钮', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="删除"
        confirmLabel="删除"
        cancelLabel="取消"
        tone="destructive"
        onConfirm={() => {}}
      />,
    );
    expect(document.querySelector('[data-slot="confirm-dialog"]')).toHaveAttribute(
      'data-tone',
      'destructive',
    );
    expect(document.querySelector('[data-slot="alert-dialog-media"] svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-destructive');
  });
});

function renderForm(onSubmit: () => unknown, submitDisabled = false) {
  const onOpenChange = vi.fn();
  render(
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="新建渠道"
      submitLabel="创建"
      cancelLabel="取消"
      onSubmit={onSubmit}
      submitDisabled={submitDisabled}
    >
      <Input name="name" placeholder="渠道名" />
    </FormDialog>,
  );
  return { onOpenChange };
}

describe('FormDialog', () => {
  it('渲染标题与表单内容', () => {
    renderForm(() => {});
    expect(screen.getByText('新建渠道')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('渠道名')).toBeInTheDocument();
  });

  it('提交异步流: pending 锁定, resolve 后关闭', async () => {
    let resolveSubmit!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (resolveSubmit = resolve)));
    const { onOpenChange } = renderForm(onSubmit);
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /创建/ })).toBeDisabled();
    resolveSubmit();
    await act(async () => {});
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('submitDisabled=true 时提交按钮禁用且不触发', async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit, true);
    const submit = screen.getByRole('button', { name: '创建' });
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('onSubmit 抛错: 保持打开并回调 onError', async () => {
    const onError = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <FormDialog
        open
        onOpenChange={onOpenChange}
        title="新建渠道"
        submitLabel="创建"
        cancelLabel="取消"
        onSubmit={() => Promise.reject(new Error('boom'))}
        onError={onError}
      >
        <Input name="name" />
      </FormDialog>,
    );
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('取消按钮关闭对话框', async () => {
    const { onOpenChange } = renderForm(() => {});
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Toaster', () => {
  it('无 Provider 也可渲染(主题交由 sonner 缺省)', () => {
    render(
      <ThemeProvider>
        <Toaster position="top-right" />
      </ThemeProvider>,
    );
    render(<Toaster />);
    // sonner 渲染 ol[sonner-toaster] 容器
    expect(document.querySelector('section[aria-label]')).not.toBeNull();
  });
});
