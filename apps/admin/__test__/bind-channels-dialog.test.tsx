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
import { fireEvent } from '@testing-library/react';
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
    inputPrice: '2',
    outputPrice: '8',
    cacheInputPrice: '0.4',
    cacheWritePrice: '1',
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

describe('BindChannelsDialog：成本覆盖编辑区（预填模型卖价 + 免费快捷）', () => {
  it('成本覆盖编辑区单位感知：image 模型只显单位成本轴，预填模型单位卖价', () => {
    // 回归锚点（双轨定价 + 预填裁决）：成本轴经 PricingEditor 与官方轴同构——
    // image 模型不再渲染 token 四价轴，空成本绑定预填模型卖价（真实值可改）
    const imageModel = {
      ...modelOf([{ channelId: 1, upstreamModel: 'up-a' }]),
      pricingUnit: 'image',
      unitPrice: '0.02',
    } as AdminModelRow;
    renderDialog(imageModel, true);
    fireEvent.click(screen.getByRole('button', { name: /Cost price override/ }));

    expect(screen.getByText('Cost unit price')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost unit price')).toHaveValue(0.02);
    // token 四价轴不出现（单位计价模型的成本轴分派）
    expect(screen.queryByText('Cost input price')).not.toBeInTheDocument();
    // 分时段编辑与官方轴同构可用
    expect(screen.getByText('Time-of-day pricing')).toBeInTheDocument();
  });

  it('成本覆盖编辑区：token 模型显四价成本轴（单位成本轴不出现）', () => {
    renderDialog(modelOf([{ channelId: 1, upstreamModel: 'up-a' }]), true);
    fireEvent.click(screen.getByRole('button', { name: /Cost price override/ }));

    expect(screen.getByText('Cost input price')).toBeInTheDocument();
    expect(screen.getByText('Cost output price')).toBeInTheDocument();
    expect(screen.getByText('Cost cache-hit price')).toBeInTheDocument();
    expect(screen.getByText('Cost cache-write price')).toBeInTheDocument();
    expect(screen.queryByText('Cost unit price')).not.toBeInTheDocument();
  });

  it('免费渠道回显：成本五轴全 0（价格推导勾选态），轴灰化策略隐藏', () => {
    const freeBound = modelOf([
      {
        channelId: 1,
        upstreamModel: 'up-a',
        costInputPrice: '0',
        costOutputPrice: '0',
        costCacheInputPrice: '0',
        costCacheWritePrice: '0',
        costUnitPrice: '0',
        costConfig: {},
      },
    ] as never) as AdminModelRow;
    renderDialog(freeBound, true);
    fireEvent.click(screen.getByRole('button', { name: /Cost price override/ }));

    expect(screen.getByRole('checkbox', { name: /Free channel/ })).toBeChecked();
    // 免费态 = 成本显式 0：输入灰化，策略编辑隐藏（免费与窗口/档位价矛盾）
    expect(screen.getByLabelText('Cost input price')).toBeDisabled();
    expect(screen.queryByText('Time-of-day pricing')).not.toBeInTheDocument();
  });

  it('免费渠道开关交互：勾选=成本清零快捷（写 0），取消回继承可编辑', async () => {
    const user = userEvent.setup();
    renderDialog(modelOf([{ channelId: 1, upstreamModel: 'up-a' }]), true);
    fireEvent.click(screen.getByRole('button', { name: /Cost price override/ }));

    const input = screen.getByLabelText('Cost input price');
    expect(screen.getByText('Time-of-day pricing')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Free channel/ }));

    expect(screen.getByRole('checkbox', { name: /Free channel/ })).toBeChecked();
    expect(input).toBeDisabled();
    // 免费即价格取值：勾选把五轴写成显式 0（提交 '0' 成本，无平行标记）
    expect(input).toHaveValue(0);
    expect(screen.queryByText('Time-of-day pricing')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Free channel/ }));
    expect(screen.getByRole('checkbox', { name: /Free channel/ })).not.toBeChecked();
    expect(input).not.toBeDisabled();
    // 取消免费恢复预填模型卖价（价格即事实，无平行标记）
    expect(input).toHaveValue(2);
    expect(screen.getByText('Time-of-day pricing')).toBeInTheDocument();
  });

  it('成本预填（用户裁决）：空成本绑定打开即显示模型卖价，保存前可改', () => {
    renderDialog(modelOf([{ channelId: 1, upstreamModel: 'up-a' }]), true);
    fireEvent.click(screen.getByRole('button', { name: /Cost price override/ }));

    expect(screen.getByLabelText('Cost input price')).toHaveValue(2);
    expect(screen.getByLabelText('Cost output price')).toHaveValue(8);
    expect(screen.getByLabelText('Cost cache-hit price')).toHaveValue(0.4);
    expect(screen.getByLabelText('Cost cache-write price')).toHaveValue(1);
    expect(screen.getByRole('checkbox', { name: /Free channel/ })).not.toBeChecked();
  });

  it('成本预填不覆盖已配置值：存量成本原样回显', () => {
    const configured = modelOf([
      {
        channelId: 1,
        upstreamModel: 'up-a',
        costInputPrice: '1.5',
        costOutputPrice: '6',
        costCacheInputPrice: '0.3',
        costCacheWritePrice: '0.8',
        costUnitPrice: '0',
        costConfig: {},
      },
    ] as never) as AdminModelRow;
    renderDialog(configured, true);
    fireEvent.click(screen.getByRole('button', { name: /Cost price override/ }));

    expect(screen.getByLabelText('Cost input price')).toHaveValue(1.5);
    expect(screen.getByLabelText('Cost output price')).toHaveValue(6);
  });
});
