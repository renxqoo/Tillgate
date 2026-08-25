// @vitest-environment jsdom
/**
 * 邮箱验证码二次登录卡规格（纯个人自助，SELF 域）：点开关只开弹窗（不自动
 * 发码）——弹窗内手动「发送验证码」（60s 冷却倒计时,CountdownButton;关弹窗
 * 重开倒计时连续）,未发码前确认钮禁用;输码确认生效（admin-email-2fa D2=A,
 * 2026-08-25 交互修订）。未绑 TOTP 也可开启（D2 取消前置）。SMTP 是系统级
 * 配置——独立集成卡,本卡不承载配置入口与通道状态行（二次裁决 + D1）。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

const setTwoFactor = vi.fn();
const requestCode = vi.fn();

vi.mock('@/server/auth-actions', async () => {
  const actual = await vi.importActual<object>('@/server/auth-actions');
  return {
    ...actual,
    setTwoFactorAction: (...args: unknown[]) => setTwoFactor(...args),
    requestTwoFactorCodeAction: (...args: unknown[]) => requestCode(...args),
  };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';
import type { AdminMeInfo } from '@tillgate/api-client';
import { EmailTwoFactorCard } from '../src/features/settings/email-two-factor-card';

const me = { email: 'ops@example.test', twoFactorEnabled: false, totpEnabled: true } as AdminMeInfo;
const CHALLENGE = '11111111-1111-4111-8111-111111111111';

function renderCard(meOverride?: Partial<AdminMeInfo>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EmailTwoFactorCard me={{ ...me, ...meOverride }} />
    </NextIntlClientProvider>,
  );
}

async function openDialog(meOverride?: Partial<AdminMeInfo>) {
  renderCard(meOverride);
  await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
  return screen.findByRole('button', { name: 'Send code' });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EmailTwoFactorCard：邮箱码自证开关（手动发码 + 倒计时）', () => {
  it('无 SMTP 残留（二次裁决）：卡上只有启停钮，无 Configure 入口、无通道状态文案', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByText(/mail channel/i)).not.toBeInTheDocument();
  });

  it('未绑 TOTP 也可开启（D2 取消前置）：按钮不置灰、无绑定引导提示', () => {
    renderCard({ totpEnabled: false });
    expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Enable' })).not.toHaveAttribute('title');
  });

  it('点开关只开弹窗不自动发码；未发码前确认钮禁用', async () => {
    await openDialog();
    expect(requestCode).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('手动发码：调发码 action、确认钮放开、倒计时呈现', async () => {
    requestCode.mockResolvedValue({ challengeId: CHALLENGE });
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => {
      expect(requestCode).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    // 60s 冷却倒计时（Resend in Ns,禁用态）
    const resend = screen.getByRole('button', { name: /^Resend in \d+s$/ });
    expect(resend).toBeDisabled();
  });

  it('发码失败（SMTP 未生效/冷却）：toast 报错，确认钮保持禁用', async () => {
    requestCode.mockResolvedValue({
      error: 'Email verification code required but SMTP is not configured',
    });
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(setTwoFactor).not.toHaveBeenCalled();
  });

  it('完整链路：发码 → 输码 → 确认 → setTwoFactorAction(enabled, challengeId, code) → 关弹窗', async () => {
    requestCode.mockResolvedValue({ challengeId: CHALLENGE });
    setTwoFactor.mockResolvedValue({});
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByRole('button', { name: /^Resend in \d+s$/ });
    await userEvent.type(screen.getByLabelText(/6-digit email code/i), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(setTwoFactor).toHaveBeenCalledWith(true, CHALLENGE, '654321');
    });
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
    // 确认成功即关弹窗
    expect(screen.queryByLabelText(/6-digit email code/i)).not.toBeInTheDocument();
  });

  it('冷却跨弹窗连续：发码后关弹窗再点开关，发送钮仍在倒计时', async () => {
    requestCode.mockResolvedValue({ challengeId: CHALLENGE });
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByRole('button', { name: /^Resend in \d+s$/ });
    // 关弹窗（Cancel）再重开——冷却态由卡片持有,不随弹窗重置
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(screen.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled();
    expect(requestCode).toHaveBeenCalledTimes(1);
  });

  it('确认失败（错码）：状态不翻转，弹窗保持开可重试', async () => {
    requestCode.mockResolvedValue({ challengeId: CHALLENGE });
    setTwoFactor.mockResolvedValue({ error: 'Invalid code' });
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText(/6-digit email code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(setTwoFactor).toHaveBeenCalled();
    });
    expect(screen.getByText('Not enabled')).toBeInTheDocument();
    expect(screen.getByLabelText(/6-digit email code/i)).toBeInTheDocument();
  });
});
