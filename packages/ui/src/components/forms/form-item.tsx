'use client';

// FormItem 独立模块: 表单项容器, 统一 label 与控件的布局契约。
// 职责边界: 本文件只管视觉布局(方向/间距/禁用态)与 id 上下文分发,
// RHF 状态接线(Form/FormField/useFormField/FormLabel/…)在 form.tsx;
// 依赖方向 form.tsx -> 本文件(经 FormItemContext), 反向无依赖、无环
import * as React from 'react';

import { Field } from './field';
import { cn } from '../../cn';

// Tailwind 按完整类名字面量收集, gap 档位必须静态枚举(`gap-${n}` 动态拼接会产出未生成类)
const FORM_ITEM_GAP = {
  0: 'gap-0',
  0.5: 'gap-0.5',
  1: 'gap-1',
  1.5: 'gap-1.5',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
} as const;

export type FormItemProps = React.ComponentProps<typeof Field> & {
  /** label 与控件的间距档位(tailwind gap 刻度), 默认 2; 覆写 Field 基类 gap-2 */
  gap?: keyof typeof FORM_ITEM_GAP;
  /** 糖衣: 落到 data-disabled, 驱动 FieldLabel/FieldTitle 置灰(div 无原生 disabled 属性) */
  disabled?: boolean;
};

type FormItemContextValue = { id: string };

export const FormItemContext = React.createContext<FormItemContextValue | null>(null);

// 布局契约: orientation 透传 Field(vertical 默认 / horizontal / responsive),
// gap 只统一间距不改 flex 方向 —— 垂直/水平布局下均生效
export function FormItem({ className, gap = 2, disabled, ...props }: FormItemProps) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <Field
        data-slot="form-item"
        data-disabled={disabled || undefined}
        className={cn(FORM_ITEM_GAP[gap], className)}
        {...props}
      />
    </FormItemContext.Provider>
  );
}
