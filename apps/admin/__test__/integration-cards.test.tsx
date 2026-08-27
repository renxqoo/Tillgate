// @vitest-environment jsdom
/**
 * 集成设置卡交互规格：
 * 词表次序渲染（SMTP 独立卡——
 * 系统级配置与个人自助分离，门控粒度对齐 settings:integrations）；卡面不显示
 * 配置字段值（配置收进弹窗，secret 掩码只在弹窗 placeholder 回显）；启停走
 * update 动作；Turnstile 停用在注册送礼开启时出警告（不阻断）；表单三态组装
 * （空=缺席、勾选清除=null）；无 settings:integrations 权限时配置/启停操作位
 * 隐藏（状态只读保留）。
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
  opts?: { signupGiftOn?: boolean; totpEnabled?: boolean; canManage?: boolean },
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <IntegrationCard
        item={item}
        signupGiftOn={opts?.signupGiftOn ?? false}
        totpEnabled={opts?.totpEnabled ?? true}
        canManage={opts?.canManage ?? true}
      />
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

  it('词表封闭：独立卡 6 项（含 smtp 独立卡——2026-08-25 二次裁决）；oauth.base（退回 env，ADR-0012）不在列', () => {
    expect(INTEGRATION_CARD_ORDER).toHaveLength(6);
    expect(INTEGRATION_CARD_ORDER).toContain('smtp');
    expect(INTEGRATION_CARD_ORDER).not.toContain('oauth.base');
    expect(new Set(INTEGRATION_CARD_ORDER).size).toBe(INTEGRATION_CARD_ORDER.length);
  });
});

describe('IntegrationCard 交互', () => {
  it('卡面不显示配置字段值：明文与掩码值均不出现；配置按钮在标题行', async () => {
    renderCard(epayItem);
    // 卡面无配置字段值（与 2FA/TOTP 卡同形态）
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
    updateIntegration.mockResolvedValue({ item: { ...epayItem, enabled: false } });
    renderCard(epayItem);
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    // stepup 小窗：6 位码 + 确认
    const codeInput = screen.getByLabelText(/authenticator code/i);
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
    // 确认成功即关弹窗（回归：成功后不残留）
    expect(screen.queryByLabelText(/authenticator code/i)).not.toBeInTheDocument();
  });

  it('Turnstile 加固：注册送礼开启时停用出警告 toast（不阻断）；其他集成停用无警告', async () => {
    updateIntegration.mockResolvedValue({
      item: { ...epayItem, key: 'captcha.turnstile', enabled: false },
    });
    renderCard({ ...epayItem, key: 'captcha.turnstile', config: {} }, { signupGiftOn: true });
    // 启用态下卡片内常驻风险提示（先于停用断言——停用后条件翻转）
    expect(screen.getByText(/disabling captcha removes register anti-abuse/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    updateIntegration.mockResolvedValue({ item: { ...epayItem, enabled: false } });
    cleanup();
    renderCard(epayItem, { signupGiftOn: true });
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
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

  it('SMTP 独立卡（2026-08-25 二次裁决）：通用卡形态——标题/配置钮/启停钮俱全', () => {
    renderCard({
      ...epayItem,
      key: 'smtp',
      config: { host: 'smtp.example.com', port: '465', user: 'ops', pass: '****s-9', from: null },
      secretsSet: ['pass'],
    });
    expect(screen.getByText('Email (SMTP)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    // 卡面无配置字段值（含掩码）
    expect(screen.queryByText('****s-9')).not.toBeInTheDocument();
  });

  it('未绑定验证器（ADR-0011）：配置与启停按钮置灰并带引导提示', () => {
    renderCard(epayItem, { totpEnabled: false });
    expect(screen.getByRole('button', { name: 'Configure' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable' })).toHaveAttribute(
      'title',
      'Bind your authenticator (TOTP) first',
    );
  });

  it('无 settings:integrations 权限（D1 裁决）：配置/启停操作位隐藏，状态与警告只读保留', () => {
    renderCard(
      { ...epayItem, key: 'captcha.turnstile', config: {} },
      { signupGiftOn: true, canManage: false },
    );
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    // 只读面：状态徽章 + 注册送礼风险提示仍在
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText(/disabling captcha removes register anti-abuse/i)).toBeInTheDocument();
  });
});
