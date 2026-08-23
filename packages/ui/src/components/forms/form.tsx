'use client';

// react-hook-form 胶水: 把 RHF 的字段状态接到本包 Field 原语上。
// 分工: Form/FormField 管状态接线(name/value/onChange/onBlur/错误),
// 视觉层完全复用 Field/FieldLabel/FieldError/FieldDescription; 校验器(resolver/zod)由调用方自选
import * as React from 'react';
import {
  Controller,
  FormProvider,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';

import { Field, FieldDescription, FieldError, FieldLabel } from './field';

export const Form = FormProvider;

const FormFieldContext = React.createContext<{ name: string } | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
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
  };
}

type FormItemContextValue = { id: string };

const FormItemContext = React.createContext<FormItemContextValue | null>(null);

export function FormItem({ className, ...props }: React.ComponentProps<typeof Field>) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <Field data-slot="form-item" className={className} {...props} />
    </FormItemContext.Provider>
  );
}

export function FormLabel({ className, ...props }: React.ComponentProps<typeof FieldLabel>) {
  const { id } = useFormField();
  return <FieldLabel htmlFor={id} className={className} {...props} />;
}

export function FormDescription({
  className,
  ...props
}: React.ComponentProps<typeof FieldDescription>) {
  const { id } = useFormField();
  return <FieldDescription id={`${id}-description`} className={className} {...props} />;
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

// 控件接线: 克隆唯一子元素注入 id/aria-invalid, 使原生控件(Input/Select/…)与 Label 关联
export function FormControl({ children }: { children: React.ReactElement }) {
  const { id, invalid } = useFormField();
  return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
    id,
    'aria-invalid': invalid || undefined,
  });
}

export { useFormField };
