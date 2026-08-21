"use client";

import { useState, useTransition, type ReactNode } from "react";

import { Loader2Icon } from "lucide-react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

/**
 * 表单弹窗骨架：open state + useTransition + Header/Footer/DialogClose + spinner 提交按钮。
 *
 * 各页创建/编辑弹窗的共同结构：
 *
 *   <Dialog open onOpenChange>
 *     <DialogTrigger asChild>{trigger}</DialogTrigger>
 *     <DialogContent>
 *       <DialogHeader><DialogTitle/>{description}</DialogHeader>
 *       {表单体（children）}
 *       <DialogFooter>
 *         <DialogClose asChild><Button variant="outline">取消</Button></DialogClose>
 *         <Button type="submit" form={formId} disabled={pending}>
 *           {pending && <Loader2Icon className="animate-spin" />}{submitLabel}
 *         </Button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * 两种用法：
 *
 * 1）RHF / 原生表单（formId 关联，children 为 render-prop 拿 run）：
 *
 *   <FormDialog trigger={…} title={…} description={…} submitLabel="创建">
 *     {({ run }) => (
 *       <form id="xx-form" onSubmit={form.handleSubmit((v) => run(async () => {
 *         const res = await createXxxAction(v);
 *         if (!notify(res, "创建失败", "已创建")) return false;
 *         form.reset();
 *         return true;   // true → 自动关闭
 *       }))}>…</form>
 *     )}
 *   </FormDialog>
 *
 * 2）无表单（校验写在 onSubmitClick 里，返回 true 关闭）：
 *
 *   <FormDialog trigger={…} title={…} submitLabel="确认入货"
 *     onSubmitClick={async () => { …; return true; }}>
 *     <FieldGroup>…</FieldGroup>
 *   </FormDialog>
 *
 * run / onSubmitClick 均包进 useTransition，pending 驱动提交按钮 spinner。
 */
export interface FormDialogRenderProps {
  pending: boolean;
  /** 在 transition 中执行 fn；返回 true 关闭弹窗 */
  run: (fn: () => Promise<boolean>) => void;
  /** 手动关闭 */
  close: () => void;
}

interface FormDialogBaseProps {
  /** DialogTrigger asChild 的触发器（通常是 Button） */
  trigger: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 提交按钮文案（如 创建 / 保存 / 确认入货） */
  submitLabel: string;
  cancelLabel?: string;
  /** 透传 DialogContent className（如 "sm:max-w-lg"） */
  contentClassName?: string;
  /** 透传 DialogTitle className（如 "flex items-center gap-2"） */
  titleClassName?: string;
  /** 额外的 open 变化回调（如关闭时 reset 表单），内部已维护 open state */
  onOpenChange?: (open: boolean) => void;
  /** 表单体；render-prop 形式拿 { pending, run, close } */
  children: ReactNode | ((ctx: FormDialogRenderProps) => ReactNode);
}

/** 表单模式：footer 提交按钮通过 form={formId} 关联原生提交（render-prop 必配） */
interface FormDialogFormProps extends FormDialogBaseProps {
  formId: string;
  onSubmitClick?: never;
}

/** 无表单模式：提交按钮 onClick 执行 onSubmitClick（返回 true 关闭） */
interface FormDialogClickProps extends FormDialogBaseProps {
  formId?: never;
  onSubmitClick: () => Promise<boolean>;
}

/**
 * 两种模式互斥且必选其一（判别联合）：都不传时 footer 按钮是没有任何行为
 * 的 type="button"——那是接线 bug，必须变成编译期错误（渠道页曾因此
 * 「点创建无任何反应且不调接口」）。
 */
export type FormDialogProps = FormDialogFormProps | FormDialogClickProps;

export function FormDialog(props: FormDialogProps) {
  const {
    trigger,
    title,
    description,
    submitLabel,
    cancelLabel = "取消",
    contentClassName,
    titleClassName,
    onOpenChange,
    children,
  } = props;
  const formId = props.formId ?? undefined;
  const onSubmitClick = props.onSubmitClick ?? undefined;
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  function run(fn: () => Promise<boolean>) {
    startTransition(async () => {
      if (await fn()) setOpen(false);
    });
  }

  const ctx: FormDialogRenderProps = {
    pending,
    run,
    close: () => setOpen(false),
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={contentClassName}>
        <DialogHeader>
          <DialogTitle className={titleClassName}>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {typeof children === "function" ? children(ctx) : children}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{cancelLabel}</Button>
          </DialogClose>
          {formId ? (
            <Button type="submit" form={formId} disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              {submitLabel}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(async () => (await onSubmitClick?.()) === true)}
            >
              {pending && <Loader2Icon className="animate-spin" />}
              {submitLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
