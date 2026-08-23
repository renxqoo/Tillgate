// @vitest-environment jsdom
/**
 * ConfirmAction 渲染规格（jsdom，MIGRATION §8 渲染切片）：
 * 二次确认改用 ui 包 ConfirmDialog（shadcn AlertDialog）——开弹窗 → 确认/取消分支、
 * pending 生命周期（防重复提交）、无 confirm 直执行、action 失败复位不抛。
 * 消费形态对齐 keys 吊销 / apps 删除的行内按钮 render-prop。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import { ConfirmAction } from '../src/features/shared/confirm-action';

const messages = {
  ui: { confirm: '确认', cancel: '取消', confirmTitle: '请确认操作' },
};

/** 测试载体：对齐真实消费点的行内按钮形态（pending → disabled + 转圈文案） */
function Probe({
  confirm,
  action,
}: {
  confirm?: string;
  action: () => Promise<{ error?: string }>;
}) {
  return (
    <NextIntlClientProvider locale="zh" messages={messages}>
      <ConfirmAction confirm={confirm} action={action} success="ok-toast">
        {({ pending, onClick }) => (
          <button type="button" disabled={pending} onClick={onClick}>
            {pending ? 'pending' : 'act'}
          </button>
        )}
      </ConfirmAction>
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ConfirmAction（确认弹窗交互）', () => {
  it('点按钮开弹窗、取消：action 不执行（防误删的第一道闸）', async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({}));
    render(<Probe confirm="确认吊销？" action={action} />);

    await user.click(screen.getByRole('button', { name: 'act' }));

    // 弹窗出现且带确认文案；点取消后关闭、action 未执行
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('确认吊销？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(action).not.toHaveBeenCalled();
  });

  it('确认：action 执行且 pending 期间按钮禁用、结束后复位（防重复提交）', async () => {
    const user = userEvent.setup();
    let resolveAction!: (v: { error?: string }) => void;
    const action = vi.fn(
      () =>
        new Promise<{ error?: string }>((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(<Probe confirm="确认吊销？" action={action} />);

    await user.click(screen.getByRole('button', { name: 'act' }));
    await user.click(await screen.findByRole('button', { name: '确认' }));

    expect(action).toHaveBeenCalledTimes(1);
    // 弹窗模态期间行按钮被 aria-hidden,用文本断言 pending 态
    expect(await screen.findByText('pending')).toBeInTheDocument();

    resolveAction({});
    await waitFor(() => expect(screen.getByRole('button', { name: 'act' })).toBeEnabled());
  });

  it('无 confirm：跳过弹窗直接执行（轻量动作不打扰）', async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({}));
    render(<Probe action={action} />);

    await user.click(screen.getByRole('button', { name: 'act' }));

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('action 返回 error：不抛异常且 pending 复位（失败可重试）', async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({ error: '后端拒绝' }));
    render(<Probe confirm="确认？" action={action} />);

    await user.click(screen.getByRole('button', { name: 'act' }));
    await user.click(await screen.findByRole('button', { name: '确认' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'act' })).toBeEnabled());
  });
});
