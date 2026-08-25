// @vitest-environment jsdom
/**
 * 邮箱验证码二次登录卡规格（docs/integration-settings/IMPLEMENTATION 增量 2026-08-25）：
 * SMTP 无独立集成卡——配置按钮在 2FA 卡右上（无 settings:integrations 权限或
 * 集成列表加载失败时隐藏，2FA 启停不受影响）；邮件通道三态状态行；弹窗含启停开关，
 * 提交 { enabled, config } 同传。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

const updateIntegration = vi.fn();
const setTwoFactor = vi.fn();

vi.mock('@/server/settings-actions', async () => {
  const actual = await vi.importActual<object>('@/server/settings-actions');
  return { ...actual, updateIntegrationAction: (...args: unknown[]) => updateIntegration(...args) };
});

vi.mock('@/server/auth-actions', () => ({
  setTwoFactorAction: (...args: unknown[]) => setTwoFactor(...args),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import type { IntegrationSettingItem } from '@/server/settings-actions';
import type { AdminMeInfo } from '@tillgate/api-client';
import { EmailTwoFactorCard } from '../src/features/settings/email-two-factor-card';

const smtpItem: IntegrationSettingItem = {
  key: 'smtp',
  enabled: false,
  configured: true,
  config: { host: 'smtp.example.com', port: '465', user: 'ops', pass: '****s-9', from: null },
  secretsSet: ['pass'],
  rotatedAt: null,
  updatedAt: '2026-08-25T00:00:00.000Z',
  updatedByAdminId: 7,
};

const me = { email: 'ops@example.test', twoFactorEnabled: false, totpEnabled: true } as AdminMeInfo;

function renderCard(overrides?: {
  smtp?: IntegrationSettingItem | null;
  smtpUnavailable?: boolean;
  canManageIntegrations?: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EmailTwoFactorCard
        me={me}
        smtp={overrides?.smtp !== undefined ? overrides.smtp : smtpItem}
        smtpUnavailable={overrides?.smtpUnavailable ?? false}
        canManageIntegrations={overrides?.canManageIntegrations ?? true}
        onSavedSmtp={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EmailTwoFactorCard：SMTP 配置入口与状态行', () => {
  it('邮件通道三态：未配置 / 已配置未启用 / 就绪', () => {
    const { unmount } = renderCard({ smtp: { ...smtpItem, configured: false, config: {} } });
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    unmount();

    renderCard({ smtp: smtpItem });
    expect(screen.getByText(/configured but disabled/i)).toBeInTheDocument();
    cleanup();

    renderCard({ smtp: { ...smtpItem, enabled: true } });
    expect(screen.getByText(/ready \(SMTP enabled\)/i)).toBeInTheDocument();
  });

  it('集成列表加载失败：配置按钮隐藏，2FA 启停不受影响', () => {
    renderCard({ smtpUnavailable: true });
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('无 settings:integrations 权限（D1 裁决）：配置按钮隐藏，2FA 启停与状态行不受影响', () => {
    renderCard({ canManageIntegrations: false });
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    // SELF 域启停钮与 SMTP 只读状态行仍在
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByText(/configured but disabled/i)).toBeInTheDocument();
  });

  it('弹窗提交：启停开关与字段同传 { enabled, config }', async () => {
    updateIntegration.mockResolvedValue({ ...smtpItem, enabled: true });
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));
    // 表单含 step-up 码框（ADR-0011 必填）；启停开关回填当前态（false）→ 勾选启用
    const toggle = screen.getByRole('checkbox');
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.click(toggle);
    await userEvent.type(screen.getByLabelText(/host/i), 'smtp.new.example.test');
    await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith('smtp', {
        totpCode: '123456',
        enabled: true,
        config: { host: 'smtp.new.example.test' },
      });
    });
  });

  it('2FA 启停先过 stepup 小窗：码随开关同传 setTwoFactorAction（ADR-0011）', async () => {
    setTwoFactor.mockResolvedValue({});
    renderCard({ smtp: null });
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
});
