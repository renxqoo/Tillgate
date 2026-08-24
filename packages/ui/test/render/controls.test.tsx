// 补充批次: number-field / date-picker / form 胶水(RHF) 全交互,
// 以及新 vendored 组件(accordion/slider/native-select/button-group/input-otp/calendar/chart)冒烟
import type { ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useForm } from 'react-hook-form';
import type { DateRange } from 'react-day-picker';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  ButtonGroup,
  Calendar,
  ChartContainer,
  DatePicker,
  DateRangePicker,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  NativeSelect,
  NativeSelectOption,
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
  Slider,
} from '../../src/index';

function NumberFieldDemo({ onValueChange }: { onValueChange: (v: number | null) => void }) {
  return (
    <NumberField onValueChange={onValueChange} min={0} step={1}>
      <NumberFieldGroup>
        <NumberFieldDecrement />
        <NumberFieldInput aria-label="数量" />
        <NumberFieldIncrement />
      </NumberFieldGroup>
    </NumberField>
  );
}

const pickFmt = (d: Date) => `PICK:${d.toISOString().slice(0, 10)}`;

// 第一张月网格内按日号定位日期按钮(rerender 后需重查, 不缓存节点)
function firstGridDay(n: number) {
  const grid = screen.getAllByRole('grid')[0]!;
  return within(grid)
    .getAllByRole('gridcell')
    .map((cell) => cell.querySelector('button'))
    .find((btn) => btn?.textContent === String(n));
}

describe('NumberField', () => {
  it('直接输入数值回调', async () => {
    const onValueChange = vi.fn();
    render(<NumberFieldDemo onValueChange={onValueChange} />);
    // Base UI 数字输入渲染为 text+inputmode, 无 spinbutton 隐式角色, 用 label 定位;
    // onValueChange 契约透传原语: (value, eventDetails) 两个参数
    await userEvent.type(screen.getByLabelText('数量'), '42');
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe(42);
  });

  it('步进按钮按 step 增减并尊重 min', async () => {
    const onValueChange = vi.fn();
    const { container } = render(<NumberFieldDemo onValueChange={onValueChange} />);
    const inc = container.querySelector('[data-slot="number-field-increment"]')!;
    const dec = container.querySelector('[data-slot="number-field-decrement"]')!;
    // Base UI 语义: 空值起步的首次 increment 落在 min(0)
    await userEvent.click(inc);
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe(0);
    await userEvent.click(inc);
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe(1);
    await userEvent.click(dec);
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe(0);
    // 到达 min=0 后再次 decrement 仍下发钳制值 0
    await userEvent.click(dec);
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe(0);
  });
});

describe('DatePicker / DateRangePicker', () => {
  it('打开日历选择单日后回传并收起', async () => {
    const onValueChange = vi.fn();
    render(<DatePicker value={undefined} onValueChange={onValueChange} format={pickFmt} />);
    await userEvent.click(screen.getByRole('button'));
    // react-day-picker 网格出现(gridcell 是 td, 点击目标是其内 button)
    expect(screen.getByRole('grid')).toBeInTheDocument();
    const day15 = screen.getByRole('gridcell', { name: /15/ }).querySelector('button');
    expect(day15).not.toBeNull();
    await userEvent.click(day15!);
    expect(onValueChange).toHaveBeenCalled();
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBeInstanceOf(Date);
    // 选择后 popover 收起
    await vi.waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  });

  it('受控 value 在触发器上用注入的 format 渲染', () => {
    render(
      <DatePicker
        value={new Date('2026-08-01T00:00:00Z')}
        onValueChange={() => {}}
        format={pickFmt}
      />,
    );
    expect(screen.getByText('PICK:2026-08-01')).toBeInTheDocument();
  });

  it('区间选择: 受控回灌下选满跨度自动收起', async () => {
    const onValueChange = vi.fn();
    let value: DateRange | undefined;
    const picker = (v: DateRange | undefined) => (
      <DateRangePicker
        value={v}
        onValueChange={(range) => {
          onValueChange(range);
          value = range ?? undefined;
        }}
        format={(r) => `${r.from ? pickFmt(r.from) : ''}~${r.to ? pickFmt(r.to) : ''}`}
      />
    );
    const { rerender } = render(picker(value));
    await userEvent.click(screen.getByRole('button'));
    // 受控契约: 每次选择后回灌 value, 模拟真实消费方
    await userEvent.click(firstGridDay(3)!);
    // 首击返回 from===to 单日区间: 保持展开
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
    rerender(picker(value));
    await userEvent.click(firstGridDay(8)!);
    const last = onValueChange.mock.calls.at(-1)?.[0];
    expect(last?.from?.getDate()).toBe(3);
    expect(last?.to?.getDate()).toBe(8);
    await vi.waitFor(() => expect(document.querySelectorAll('table[role=grid]').length).toBe(0));
  });
});

function RhfDemoForm({ onSubmit }: { onSubmit: (values: { name: string }) => void }) {
  const form = useForm({ defaultValues: { name: '' } });
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((values) => onSubmit(values))}>
        <FormField
          name="name"
          rules={{ required: '名称必填' }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>名称</FormLabel>
              <FormControl>
                <Input placeholder="输入名称" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">提交</Button>
      </form>
    </Form>
  );
}

describe('Form(react-hook-form 胶水)', () => {
  it('校验失败渲染错误并联动 aria, 补齐后可提交', async () => {
    const onSubmit = vi.fn();
    render(<RhfDemoForm onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText('输入名称');
    const submit = screen.getByRole('button', { name: '提交' });
    await userEvent.click(submit);
    expect(await screen.findByText('名称必填')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // label 与控件关联
    expect(screen.getByText('名称')).toHaveAttribute('for', input.getAttribute('id')!);
    await userEvent.type(input, '渠道 A');
    await userEvent.click(submit);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: '渠道 A' }));
    expect(screen.queryByText('名称必填')).not.toBeInTheDocument();
  });

  it('useFormField 在 FormField/FormItem 之外使用抛错', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<FormLabel>孤立标签</FormLabel>)).toThrow(/FormField/);
    consoleError.mockRestore();
  });
});

// FormItem 布局契约: 默认垂直 + gap-2, 档位/方向/禁用态可调, a11y 描述链接线
function LayoutDemo({ itemProps }: { itemProps?: ComponentProps<typeof FormItem> }) {
  const form = useForm({ defaultValues: { name: '' } });
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(() => {})}>
        <FormField
          name="name"
          rules={{ required: '名称必填' }}
          render={({ field }) => (
            <FormItem {...itemProps}>
              <FormLabel required>名称</FormLabel>
              <FormControl>
                <Input placeholder="输入名称" {...field} />
              </FormControl>
              <FormDescription>帮助文本</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">提交</Button>
      </form>
    </Form>
  );
}

describe('FormItem 布局契约', () => {
  it('默认垂直布局 gap-2, 描述链只挂 description id', () => {
    render(<LayoutDemo />);
    const item = document.querySelector('[data-slot="form-item"]')!;
    expect(item.className).toContain('flex-col');
    expect(item.className).toContain('gap-2');
    expect(item).toHaveAttribute('data-orientation', 'vertical');
    const input = screen.getByPlaceholderText('输入名称');
    expect(input.getAttribute('aria-describedby')).toContain('-description');
    expect(input.getAttribute('aria-describedby')).not.toContain('-error');
  });

  it('gap 档位覆写基类(twMerge 消解 gap-2)且支持水平布局', () => {
    render(<LayoutDemo itemProps={{ gap: 4, orientation: 'horizontal' }} />);
    const item = document.querySelector('[data-slot="form-item"]')!;
    expect(item.className).toContain('gap-4');
    expect(item.className).not.toContain('gap-2');
    expect(item).toHaveAttribute('data-orientation', 'horizontal');
  });

  it('disabled 落 data-disabled, required 渲染视觉星标', () => {
    render(<LayoutDemo itemProps={{ disabled: true }} />);
    expect(document.querySelector('[data-slot="form-item"]')).toHaveAttribute(
      'data-disabled',
      'true',
    );
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('校验失败时描述链追加 error id 并联动 aria-invalid', async () => {
    render(<LayoutDemo />);
    await userEvent.click(screen.getByRole('button', { name: '提交' }));
    const input = screen.getByPlaceholderText('输入名称');
    await vi.waitFor(() => {
      expect(input.getAttribute('aria-describedby')).toContain('-description');
      expect(input.getAttribute('aria-describedby')).toContain('-error');
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('新 vendored 组件冒烟', () => {
  it('Accordion 展开渲染内容', async () => {
    render(
      <Accordion>
        <AccordionItem value="a">
          <AccordionTrigger>折叠标题</AccordionTrigger>
          <AccordionContent>折叠内容</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    expect(screen.getByText('折叠标题')).toBeInTheDocument();
    expect(screen.queryByText('折叠内容')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /折叠标题/ }));
    expect(await screen.findByText('折叠内容')).toBeInTheDocument();
  });

  it('NativeSelect 渲染选项并可切换', async () => {
    const onChange = vi.fn();
    render(
      <NativeSelect aria-label="渠道" onChange={onChange}>
        <NativeSelectOption value="a">渠道 A</NativeSelectOption>
        <NativeSelectOption value="b">渠道 B</NativeSelectOption>
      </NativeSelect>,
    );
    const select = screen.getByRole('combobox', { name: '渠道' });
    await userEvent.selectOptions(select, 'b');
    expect(onChange).toHaveBeenCalled();
    expect((select as HTMLSelectElement).value).toBe('b');
  });

  it('ButtonGroup 渲染按钮组', () => {
    render(
      <ButtonGroup>
        <Button>日</Button>
        <Button>周</Button>
        <Button>月</Button>
      </ButtonGroup>,
    );
    expect(screen.getByRole('group')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('InputOTP 渲染输入槽', () => {
    render(
      <InputOTP maxLength={6} aria-label="验证码">
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
        </InputOTPGroup>
      </InputOTP>,
    );
    expect(document.querySelector('[data-slot="input-otp"]')).not.toBeNull();
  });

  it('Slider 渲染滑杆', () => {
    const { container } = render(<Slider defaultValue={[50]} />);
    expect(container.querySelector('[data-slot="slider"]')).not.toBeNull();
  });

  it('Calendar 渲染月网格', () => {
    render(<Calendar mode="single" />);
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(screen.getByRole('grid').querySelectorAll('td').length).toBeGreaterThan(20);
  });

  it('ChartContainer 挂 config 渲染容器(jsdom 零尺寸, 只验证容器与配色注入)', () => {
    const { container } = render(
      <ChartContainer
        config={{
          revenue: { label: 'Revenue', color: 'var(--chart-1)' },
        }}
        className="h-40 w-full"
      >
        <div>chart-body</div>
      </ChartContainer>,
    );
    expect(container.querySelector('div[data-chart]')).not.toBeNull();
    expect(container.textContent).toContain('--color-revenue');
  });
});
