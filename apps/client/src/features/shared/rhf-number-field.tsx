'use client';

import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';

import { Field, FieldError, FieldLabel, Input } from '@tillgate/ui';

/**
 * 数字输入（react-hook-form + Controller 封装）。
 * 编辑期间以字符串保存原始输入（清空保持空串，不被 Number('')===0 回写成 0），
 * 数值解析交给提交时的表单逻辑；表单值类型必须为 string。
 */
export interface RhfNumberFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  id?: string;
  step?: string;
  min?: number;
  placeholder?: string;
}

export function RhfNumberField<T extends FieldValues>({
  control,
  name,
  label,
  id,
  step,
  min,
  placeholder,
}: RhfNumberFieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
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
        </Field>
      )}
    />
  );
}
