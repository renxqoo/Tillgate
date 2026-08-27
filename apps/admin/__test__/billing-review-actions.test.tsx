// @vitest-environment jsdom
/**
 * 计费异常复核弹窗交互规格：
 * 操作按钮打开模态层，理由输入可编辑；空理由不出站；retry/abandon 参数保真；
 * 成功关闭并清空，失败保留上下文，pending 防止重复决策。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

vi.mock('@/server/billing-operations-actions', () => ({
  retryDeadBillingRequest: vi.fn(),
  abandonDeadBillingRequest: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';
import {
  abandonDeadBillingRequest,
  retryDeadBillingRequest,
} from '@/server/billing-operations-actions';
import { ReviewActions } from '../src/features/billing/review-actions';

const row = { requestId: 'req-42', revision: 7, status: 'dead' as const };

function renderActions() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ReviewActions {...row} />
    </NextIntlClientProvider>,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.mocked(retryDeadBillingRequest).mockReset();
  vi.mocked(abandonDeadBillingRequest).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});

afterEach(() => cleanup());

describe('ReviewActions（计费异常复核弹窗）', () => {
  it('操作按钮打开弹窗，理由可输入；关闭后再次打开不残留', async () => {
    const user = userEvent.setup();
    renderActions();

    await openDialog(user);
    const input = screen.getByLabelText('Reason');
    await user.type(input, 'receipt mismatch');
    expect(input).toHaveValue('receipt mismatch');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openDialog(user);
    expect(screen.getByLabelText('Reason')).toHaveValue('');
  });

  it('空白理由不出站并显示校验提示', async () => {
    const user = userEvent.setup();
    renderActions();
    await openDialog(user);

    await user.type(screen.getByLabelText('Reason'), '   ');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retryDeadBillingRequest).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('A review reason is required');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each([
    ['Retry', retryDeadBillingRequest, 'Sent to the retry queue'],
    ['Abandon', abandonDeadBillingRequest, 'Abandoned and reservation released'],
  ] as const)('%s 成功：参数保真、提示并关闭弹窗', async (label, action, success) => {
    const user = userEvent.setup();
    vi.mocked(action).mockResolvedValue({});
    renderActions();
    await openDialog(user);

    await user.type(screen.getByLabelText('Reason'), 'manual review');
    await user.click(screen.getByRole('button', { name: label }));

    await waitFor(() =>
      expect(action).toHaveBeenCalledWith({
        requestId: 'req-42',
        expectedRevision: 7,
        reason: 'manual review',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(success);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('失败保留理由；pending 期间禁用三个按钮且只发一次请求', async () => {
    const user = userEvent.setup();
    let resolveAction!: (value: { error?: string }) => void;
    vi.mocked(retryDeadBillingRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    renderActions();
    await openDialog(user);

    const input = screen.getByLabelText('Reason');
    await user.type(input, 'keep this evidence');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Abandon' }));
    expect(abandonDeadBillingRequest).not.toHaveBeenCalled();

    resolveAction({ error: 'revision conflict' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(input).toHaveValue('keep this evidence');
    expect(toast.error).toHaveBeenCalledWith('revision conflict');
    expect(retryDeadBillingRequest).toHaveBeenCalledTimes(1);
  });
});
