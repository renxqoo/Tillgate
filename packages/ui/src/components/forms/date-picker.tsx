'use client';

// 日期选择: Popover + Calendar 组合, 覆盖单日(DatePicker)与区间(DateRangePicker)两模式。
// 触发器文案的格式化函数必须注入(formatting/date 工厂产物, 零写死);
// 受控契约: value/onValueChange 完全由调用方持有
import { CalendarIcon, ChevronDownIcon } from 'lucide-react';
import * as React from 'react';
import type { DateRange } from 'react-day-picker';

import { cn } from '../../cn';
import { Button } from '../primitives/button';
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/popover';
import { Calendar } from './calendar';

const triggerClass = 'w-full justify-start font-normal data-placeholder:text-muted-foreground';

function TriggerLabel({
  formatted,
  placeholder,
}: {
  formatted: string | undefined;
  placeholder: string | undefined;
}) {
  return (
    <>
      <CalendarIcon className="text-muted-foreground" />
      <span className={cn('truncate', !formatted && 'text-muted-foreground')}>
        {formatted ?? placeholder}
      </span>
      <ChevronDownIcon className="ms-auto text-muted-foreground" />
    </>
  );
}

export interface DatePickerProps {
  value?: Date;
  onValueChange: (date: Date | undefined) => void;
  // 选中日期在触发器上的展示文案(必填注入, 见 formatting/date)
  format: (date: Date) => string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  numberOfMonths?: number;
}

export function DatePicker({
  value,
  onValueChange,
  format,
  placeholder,
  disabled,
  className,
  numberOfMonths = 1,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            data-slot="date-picker"
            className={cn(triggerClass, className)}
          >
            <TriggerLabel formatted={value ? format(value) : undefined} placeholder={placeholder} />
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(date) => {
            onValueChange(date);
            setOpen(false);
          }}
          numberOfMonths={numberOfMonths}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface DateRangePickerProps {
  value: DateRange | undefined;
  onValueChange: (range: DateRange | undefined) => void;
  // 区间在触发器上的展示文案(必填注入, 见 formatting/date)
  format: (range: DateRange) => string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  numberOfMonths?: number;
}

export function DateRangePicker({
  value,
  onValueChange,
  format,
  placeholder,
  disabled,
  className,
  numberOfMonths = 2,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const formatted =
    value?.from || value?.to ? format({ from: value?.from, to: value?.to }) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            data-slot="date-range-picker"
            className={cn(triggerClass, className)}
          >
            <TriggerLabel formatted={formatted} placeholder={placeholder} />
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={value}
          onSelect={(range) => {
            onValueChange(range);
            // react-day-picker v10 首次点击会给出 from===to 的单日区间(未选满),
            // 只有形成真正跨度(from<to)才收起; 同日双击保持展开由用户手动关闭
            if (range?.from && range?.to && range.from.getTime() !== range.to.getTime()) {
              setOpen(false);
            }
          }}
          numberOfMonths={numberOfMonths}
        />
      </PopoverContent>
    </Popover>
  );
}
