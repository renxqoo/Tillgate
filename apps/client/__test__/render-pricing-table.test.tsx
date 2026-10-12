// @vitest-environment jsdom
/**
 * 公开定价表渲染规格（jsdom）：
 *  - 列语义：token 制三轴在价格单元格内、其余制走单位价后缀；无整列「—」空列；
 *  - 分时段：窗口价格缺轴时回落到模型基价，无时段策略渲染占位符；
 *  - 结构契约：tbody 下只出现单元格，模型行内不再嵌套子 <tr>（旧实现的无效 HTML）；
 *  - 表头：目录含 token 制模型时带「¥ / 1M Token」口径后缀，纯单位价目录不带。
 * 词表单一真相 = messages/en.json。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { PricingModel } from '@tillgate/api-client';

import en from '../messages/en.json';
import { PricingTable } from '../src/features/pricing/pricing-table';

type T = (key: string, values?: Record<string, string | number>) => string;

/** 词表取值的测试替身（next-intl client provider 的 t 语义：key 路径 + 参数插值） */
function makeT(namespace: Record<string, unknown>): T {
  return (key, values) => {
    const raw = String(key)
      .split('.')
      .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], namespace);
    const text = typeof raw === 'string' ? raw : key;
    return Object.entries(values ?? {}).reduce(
      (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
      text,
    );
  };
}

function model(over: Partial<PricingModel> = {}): PricingModel {
  return {
    id: 1,
    externalName: 'gpt-test',
    contextLength: 262_144,
    pricingUnit: 'token',
    inputPrice: '2',
    outputPrice: '8',
    cacheInputPrice: '0.2',
    unitPrice: '0',
    isFree: false,
    ...over,
  };
}

function renderTable(models: readonly PricingModel[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PricingTable models={models} t={makeT(en.pricing)} />
    </NextIntlClientProvider>,
  );
}

function body(): HTMLElement {
  return screen.getAllByRole('rowgroup').at(-1) as HTMLElement;
}

afterEach(() => cleanup());

describe('PricingTable', () => {
  it('token 制：输入 / 输出 / 缓存命中三轴同处价格单元格，行数 = 模型数', () => {
    renderTable([model()]);
    const rows = within(body()).getAllByRole('row');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('¥2')).toBeInTheDocument();
    expect(screen.getByText('¥8')).toBeInTheDocument();
    expect(screen.getByText('¥0.2')).toBeInTheDocument();
    expect(screen.getByText('262K')).toBeInTheDocument();
  });

  it('单位价制：价格单元格带单位后缀，且不渲染 token 三轴', () => {
    renderTable([
      model({
        pricingUnit: 'request',
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
        unitPrice: '0.8',
      }),
    ]);
    expect(screen.getByText('¥0.8/request')).toBeInTheDocument();
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
    expect(screen.queryByText('Cache hit')).not.toBeInTheDocument();
  });

  it('未知计价单位：单位原样回显（不空白、不崩溃）', () => {
    renderTable([model({ pricingUnit: 'audio', unitPrice: '3' })]);
    expect(screen.getAllByText('audio').length).toBeGreaterThan(0);
    expect(screen.getByText('¥3')).toBeInTheDocument();
  });

  it('分时段：窗口价格缺轴回落到模型基价；无时段渲染占位符', () => {
    renderTable([
      model({
        id: 1,
        schedule: [
          { label: 'Peak', start: '18:00', end: '09:00', inputPrice: '1', outputPrice: '4' },
          { start: '00:00', end: '08:00', outputPrice: '4.8' },
        ],
      }),
      model({ id: 2 }),
    ]);
    // 窗口未给 inputPrice → 回落到模型基价 2
    expect(screen.getByText('in ¥1 / out ¥4')).toBeInTheDocument();
    // 完全未给价格的窗口 → 双轴回落到基价
    expect(screen.getByText('in ¥2 / out ¥4.8')).toBeInTheDocument();
    expect(screen.getByText('Peak')).toBeInTheDocument();
  });

  it('结构契约：模型行内不再嵌套子 <tr>（tbody 直系子元素只有 tr，tr 直系只有 th/td）', () => {
    const { container } = renderTable([model({ schedule: [{ start: '00:00', end: '08:00' }] })]);
    for (const tbody of container.querySelectorAll('tbody')) {
      for (const child of Array.from(tbody.children)) {
        expect(child.tagName).toBe('TR');
        for (const cell of Array.from(child.children)) {
          expect(['TD', 'TH']).toContain(cell.tagName);
          expect(cell.querySelector('tr')).toBeNull();
        }
      }
    }
    // 5 列 / 1 行模型
    expect(body().querySelectorAll('tr')[0]?.children).toHaveLength(5);
  });

  it('表头：含 token 制模型时带 ¥ / 1M Token 口径后缀；纯单位价目录不带', () => {
    const { unmount } = renderTable([model()]);
    expect(screen.getByText('Price (¥ / 1M tokens)')).toBeInTheDocument();
    unmount();
    cleanup();
    renderTable([model({ pricingUnit: 'request', unitPrice: '0.8' })]);
    expect(screen.getByText('Price')).toBeInTheDocument();
  });

  it('免费模型：价格单元格整格给「Free」，不渲染三行破折号', () => {
    renderTable([model({ isFree: true, contextLength: null })]);
    // 模型名徽标 1 + 价格单元格 1
    expect(screen.getAllByText('Free')).toHaveLength(2);
    // 上下文缺失 + 无时段策略 = 两个占位符
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('非免费模型的零价仍按三轴逐项渲染（不误判为免费）', () => {
    renderTable([model({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })]);
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4); // 三轴价格 + 无时段
  });
});
