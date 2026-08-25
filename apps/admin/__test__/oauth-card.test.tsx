// @vitest-environment jsdom
/**
 * OAuth 登录组合卡规格（2026-08-25 用户裁决：基地址不独立占卡）：
 * base/github/google 三行共居一卡；每行独立启停（经 step-up 小窗，码随
 * enabled 同传）与配置弹窗；未绑定验证器全行置灰；总闸提示常驻。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

const updateIntegration = vi.fn();

vi.mock('@/server/settings-actions', async () => {
  const actual = await vi.importActual<object>('@/server/settings-actions');
  return { ...actual, updateIntegrationAction: (...args: unknown[]) => updateIntegration(...args) };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import type { IntegrationSettingItem } from '@/server/settings-actions';
import { OAuthCard } from '../src/features/settings/integration-cards/oauth-card';

const itemOf = (
  key: string,
  over: Partial<IntegrationSettingItem> = {},
): IntegrationSettingItem => ({
  key,
  enabled: true,
  configured: true,
  config: {},
  secretsSet: [],
  rotatedAt: null,
  updatedAt: null,
  updatedByAdminId: null,
  ...over,
});

function renderCard(totpEnabled = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OAuthCard
        base={itemOf('oauth.base', { config: { frontendUrl: null, apiBase: null } })}
        github={itemOf('oauth.github', { config: { clientId: null, clientSecret: null } })}
        google={itemOf('oauth.google', { enabled: false })}
        totpEnabled={totpEnabled}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OAuthCard：三合一组合卡', () => {
  it('三行齐备（Base URLs / GitHub / Google）+ 总闸提示常驻', () => {
    renderCard();
    expect(screen.getByText('OAuth login')).toBeInTheDocument();
    expect(screen.getByText('OAuth base URLs')).toBeInTheDocument();
    expect(screen.getByText('GitHub login')).toBeInTheDocument();
    expect(screen.getByText('Google login')).toBeInTheDocument();
    expect(screen.getByText(/base URLs are missing or disabled/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Configure' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(2); // base + github
    expect(screen.getAllByRole('button', { name: 'Enable' })).toHaveLength(1); // google
  });

  it('行启停经 step-up 小窗：码随 enabled 同传对应 key', async () => {
    updateIntegration.mockResolvedValue(itemOf('oauth.base', { enabled: false }));
    renderCard();
    // 第一行（base）的 Disable
    const [baseToggle] = screen.getAllByRole('button', { name: 'Disable' });
    expect(baseToggle).toBeDefined();
    await userEvent.click(baseToggle as HTMLElement);
    await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith('oauth.base', {
        totpCode: '123456',
        enabled: false,
      });
    });
  });

  it('未绑定验证器（ADR-0011）：三行的配置与启停全置灰', () => {
    renderCard(false);
    for (const btn of screen.getAllByRole('button', { name: 'Configure' })) {
      expect(btn).toBeDisabled();
    }
    for (const btn of screen.getAllByRole('button', { name: /Enable|Disable/ })) {
      expect(btn).toBeDisabled();
    }
  });
});
