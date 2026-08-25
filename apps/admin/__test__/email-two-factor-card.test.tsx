// @vitest-environment jsdom
/**
 * 邮箱验证码二次登录卡规格（纯个人自助，SELF 域）：开关确认 = 邮箱码自证
 * （admin-email-2fa D2=A）：点开关 → 发码到本人邮箱 → 输码确认生效；
 * 未绑 TOTP 也可开启（D2 取消前置）。SMTP 是系统级配置——独立集成卡，本卡
 * 不承载配置入口与通道状态行（2026-08-25 二次裁决 + D1：状态行完全移除）。
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

function renderCard(meOverride?: Partial<AdminMeInfo>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EmailTwoFactorCard me={{ ...me, ...meOverride }} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EmailTwoFactorCard：邮箱码自证开关（D2=A）', () => {
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

  it('开启链路：点开关 → 发码 → 输码确认 → setTwoFactorAction(enabled, challengeId, code)', async () => {
    requestCode.mockResolvedValue({ challengeId: '11111111-1111-4111-8111-111111111111' });
    setTwoFactor.mockResolvedValue({});
    renderCard({ twoFactorEnabled: false });
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => {
      expect(requestCode).toHaveBeenCalled();
    });
    // 确认弹窗（邮箱码变体文案）
    expect(screen.getByText(/code from your email/i)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('000000'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(setTwoFactor).toHaveBeenCalledWith(
        true,
        '11111111-1111-4111-8111-111111111111',
        '654321',
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
    // 确认成功即关弹窗（回归：成功后不残留）
    expect(screen.queryByPlaceholderText('000000')).not.toBeInTheDocument();
  });

  it('发码失败（SMTP 未生效/冷却）：toast 报错，不弹确认窗、不触达开关', async () => {
    requestCode.mockResolvedValue({ error: 'Email verification code required but SMTP is not configured' });
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(setTwoFactor).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('确认失败（错码）：状态不翻转，无成功 toast', async () => {
    requestCode.mockResolvedValue({ challengeId: '11111111-1111-4111-8111-111111111111' });
    setTwoFactor.mockResolvedValue({ error: 'Invalid code' });
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await userEvent.type(await screen.findByPlaceholderText('000000'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(setTwoFactor).toHaveBeenCalled();
    });
    expect(screen.getByText('Not enabled')).toBeInTheDocument();
  });
});
