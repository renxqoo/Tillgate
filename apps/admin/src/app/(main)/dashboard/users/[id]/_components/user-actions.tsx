"use client";

import { useState, useTransition } from "react";

import {
  EyeIcon,
  EyeOffIcon,
  GiftIcon,
  KeyRoundIcon,
  Loader2Icon,
  ScaleIcon,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ai-gateway/ui/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";
import { Textarea } from "@ai-gateway/ui/components/ui/textarea";

import type { UserRow } from "../../types";

const adjustSchema = z.object({
  amount: z.coerce.number().refine((v) => v !== 0, "金额必须非零"),
  remark: z.string().optional(),
});

const giftSchema = z.object({
  amount: z.coerce.number().positive("金额必须 > 0"),
  remark: z.string().optional(),
});

const passwordSchema = z.object({
  password: z.string().min(6, "密码至少 6 位"),
});

export function UserActions({ user }: { readonly user: UserRow }) {
  return (
    <div className="flex items-center gap-2">
      <AdjustDialog user={user} />
      <GiftDialog user={user} />
      <PasswordDialog user={user} />
    </div>
  );
}

function AdjustDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ amount: number; remark: string }>({
    resolver: zodResolver(adjustSchema) as never,
    defaultValues: { amount: 0, remark: "" },
  });

  function onSubmit(values: { amount: number; remark: string }) {
    startTransition(async () => {
      const { adjustBalanceAction } = await import("../../actions");
      const res = await adjustBalanceAction(user.id, values);
      if (res.error) {
        toast.error("调账失败", { description: res.error });
        return;
      }
      toast.success("已调账");
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ScaleIcon /> 调账
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> 调整余额 - {user.subject}
          </DialogTitle>
          <DialogDescription>
            正数增加余额，负数扣减。当前余额 {user.balance}
          </DialogDescription>
        </DialogHeader>
        <form id="adj-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="amount"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="adj-amount">金额（元，正/负）</FieldLabel>
                  <Input
                    id="adj-amount"
                    type="number"
                    step="0.01"
                    {...field}
                    value={field.value ?? 0}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="remark"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="adj-remark">备注</FieldLabel>
                  <Textarea id="adj-remark" rows={2} {...field} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="adj-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认调账
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GiftDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ amount: number; remark: string }>({
    resolver: zodResolver(giftSchema) as never,
    defaultValues: { amount: 0, remark: "" },
  });

  function onSubmit(values: { amount: number; remark: string }) {
    startTransition(async () => {
      const { giftUserAction } = await import("../../actions");
      const res = await giftUserAction(user.id, values);
      if (res.error) {
        toast.error("赠送失败", { description: res.error });
        return;
      }
      toast.success("已赠送");
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <GiftIcon /> 赠送
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> 赠送余额 - {user.subject}
          </DialogTitle>
          <DialogDescription>赠送金额仅增加余额</DialogDescription>
        </DialogHeader>
        <form id="gift-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="amount"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="gift-amount">金额（元，&gt; 0）</FieldLabel>
                  <Input
                    id="gift-amount"
                    type="number"
                    step="0.01"
                    {...field}
                    value={field.value ?? 0}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="remark"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="gift-remark">备注</FieldLabel>
                  <Textarea id="gift-remark" rows={2} {...field} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="gift-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认赠送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ password: string }>({
    resolver: zodResolver(passwordSchema) as never,
    defaultValues: { password: "" },
  });

  function onSubmit(values: { password: string }) {
    startTransition(async () => {
      const { setPasswordAction } = await import("../../actions");
      const res = await setPasswordAction(user.id, values);
      if (res.error) {
        toast.error("设置失败", { description: res.error });
        return;
      }
      toast.success("已设置密码");
      form.reset();
      setShow(false);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setShow(false);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <KeyRoundIcon /> 改密
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon /> 设置密码 - {user.subject}
          </DialogTitle>
          <DialogDescription>为本地账号重置登录密码</DialogDescription>
        </DialogHeader>
        <form id="pw-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="password"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="pw">新密码</FieldLabel>
                  <div className="relative">
                    <Input
                      id="pw"
                      type={show ? "text" : "password"}
                      {...field}
                      className="pr-9"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="absolute right-1 top-1 size-7"
                      onClick={() => setShow((s) => !s)}
                      tabIndex={-1}
                    >
                      {show ? <EyeOffIcon /> : <EyeIcon />}
                    </Button>
                  </div>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="pw-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
