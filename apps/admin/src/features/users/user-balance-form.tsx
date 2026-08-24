'use client';

import { FieldLabel, FormItem, Textarea } from '@tillgate/ui';
import type { UseFormReturn } from 'react-hook-form';

/**
 * 余额类弹窗（调整/赠送）共享的表单契约与字段件。
 * 金额字段以字符串保存原始输入（NumberField + numericText），
 * 修复「数字输入框的 0 无法删除/覆盖」问题。
 */
export interface BalanceFormValues {
  amount: string;
  remark: string;
}

/** 备注/文本域字段（余额类弹窗共用） */
export function TextareaField({
  form,
  name,
  label,
  id,
}: {
  form: UseFormReturn<BalanceFormValues>;
  name: 'remark';
  label: string;
  id: string;
}) {
  return (
    <FormItem>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea id={id} rows={2} {...form.register(name)} />
    </FormItem>
  );
}
