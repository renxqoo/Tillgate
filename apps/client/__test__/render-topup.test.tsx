// @vitest-environment jsdom
/**
 * TopUpForm 渲染规格（jsdom）：
 *  - 前置校验（渠道必选、金额 1 元–10 万元界）不触发出站 action；
 *  - 预设金额/渠道交互与提交参数、payUrl 跳转；
 *  - 渠道目录为空的降级文案（引流兑换码）。
 * 词表单一真相 = messages/en.json；createPaymentAction 打桩。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

vi.mock('@/server/actions/billing', () => ({
  createPaymentAction: vi.fn(),
}));

// toast 经 @tillgate/ui re-export 自 sonner；client 不直依赖 sonner，
// 故对 ui 面做部分 mock：组件保真，仅 toast 替身以断言成功反馈。
vi.mock('@tillgate/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof UiModule>();
  return { ...actual, toast: { error: vi.fn(), success: vi.fn() } };
});

import type * as UiModule from '@tillgate/ui';
import { toast } from '@tillgate/ui';
import { createPaymentAction } from '@/server/actions/billing';
import { TopUpForm } from '../src/features/wallet/topup-form';

const CHANNELS = [
  { id: 'epay', label: 'Epay' },
  { id: 'stripe', label: 'Stripe' },
];

function renderForm(channels = CHANNELS) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TopUpForm channels={channels} />
    </NextIntlClientProvider>,
  );
}

beforeAll(() => {
  // jsdom 的 location 为 unforgeable：删除后替换为纯对象，拦截 payUrl 跳转断言
  delete (window as { location?: Location }).location;
  window.location = { href: 'about:blank' } as unknown as string & Location;
});

beforeEach(() => {
  vi.mocked(createPaymentAction).mockReset();
  vi.mocked(toast.success).mockClear();
  window.location.href = 'about:blank';
});

afterEach(() => cleanup());

describe('TopUpForm（充值表单）', () => {
  it('渠道目录为空：渲染兑换码引流降级文案，不出表单', () => {
    renderForm([]);

    expect(screen.getByText(/redemption code/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Top up now' })).not.toBeInTheDocument();
  });

  it('未选渠道提交：显示渠道错误且不发单（前置校验挡在出站之前）', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Top up now' }));

    expect(screen.getByText('Select a payment channel')).toBeInTheDocument();
    expect(createPaymentAction).not.toHaveBeenCalled();
  });

  it('金额越下界（0 元）：显示区间错误且不发单（1 元–10 万元界）', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Epay' }));
    const amount = screen.getByPlaceholderText('Custom amount');
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(screen.getByRole('button', { name: 'Top up now' }));

    expect(screen.getByText(/between/i)).toBeInTheDocument();
    expect(createPaymentAction).not.toHaveBeenCalled();
  });

  it('预设金额 + 渠道合法提交：action 收到 (epay, 100) 并跳转 payUrl', async () => {
    const user = userEvent.setup();
    vi.mocked(createPaymentAction).mockResolvedValue({ payUrl: 'https://pay.test/ord/1' });
    renderForm();

    await user.click(screen.getByRole('button', { name: '¥100.00' }));
    await user.click(screen.getByRole('button', { name: 'Epay' }));
    await user.click(screen.getByRole('button', { name: 'Top up now' }));

    expect(createPaymentAction).toHaveBeenCalledWith('epay', '100');
    expect(window.location.href).toBe('https://pay.test/ord/1');
    expect(toast.success).toHaveBeenCalledWith('Order created. Redirecting to payment…');
  });
});
