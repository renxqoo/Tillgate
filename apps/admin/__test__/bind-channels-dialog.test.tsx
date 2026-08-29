// @vitest-environment jsdom
/**
 * 绑定渠道弹窗回显规格：弹窗常驻挂载 + 受控 open——每次打开必须从当前
 * model.channels 重建草稿（Radix 不为程序化开启回调 onOpenChange，初始
 * useState 只求值一次）。回归点：保存后 revalidate 送达新 props，重开
 * 弹窗回显新绑定；取消重开丢弃未保存编辑。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { BindChannelsDialog } from '../src/features/models/models-content/bind-channels-dialog';

const CHANNELS: ChannelOption[] = [
  { id: 1, name: 'ch-a', providerName: 'Provider A' },
  { id: 2, name: 'ch-b', providerName: 'Provider B' },
];

/** 最小模型行（弹窗消费 id/externalName/realModel/channels，其余字段满足 DTO 形状） */
function modelOf(channels: Array<{ channelId: number; upstreamModel: string }>): AdminModelRow {
  return {
    id: 9,
    externalName: 'e2e-down',
    realModel: 'mock-mini',
    inputPrice: '0',
    outputPrice: '0',
    cacheInputPrice: '0',
    cacheWritePrice: '0',
    pricingUnit: 'token',
    unitPrice: '0',
    billingConfig: null,
    isFree: false,
    contextLength: null,
    fallbackModels: null,
    paramRules: null,
    billingPolicy: null,
    rpmLimit: null,
    tpmLimit: null,
    status: 0,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    channels,
  } as AdminModelRow;
}

function renderDialog(model: AdminModelRow, open: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BindChannelsDialog model={model} channels={CHANNELS} trigger={null} open={open} />
    </NextIntlClientProvider>,
  );
}

/** 勾选态断言辅助：按渠道列表顺序取 checkbox */
function checkboxOf(channelId: number): HTMLElement {
  const boxes = screen.getAllByRole('checkbox');
  const index = CHANNELS.findIndex((c) => c.id === channelId);
  return boxes[index] as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BindChannelsDialog：受控打开的绑定回显', () => {
  it('打开回显当前绑定（勾选 + 出站名），未绑定渠道不勾选不出输入框', () => {
    renderDialog(modelOf([{ channelId: 1, upstreamModel: 'up-a' }]), true);
    expect(checkboxOf(1)).toBeChecked();
    expect(screen.getByDisplayValue('up-a')).toBeInTheDocument();
    expect(checkboxOf(2)).not.toBeChecked();
    // 出站名输入框只为已勾选渠道渲染：这里仅渠道 1 一根
    expect(screen.getAllByPlaceholderText(/Upstream name/)).toHaveLength(1);
  });

  it('保存后重开回显新绑定（revalidate 送达的新 channels prop）', () => {
    const v1 = modelOf([{ channelId: 1, upstreamModel: 'up-a' }]);
    const { rerender } = renderDialog(v1, true);
    expect(screen.getByDisplayValue('up-a')).toBeInTheDocument();

    // 保存关闭 → revalidate 后父级用新 model 重渲染（常驻挂载不卸载）
    const v2 = modelOf([
      { channelId: 1, upstreamModel: 'up-a2' },
      { channelId: 2, upstreamModel: 'up-b' },
    ]);
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <BindChannelsDialog model={v2} channels={CHANNELS} trigger={null} open={false} />
      </NextIntlClientProvider>,
    );
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <BindChannelsDialog model={v2} channels={CHANNELS} trigger={null} open />
      </NextIntlClientProvider>,
    );

    expect(checkboxOf(1)).toBeChecked();
    expect(checkboxOf(2)).toBeChecked();
    expect(screen.getByDisplayValue('up-a2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('up-b')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('up-a')).not.toBeInTheDocument();
  });

  it('取消重开丢弃未保存编辑（回显重置为当前绑定）', async () => {
    const model = modelOf([{ channelId: 1, upstreamModel: 'up-a' }]);
    const { rerender } = renderDialog(model, true);
    await userEvent.clear(screen.getByDisplayValue('up-a'));
    await userEvent.type(screen.getByDisplayValue(''), 'unsaved-draft');

    const shell = (open: boolean) => (
      <NextIntlClientProvider locale="en" messages={en}>
        <BindChannelsDialog model={model} channels={CHANNELS} trigger={null} open={open} />
      </NextIntlClientProvider>
    );
    rerender(shell(false));
    rerender(shell(true));
    expect(screen.getByDisplayValue('up-a')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('unsaved-draft')).not.toBeInTheDocument();
  });
});
