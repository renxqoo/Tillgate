// @vitest-environment jsdom
/**
 * 集成设置卡交互规格（docs/integration-settings/DESIGN.md §4.1/§5 D11、§8）：
 * 词表次序渲染；secret 掩码回显（永不还原明文）；启停走 update 动作；
 * Turnstile 停用在注册送礼开启时出警告（不阻断）；表单三态组装（空=缺席、
 * 勾选清除=null）。
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
import { buildConfigPayload } from '../src/features/settings/integration-cards/integration-format';

const smtpItem: IntegrationSettingItem = {
  key: 'smtp',
  enabled: true,
  configured: true,
  config: { host: 'smtp.example.com', port: '465', user: 'ops', pass: '****s-9', from: null },
  secretsSet: ['pass'],
  rotatedAt: null,
  updatedAt: '2026-08-25T00:00:00.000Z',
  updatedByAdminId: 7,
};

function renderCard(item: IntegrationSettingItem, signupGiftOn = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <IntegrationCard item={item} signupGiftOn={signupGiftOn} />
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
      ['host', 'pass', 'from'],
      { host: 'smtp2.example.com', pass: '', from: '' },
      new Set(['pass']),
    );
    expect(payload).toEqual({ host: 'smtp2.example.com', pass: null });
    expect(buildConfigPayload(['host'], { host: '' }, new Set())).toEqual({});
  });
});

describe('IntegrationCard 交互', () => {
  it('掩码回显：secret 字段展示 **** 尾 4，永不还原明文；配置按钮在标题行', () => {
    renderCard(smtpItem);
    expect(screen.getByText('****s-9')).toBeInTheDocument();
    expect(screen.queryByText('secret-pass-9')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure' })).toBeInTheDocument();
    expect(screen.getByText('Email (SMTP)')).toBeInTheDocument();
  });

  it('停用动作：update 动作收到 enabled=false 并刷新卡片状态', async () => {
    updateIntegration.mockResolvedValue({ ...smtpItem, enabled: false });
    renderCard(smtpItem);
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith('smtp', { enabled: false });
    });
    await waitFor(() => {
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
  });

  it('Turnstile 加固：注册送礼开启时停用出警告 toast（不阻断）；其他集成停用无警告', async () => {
    updateIntegration.mockResolvedValue({ ...smtpItem, key: 'captcha.turnstile', enabled: false });
    renderCard({ ...smtpItem, key: 'captcha.turnstile' }, true);
    // 启用态下卡片内常驻风险提示（先于停用断言——停用后条件翻转）
    expect(screen.getByText(/disabling captcha removes register anti-abuse/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    updateIntegration.mockResolvedValue({ ...smtpItem, enabled: false });
    cleanup();
    renderCard(smtpItem, true);
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalled();
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('未配置集成：启用按钮禁用（enabled⇒完整性不变量的 UI 面）', () => {
    renderCard({ ...smtpItem, enabled: false, configured: false, config: {} });
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
  });
});
