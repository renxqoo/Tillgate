// @vitest-environment jsdom
/**
 * PasswordForm / RedeemForm 渲染规格（jsdom，MIGRATION §8 渲染切片）：
 *  - PasswordForm：zod 双层校验（长度 8-128 + 两次一致 refine）挡在出站之前、
 *    成功路径参数传递与 reset/onSuccess 收尾；
 *  - RedeemForm：短码校验、成功态到账额展示与「再兑一次」回表单。
 * 词表单一真相 = messages/en.json；server actions 打桩。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

vi.mock('@/server/actions/settings', () => ({
  changePasswordAction: vi.fn(),
}));

vi.mock('@/server/actions/redeem', () => ({
  redeemAction: vi.fn(),
}));

import { changePasswordAction } from '@/server/actions/settings';
import { redeemAction } from '@/server/actions/redeem';
import { PasswordForm } from '../src/features/settings/password-form';
import { RedeemForm } from '../src/features/wallet/redeem-form';

function renderUi(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(changePasswordAction).mockReset();
  vi.mocked(redeemAction).mockReset();
});

afterEach(() => cleanup());

describe('PasswordForm（改密表单校验）', () => {
  it('新密码 7 位且两次不一致：两条错误各自呈现、action 不出站', async () => {
    const user = userEvent.setup();
    renderUi(<PasswordForm />);

    await user.type(screen.getByLabelText('Current password'), 'old-pass');
    await user.type(screen.getByLabelText('New password'), 'short7');
    await user.type(screen.getByLabelText('Confirm new password'), 'different');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));

    expect(screen.getByText('New password must be at least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('New passwords do not match')).toBeInTheDocument();
    expect(changePasswordAction).not.toHaveBeenCalled();
  });

  it('合法提交：action 收到 old/new（不含确认字段）、成功后表单复位并回调 onSuccess', async () => {
    const user = userEvent.setup();
    vi.mocked(changePasswordAction).mockResolvedValue({});
    const onSuccess = vi.fn();
    renderUi(<PasswordForm onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText('Current password'), 'old-pass');
    await user.type(screen.getByLabelText('New password'), 'new-pass-8');
    await user.type(screen.getByLabelText('Confirm new password'), 'new-pass-8');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(changePasswordAction).toHaveBeenCalledWith({
      oldPassword: 'old-pass',
      newPassword: 'new-pass-8',
    });
    // reset：三个输入回空（下次打开弹窗不残留旧值）
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });
});

describe('RedeemForm（兑换码表单）', () => {
  it('短码（<4 位）提交：invalidCode 呈现、action 不出站', async () => {
    const user = userEvent.setup();
    renderUi(<RedeemForm />);

    await user.type(screen.getByPlaceholderText('Enter your code'), 'ab');
    await user.click(screen.getByRole('button', { name: 'Redeem' }));

    expect(screen.getByText('Enter a valid redemption code')).toBeInTheDocument();
    expect(redeemAction).not.toHaveBeenCalled();
  });

  it('兑换成功：到账额/余额按 locale 货币格式展示，「再兑一次」回到空表单', async () => {
    const user = userEvent.setup();
    vi.mocked(redeemAction).mockResolvedValue({ amount: '25', balanceAfter: '125' });
    renderUi(<RedeemForm />);

    const input = screen.getByPlaceholderText('Enter your code');
    await user.type(input, 'CODE-1234');
    await user.click(screen.getByRole('button', { name: 'Redeem' }));

    // Intl 货币（en/CNY narrowSymbol）展示；词表模板自带 ¥ 前缀、formatter 再带一位
    // （既有展示形态），金额不再走积分投影（D-E）
    expect(await screen.findByText('Success — +¥¥25.00 credited')).toBeInTheDocument();
    expect(screen.getByText(/Settled balance: ¥¥125\.00/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Redeem another' }));

    expect(screen.getByPlaceholderText('Enter your code')).toHaveValue('');
    expect(screen.queryByText(/credited/)).not.toBeInTheDocument();
  });
});
