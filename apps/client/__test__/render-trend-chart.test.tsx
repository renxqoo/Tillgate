// @vitest-environment jsdom
/**
 * TrendChart 渲染规格（jsdom）：
 *  - 粒度/度量 ToggleGroup 交互（切 hour 触发懒加载——server action 打桩）；
 *  - 堆叠系列存在性（模型 × 度量；含点模型名走函数 dataKey 不丢系列）；
 *  - Toggle 常驻：加载态/失败态/空态下切换件不消失（失败可重试/切回 day）；
 *  - requests 度量系列名用 Requests 词表（不落 costLabel）。
 * 词表单一真相 = messages/en.json；loadHourlyTrendAction 打桩。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

import type { UsageTrendRow } from '@tillgate/api-client';

vi.mock('@/server/actions/usage', () => ({
  loadHourlyTrendAction: vi.fn(),
}));

import { loadHourlyTrendAction } from '@/server/actions/usage';
import { TrendChart } from '../src/features/dashboard/trend-chart/index';

const NOW = new Date('2026-10-12T06:30:00Z'); // 上海 10-12 14:30

const dayRows: UsageTrendRow[] = [
  {
    bucket: '2026-10-12',
    model: 'gemini-2.5-flash',
    requests: 2,
    inputTokens: 100,
    outputTokens: 40,
    cachedInputTokens: 10,
    cost: '0.12',
  },
  {
    bucket: '2026-10-11',
    model: 'claude-y',
    requests: 1,
    inputTokens: 30,
    outputTokens: 20,
    cachedInputTokens: 5,
    cost: '0.05',
  },
];

function renderChart() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TrendChart dayRows={dayRows} timeZone="Asia/Shanghai" now={NOW} />
    </NextIntlClientProvider>,
  );
}

/**
 * 每条面积曲线自身的 y 坐标集合（`d` 的全部 x,y 坐标对）。
 * 逐曲线值敏感断言：某系列被静默归零（如深路径解析失败）→ 该曲线是平线
 * （自身 y 全等）——混合场景（部分系列零部分真值）下整体集合断言检不出，
 * 逐曲线判定可检出。
 */
function ySetPerCurve(container: HTMLElement): number[][] {
  return Array.from(container.querySelectorAll('.recharts-area-curve')).map((curve) => {
    const d = curve.getAttribute('d') ?? '';
    const ys: number[] = [];
    // 抓所有 "x,y" 坐标对的 y（recharts 曲线以 C 段为主，不能只匹配 M/L 头）
    for (const m of d.matchAll(/([\d.]+),([\d.]+)/g)) {
      ys.push(Number(m[2]));
    }
    return ys;
  });
}

/** ResizeObserver 桩（recharts 依赖；jsdom 无）——构造器 + 原型空方法（模块级，lint 口径） */
function ResizeObserverStub(this: ResizeObserver): void {
  /* 空实现 */
}
ResizeObserverStub.prototype.observe = (): void => {};
ResizeObserverStub.prototype.unobserve = (): void => {};
ResizeObserverStub.prototype.disconnect = (): void => {};

beforeAll(() => {
  // recharts 依赖 ResizeObserver（jsdom 无）；Element.getBoundingClientRect 默认全 0
  // —— ResponsiveContainer 拿不到尺寸不渲染 series，给非零尺寸替身
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: 640,
    height: 250,
    top: 0,
    left: 0,
    bottom: 250,
    right: 640,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
});

afterEach(() => {
  vi.mocked(loadHourlyTrendAction).mockReset();
  cleanup();
});

describe('TrendChart（双粒度趋势图）', () => {
  it('默认 day + cost：切换件常驻、两模型堆叠系列（含点模型名不丢）', () => {
    const { container } = renderChart();
    expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hourly' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tokens' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Requests' })).toBeInTheDocument();
    // 两个模型各一条 cost 系列（含点模型名 gemini-2.5-flash 走函数 dataKey）
    const areas = container.querySelectorAll('.recharts-area');
    expect(areas.length).toBe(2);
    // 回归（逐曲线值敏感）：字符串深路径 dataKey 曾把含点模型系列静默归零
    // （该曲线平线）。函数 dataKey 取真值 → 有消费的曲线自身 y 有抬升。
    // 含点模型（gemini-2.5-flash）首日有值 → 其曲线必须非平线。
    const perCurve = ySetPerCurve(container);
    expect(perCurve.length).toBe(2);
    // 两模型首日都有真值 → 两条曲线各自非平线（对照验证：含点模型被归零的
    // 旧 bug 形态下 nonFlat=1，此断言红——混合场景可检出）
    const nonFlat = perCurve.filter((ys) => new Set(ys).size > 1);
    expect(nonFlat.length).toBe(2);
  });

  it('切 Tokens：模型 × 三系列分列（6 条）', async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    await user.click(screen.getByRole('button', { name: 'Tokens' }));
    expect(container.querySelectorAll('.recharts-area').length).toBe(6);
  });

  it('切 Requests：图例模型名在场（含点模型不丢；requests 系列可渲染）', async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    await user.click(screen.getByRole('button', { name: 'Requests' }));
    // 自绘图例：模型清单（含点模型名在场——回归：深路径曾解析为 0）
    const legendText = container.textContent ?? '';
    expect(legendText.includes('gemini-2.5-flash')).toBe(true);
    expect(legendText.includes('claude-y')).toBe(true);
    // 两模型各一条 requests 系列
    expect(container.querySelectorAll('.recharts-area').length).toBe(2);
  });

  it('切 Hourly：加载态文案出现，数据到位后渲染且 Toggle 常驻', async () => {
    const user = userEvent.setup();
    // 手动 deferred（定时器与 findByText 轮询有竞态——先锁挂起，断言加载态后再放行）
    const holder: { release?: (rows: UsageTrendRow[]) => void } = {};
    const gate = new Promise<UsageTrendRow[]>((resolve) => {
      holder.release = resolve;
    });
    vi.mocked(loadHourlyTrendAction).mockReturnValue(gate);
    const { container } = renderChart();
    await user.click(screen.getByRole('button', { name: 'Hourly' }));
    // 加载态：文案在场，切换件不消失（失败不再吞掉 Toggle）
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
    holder.release?.([
      {
        bucket: '2026-10-12T05:00:00',
        model: 'gemini-2.5-flash',
        requests: 1,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: 1,
        cost: '0.01',
      },
    ]);
    await waitFor(() => {
      expect(container.querySelectorAll('.recharts-area').length).toBe(1);
    });
  });

  it('hour 加载失败：失败态 + Retry 重调 action，切换件常驻可切回 day', async () => {
    const user = userEvent.setup();
    vi.mocked(loadHourlyTrendAction).mockResolvedValue(null);
    renderChart();
    await user.click(screen.getByRole('button', { name: 'Hourly' }));
    // 失败态就位（action 微任务结算后渲染）
    expect(
      await screen.findByText('Failed to load hourly data', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(vi.mocked(loadHourlyTrendAction)).toHaveBeenCalledTimes(1);
    // Retry 点击 → action 重调（回归：曾只清标志不重拉——按钮死了）
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(vi.mocked(loadHourlyTrendAction)).toHaveBeenCalledTimes(2);
    });
    // 重试仍失败 → 失败态回归（不卡 Loading 假态）
    expect(
      await screen.findByText('Failed to load hourly data', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    // Toggle 常驻：可切回 Daily（不再被困在空态）
    await user.click(screen.getByRole('button', { name: 'Daily' }));
    expect(screen.getByRole('button', { name: 'Cost' })).toBeInTheDocument();
  });

  it('Retry 后成功：失败态可恢复到图表（不卡死）', async () => {
    const user = userEvent.setup();
    const action = vi.mocked(loadHourlyTrendAction);
    action.mockResolvedValueOnce(null);
    action.mockResolvedValueOnce([
      {
        bucket: '2026-10-12T05:00:00',
        model: 'gemini-2.5-flash',
        requests: 1,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: 1,
        cost: '0.01',
      },
    ] satisfies UsageTrendRow[]);
    const { container } = renderChart();
    await user.click(screen.getByRole('button', { name: 'Hourly' }));
    expect(
      await screen.findByText('Failed to load hourly data', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      // hour 数据到位 → 单模型单系列渲染
      expect(container.querySelectorAll('.recharts-area').length).toBe(1);
    });
  });

  it('hover 数据点弹出 tooltip 内容（回归：wrapper 透传缺失曾致 tooltip 永不显示）', async () => {
    const { container } = renderChart();
    const surface = container.querySelector('.recharts-surface');
    expect(surface).not.toBeNull();
    await act(async () => {
      if (surface != null) fireEvent.mouseMove(surface, { clientX: 300, clientY: 100 });
      await new Promise((r) => {
        setTimeout(r, 60);
      });
    });
    const tip = container.querySelector('.recharts-tooltip-wrapper');
    // active 态 wrapper 有内容（透传链修复后）；旧实现 innerHTML 恒空
    expect((tip?.innerHTML ?? '').length).toBeGreaterThan(0);
    // 数值格式化进内容（¥ 前缀 cost 度量）
    expect(tip?.textContent ?? '').toMatch(/¥/u);
  });

  it('day 空数据：空态文案 + Toggle 仍常驻', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <TrendChart dayRows={[]} timeZone="Asia/Shanghai" now={NOW} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No usage data yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
  });
});
