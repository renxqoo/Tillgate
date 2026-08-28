// @vitest-environment jsdom
/**
 * 计费时区卡权限显隐：无 settings:update →
 * 选择器与保存钮不渲染，只读展示当前值（未配置回落缺省 Asia/Shanghai 展示，
 * 与网关 BILLING_TIMEZONE_DEFAULT 同口径）；持有时完整编辑面。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

const getTimezone = vi.fn();

vi.mock('@/server/settings-actions', async () => {
  const actual = await vi.importActual<object>('@/server/settings-actions');
  return {
    ...actual,
    getBillingTimezoneAction: () => getTimezone(),
    updateBillingTimezoneAction: vi.fn(),
  };
});

import { BillingTimezoneCard } from '../src/features/funds/billing-timezone-card';

function renderCard(canUpdate: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BillingTimezoneCard canUpdate={canUpdate} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BillingTimezoneCard 权限显隐（settings:update）', () => {
  it('无权：只读展示当前时区，无选择器无保存钮', async () => {
    getTimezone.mockResolvedValue({ timezone: 'UTC' });
    renderCard(false);
    await waitFor(() => {
      expect(screen.getByText('UTC')).toBeInTheDocument();
    });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('无权 + 未配置：回落缺省口径展示（Asia/Shanghai）', async () => {
    getTimezone.mockResolvedValue({ timezone: null });
    renderCard(false);
    await waitFor(() => {
      expect(screen.getByText('Asia/Shanghai')).toBeInTheDocument();
    });
  });

  it('有权：选择器 + 保存钮在（编辑面完整）', async () => {
    getTimezone.mockResolvedValue({ timezone: 'UTC' });
    renderCard(true);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
