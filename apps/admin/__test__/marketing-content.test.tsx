// @vitest-environment jsdom
/**
 * 营销参数卡权限显隐（2026-08-25 用户裁决 D1/D2）：无 growth:update →
 * 三个输入禁用、保存钮隐藏（只读表单）；持有时编辑面完整。
 * 敏感度维持 growth:update 不提级（同日用户裁决 D3）——本文件只锁显隐形态。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

vi.mock('@/server/marketing-actions', () => ({
  saveMarketingSettingsAction: vi.fn(),
}));

import {
  MarketingContent,
  type MarketingSettingsView,
} from '../src/features/billing/marketing-content';

const settings: MarketingSettingsView = {
  signupGiftAmount: '10',
  referralSignupBonus: '5',
  referralCommissionRate: '0.1',
  updatedBy: 3,
  updatedAt: '2026-08-25T00:00:00.000Z',
};

function renderContent(canUpdate: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MarketingContent settings={settings} error={null} canUpdate={canUpdate} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MarketingContent 权限显隐（growth:update）', () => {
  it('无权：三个输入禁用、保存钮隐藏（只读表单）', () => {
    renderContent(false);
    expect(screen.getByLabelText(/signup gift/i)).toBeDisabled();
    expect(screen.getByLabelText(/referral signup bonus/i)).toBeDisabled();
    expect(screen.getByLabelText(/commission rate/i)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('有权：输入可编辑、保存钮在', () => {
    renderContent(true);
    expect(screen.getByLabelText(/signup gift/i)).toBeEnabled();
    expect(screen.getByLabelText(/referral signup bonus/i)).toBeEnabled();
    expect(screen.getByLabelText(/commission rate/i)).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
