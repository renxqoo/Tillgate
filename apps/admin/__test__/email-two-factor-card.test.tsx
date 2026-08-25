// @vitest-environment jsdom
/**
 * 邮箱验证码二次登录卡规格（纯个人自助，SELF 域）：2FA 启停先过 TOTP stepup
 * 小窗（ADR-0011——Phase 2 将改邮箱码自证，见 docs/admin-email-2fa/ 方案）。
 * SMTP 是系统级配置——独立集成卡，本卡不再承载配置入口与通道状态行
 * （2026-08-25 二次裁决推翻首裁「挂 2FA 卡」；同日裁决 D1：状态行完全移除）。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

const setTwoFactor = vi.fn();

vi.mock('@/server/auth-actions', () => ({
  setTwoFactorAction: (...args: unknown[]) => setTwoFactor(...args),
}));

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

describe('EmailTwoFactorCard：纯个人自助卡', () => {
  it('无 SMTP 残留（二次裁决）：卡上只有启停钮，无 Configure 入口、无通道状态文案', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByText(/mail channel/i)).not.toBeInTheDocument();
  });

  it('2FA 启停先过 stepup 小窗：码随开关同传 setTwoFactorAction（ADR-0011）', async () => {
    setTwoFactor.mockResolvedValue({});
    renderCard({ twoFactorEnabled: false });
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await userEvent.type(screen.getByPlaceholderText('000000'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(setTwoFactor).toHaveBeenCalledWith(true, '654321');
    });
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
  });

  it('未绑定验证器（ADR-0011）：启停钮置灰并带引导提示', () => {
    renderCard({ totpEnabled: false });
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable' })).toHaveAttribute(
      'title',
      'Bind your authenticator (TOTP) first',
    );
  });
});
