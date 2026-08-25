// @vitest-environment jsdom
/**
 * 集成设置卡交互规格（docs/integration-settings/DESIGN.md §4.1/§5 D11、§9）：
 * 词表次序渲染（SMTP 无独立卡——挂 2FA 卡）；卡面不显示配置字段值
 * （2026-08-25 用户裁决：配置收进弹窗，secret 掩码只在弹窗 placeholder 回显）；
 * 启停走 update 动作；Turnstile 停用在注册送礼开启时出警告（不阻断）；
 * 表单三态组装（空=缺席、勾选清除=null）。
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

import { toast } from 'sonner';
import type { IntegrationSettingItem } from '@/server/settings-actions';
import { IntegrationCard } from '../src/features/settings/integration-cards/integration-card';
import {
  buildConfigPayload,
  INTEGRATION_CARD_ORDER,
} from '../src/features/settings/integration-cards/integration-format';

const epayItem: IntegrationSettingItem = {
  key: 'payment.epay',
  enabled: true,
  configured: true,
  config: {
    pid: '1001',
    key: '****k-9',
    gatewayUrl: 'https://pay.example.test',
    notifyUrl: 'https://api.example.test/notify',
    returnUrl: 'https://console.example.test/return',
    payType: 'alipay',
  },
  secretsSet: ['key'],
  rotatedAt: null,
  updatedAt: '2026-08-25T00:00:00.000Z',
  updatedByAdminId: 7,
};

function renderCard(
  item: IntegrationSettingItem,
  signupGiftOn = false,
  totpEnabled = true,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <IntegrationCard item={item} signupGiftOn={signupGiftOn} totpEnabled={totpEnabled} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('integration-format 纯函数', () => {
  it('表单三态组装：值=set / 空+勾选=null / 空未勾选=缺席', () => {
    const payload = buildConfigPayload(
      ['pid', 'key', 'gatewayUrl'],
      { pid: '1002', key: '', gatewayUrl: '' },
      new Set(['key']),
    );
    expect(payload).toEqual({ pid: '1002', key: null });
  });

  it('词表封闭：独立卡 6 项、不含 smtp（SMTP 挂邮箱验证码二次登录卡）', () => {
    expect(INTEGRATION_CARD_ORDER).toHaveLength(6);
    expect(INTEGRATION_CARD_ORDER).not.toContain('smtp');
    expect(new Set(INTEGRATION_CARD_ORDER).size).toBe(INTEGRATION_CARD_ORDER.length);
  });
});

describe('IntegrationCard 交互', () => {
  it('卡面不显示配置字段值：明文与掩码值均不出现；配置按钮在标题行', async () => {
    renderCard(epayItem);
    // 2026-08-25 用户裁决：卡面无配置字段值（与 2FA/TOTP 卡同形态）
    expect(screen.queryByText('****k-9')).not.toBeInTheDocument();
    expect(screen.queryByText('1001')).not.toBeInTheDocument();
    expect(screen.queryByText('https://pay.example.test')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure' })).toBeInTheDocument();
    expect(screen.getByText('Epay')).toBeInTheDocument();

    // 配置值只存在于弹窗：secret 掩码在 placeholder 回显，永不还原明文
    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));
    const secretInput = screen.getByPlaceholderText(/Set \(\*\*\*\*k-9\)/i);
    expect(secretInput).toBeInTheDocument();
    expect((secretInput as HTMLInputElement).value).toBe('');
  });

  it('停用动作：先过 stepup 小窗（ADR-0011）——码随 enabled 同传并刷新卡片状态', async () => {
    updateIntegration.mockResolvedValue({ ...epayItem, enabled: false });
    renderCard(epayItem);
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    // stepup 小窗：6 位码 + 确认
    const codeInput = screen.getByPlaceholderText('000000');
    await userEvent.type(codeInput, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith('payment.epay', {
        totpCode: '123456',
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
  });

  it('Turnstile 加固：注册送礼开启时停用出警告 toast（不阻断）；其他集成停用无警告', async () => {
    updateIntegration.mockResolvedValue({ ...epayItem, key: 'captcha.turnstile', enabled: false });
    renderCard({ ...epayItem, key: 'captcha.turnstile', config: {} }, true);
    // 启用态下卡片内常驻风险提示（先于停用断言——停用后条件翻转）
    expect(screen.getByText(/disabling captcha removes register anti-abuse/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    updateIntegration.mockResolvedValue({ ...epayItem, enabled: false });
    cleanup();
    renderCard(epayItem, true);
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalled();
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('未配置集成：启用按钮禁用（enabled⇒完整性不变量的 UI 面）', () => {
    renderCard({ ...epayItem, enabled: false, configured: false, config: {} });
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
  });

  it('未绑定验证器（ADR-0011）：配置与启停按钮置灰并带引导提示', () => {
    renderCard(epayItem, false, false);
    expect(screen.getByRole('button', { name: 'Configure' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable' })).toHaveAttribute(
      'title',
      'Bind your authenticator (TOTP) first',
    );
  });
});
