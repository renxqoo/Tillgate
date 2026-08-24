'use client';

import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';

import { FieldError, FieldLabel, FormItem, Input } from '@tillgate/ui';

export interface NumberFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  id?: string;
  step?: string;
  min?: number;
  placeholder?: string;
}

/**
 * 数字输入（react-hook-form + Controller 封装）。
 *
 * 编辑期间以字符串保存原始输入（清空后保持空串，不会被 Number('')===0 回写成 0），
 * 数值解析交给提交时的表单 schema（见 @/lib/forms 的 numericText）。
 * 表单值类型必须为 string，提交时由业务方 Number() 转换。
 */
export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  id,
  step,
  min,
  placeholder,
}: NumberFieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FormItem data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id ?? name}>{label}</FieldLabel>
          <Input
            id={id ?? name}
            type="number"
            inputMode="decimal"
            step={step}
            min={min}
            placeholder={placeholder}
            {...field}
            value={field.value ?? ''}
            onChange={(e) => field.onChange(e.target.value)}
          />
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </FormItem>
      )}
    />
  );
}
