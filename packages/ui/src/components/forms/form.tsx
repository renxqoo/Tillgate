'use client';

// react-hook-form 胶水: 把 RHF 的字段状态接到本包 Field 原语上。
// 分工: Form/FormField 管状态接线(name/value/onChange/onBlur/错误),
// 视觉层完全复用 Field/FieldLabel/FieldError/FieldDescription; 校验器(resolver/zod)由调用方自选。
// FormItemContext 与布局件 FormItem 住在 form-item.tsx(依赖方向 本文件 → form-item, 反向无依赖);
// 描述链: FormDescription 挂载时注册 id,FormControl 据此拼 aria-describedby
// (有效态只挂 description id,校验失败追加 error id 并联动 aria-invalid)
import * as React from 'react';
import {
  Controller,
  FormProvider,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';

import { FieldDescription, FieldError, FieldLabel } from './field';
import { FormItemContext } from './form-item';

export const Form = FormProvider;

const FormFieldContext = React.createContext<{ name: string } | null>(null);

/** FormDescription 挂载登记（FormField 持有 state,FormControl 消费拼描述链） */
const DescriptionIdContext = React.createContext<{
  descriptionId: string | null;
  setDescriptionId: (id: string | null) => void;
} | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  const [descriptionId, setDescriptionId] = React.useState<string | null>(null);
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <DescriptionIdContext.Provider value={{ descriptionId, setDescriptionId }}>
        <Controller {...props} />
      </DescriptionIdContext.Provider>
    </FormFieldContext.Provider>
  );
}

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const descriptionContext = React.useContext(DescriptionIdContext);
  // 先于 useFormState 抛错: 无 Provider 时 RHF 会先抛自己的错误, 淹没本契约信息
  if (!fieldContext || !itemContext) {
    throw new Error('useFormField must be used within <FormField><FormItem>');
  }
  const formState = useFormState({ name: fieldContext.name });
  const error = formState.errors[fieldContext.name];
  return {
    name: fieldContext.name,
    id: itemContext.id,
    invalid: Boolean(error),
    message: typeof error?.message === 'string' ? error.message : undefined,
    descriptionId: descriptionContext?.descriptionId ?? null,
    setDescriptionId: descriptionContext?.setDescriptionId,
  };
}

export function FormLabel({
  className,
  ...props
}: React.ComponentProps<typeof FieldLabel>) {
  const { id } = useFormField();
  return <FieldLabel htmlFor={id} className={className} {...props} />;
}

export function FormDescription({
  className,
  ...props
}: React.ComponentProps<typeof FieldDescription>) {
  const { id, setDescriptionId } = useFormField();
  const descriptionId = `${id}-description`;
  React.useEffect(() => {
    setDescriptionId?.(descriptionId);
    return () => setDescriptionId?.(null);
  }, [descriptionId, setDescriptionId]);
  return <FieldDescription id={descriptionId} className={className} {...props} />;
}

export function FormMessage({
  className,
  children,
  ...props
}: React.ComponentProps<typeof FieldError>) {
  const { invalid, message, id } = useFormField();
  if (!invalid && !children) {
    return null;
  }
  return (
    <FieldError id={`${id}-error`} aria-live="polite" className={className} {...props}>
      {children ?? message}
    </FieldError>
  );
}

// 控件接线: 克隆唯一子元素注入 id/aria-invalid/aria-describedby——
// 描述链 = 已挂载的 description id + (无效时的) error id, 使屏读器朗读帮助文本与错误
export function FormControl({ children }: { children: React.ReactElement }) {
  const { id, invalid, descriptionId } = useFormField();
  const describedBy =
    [descriptionId, invalid ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
    id,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
  });
}

export { useFormField };
