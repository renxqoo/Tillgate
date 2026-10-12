'use client';

import { ToggleGroup, ToggleGroupItem } from '@tillgate/ui';

/** 单选 ToggleGroup（value 单值数组语义；next 取新选中项） */
export function TrendToggle<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  const { value, options, onChange } = props;
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(values: string[]) => {
        const next = values.find((v) => v !== value);
        if (next != null) onChange(next as T);
      }}
      variant="outline"
      size="sm"
    >
      {options.map((opt) => (
        <ToggleGroupItem key={opt.value} value={opt.value}>
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
