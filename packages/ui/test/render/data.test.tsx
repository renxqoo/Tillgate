import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  createMoneyFormatter,
  DataTable,
  KpiCard,
  MoneyDisplay,
  SecretReveal,
  StatusPill,
  type DataTableSortState,
} from '../../src/index';

describe('StatusPill', () => {
  it('渲染语义色调与圆点', () => {
    render(<StatusPill tone="success">运行中</StatusPill>);
    const pill = screen.getByText('运行中');
    expect(pill).toHaveAttribute('data-tone', 'success');
    expect(pill.className).toContain('bg-success');
    expect(pill.querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it('dot=false 关闭圆点', () => {
    render(
      <StatusPill tone="destructive" dot={false}>
        已停用
      </StatusPill>,
    );
    expect(screen.getByText('已停用').querySelector('span[aria-hidden]')).toBeNull();
  });
});

describe('MoneyDisplay', () => {
  const money = createMoneyFormatter({ locale: 'en-US', currency: 'USD' });

  it('用注入的 format 渲染金额', () => {
    const format = vi.fn(money.format);
    render(<MoneyDisplay amount={1234.5} format={format} />);
    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
    expect(format).toHaveBeenCalledWith(1234.5);
  });

  it('tone=auto 按符号着色', () => {
    const { rerender } = render(<MoneyDisplay amount={-5} format={money.format} />);
    expect(screen.getByText('-$5.00').className).toContain('text-destructive');
    rerender(<MoneyDisplay amount={5} format={money.format} />);
    expect(screen.getByText('$5.00').className).toContain('text-success');
    rerender(<MoneyDisplay amount={0} format={money.format} />);
    expect(screen.getByText('$0.00').className).toContain('text-foreground');
  });

  it('tone=none 不着色', () => {
    render(<MoneyDisplay amount={-5} format={money.format} tone="none" />);
    expect(screen.getByText('-$5.00').className).not.toContain('text-destructive');
  });
});

describe('KpiCard', () => {
  it('渲染 label/value', () => {
    render(<KpiCard label="今日消费" value="$1,234.50" />);
    expect(screen.getByText('今日消费')).toBeInTheDocument();
    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
  });

  it('loading 态用骨架替代数值', () => {
    render(<KpiCard label="今日消费" value="$1,234.50" loading />);
    expect(screen.queryByText('$1,234.50')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="kpi-card"] .animate-pulse')).not.toBeNull();
  });

  it('delta 显式 sentiment 决定颜色(涨≠默认好)', () => {
    render(
      <KpiCard
        label="成本"
        value="$99"
        delta={{ trend: 'up', sentiment: 'negative', text: '+12%' }}
      />,
    );
    const delta = document.querySelector('[data-slot="kpi-card-delta"]');
    expect(delta).not.toBeNull();
    expect(delta?.getAttribute('data-sentiment')).toBe('negative');
    expect(delta?.className).toContain('text-destructive');
  });

  it('delta sentiment=neutral 用弱化色', () => {
    render(
      <KpiCard
        label="请求数"
        value="1.2M"
        delta={{ trend: 'flat', sentiment: 'neutral', text: '0%' }}
      />,
    );
    const delta = document.querySelector('[data-slot="kpi-card-delta"]');
    expect(delta?.className).toContain('text-muted-foreground');
  });

  it('hint 渲染为弱化说明', () => {
    render(<KpiCard label="请求量" value="1.2M" hint="近 24 小时" />);
    expect(document.querySelector('[data-slot="kpi-card-hint"]')?.textContent).toBe('近 24 小时');
  });
});

describe('SecretReveal', () => {
  it('默认遮蔽, 切换后显示明文', async () => {
    render(<SecretReveal value="sk-live-abc123" />);
    expect(screen.getByText('••••••••')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reveal secret' }));
    expect(screen.getByText('sk-live-abc123')).toBeInTheDocument();
    expect(
      screen.getByText('sk-live-abc123').closest('[data-slot="secret-reveal"]'),
    ).toHaveAttribute('data-revealed', 'true');
  });

  it('copy=true 时复制明文(与显隐无关)', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<SecretReveal value="sk-live-abc123" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy secret' }));
    expect(writeText).toHaveBeenCalledWith('sk-live-abc123');
  });

  it('copy=false 不渲染复制按钮', () => {
    render(<SecretReveal value="x" copy={false} />);
    expect(screen.queryByRole('button', { name: 'Copy secret' })).toBeNull();
  });
});

interface TestRow {
  id: string;
  name: string;
  amount: number;
}

const ROWS: TestRow[] = [
  { id: 'a', name: '渠道 A', amount: 10 },
  { id: 'b', name: '渠道 B', amount: 20 },
];

const COLUMNS = [
  { key: 'name', header: '名称', cell: (row: TestRow) => row.name },
  {
    key: 'amount',
    header: '金额',
    align: 'right' as const,
    sortable: true,
    cell: (row: TestRow) => row.amount,
  },
];

describe('DataTable', () => {
  it('渲染行与单元格', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(screen.getByText('渠道 A')).toBeInTheDocument();
    expect(screen.getByText('渠道 B')).toBeInTheDocument();
    expect(screen.getByText('金额')).toBeInTheDocument();
  });

  it('排序三态切换: asc → desc → 清除(受控: 每次点击回灌新 sort)', async () => {
    const states: Array<DataTableSortState | null> = [];
    let sort: DataTableSortState | null = null;
    const onSortChange = (next: DataTableSortState | null) => {
      states.push(next);
      sort = next;
    };
    const table = (current: DataTableSortState | null) => (
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        sort={current}
        onSortChange={onSortChange}
      />
    );
    const { rerender } = render(table(sort));
    for (let click = 0; click < 3; click += 1) {
      await userEvent.click(screen.getByRole('button', { name: /金额/ }));
      rerender(table(sort));
    }
    expect(states).toEqual([
      { key: 'amount', direction: 'asc' },
      { key: 'amount', direction: 'desc' },
      null,
    ]);
    // 受控: 传入 desc 后指示器存在
    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        sort={{ key: 'amount', direction: 'desc' }}
        onSortChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /金额/ }).querySelector('svg')).not.toBeNull();
  });

  it('未提供 onSortChange 时表头不渲染为按钮', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} sort={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('金额')).toBeInTheDocument();
  });

  it('loading 渲染骨架行', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        loading
        loadingRowCount={3}
      />,
    );
    expect(document.querySelectorAll('[data-slot="data-table-skeleton-row"]')).toHaveLength(3);
    expect(screen.queryByText('No data')).not.toBeInTheDocument();
  });

  it('空数据渲染默认空态, 可注入自定义空态', () => {
    const { rerender } = render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.id} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
    rerender(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        empty={<span>暂无渠道</span>}
      />,
    );
    expect(screen.getByText('暂无渠道')).toBeInTheDocument();
  });

  it('rowKey 决定行 key', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    const cells = screen.getAllByText(/渠道 [AB]/);
    expect(cells).toHaveLength(2);
  });
});
