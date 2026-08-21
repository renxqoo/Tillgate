'use client';

import * as React from 'react';
import { useState, useTransition } from 'react';

import { EyeIcon, EyeOffIcon, GiftIcon, KeyRoundIcon, Loader2Icon, ScaleIcon } from 'lucide-react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ai-gateway/ui/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@ai-gateway/ui/components/ui/field';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { NumberField } from '@ai-gateway/ui/components/ui/number-field';
import { Textarea } from '@ai-gateway/ui/components/ui/textarea';
import { moneyText } from '@ai-gateway/ui/lib/forms';
import { formatMoney } from '@ai-gateway/api-client/formatters';

import type { AdminUserRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

/**
 * 用户资金/密码操作弹窗（列表页与详情页共用）。
 * 金额字段以字符串保存原始输入（NumberField + numericText），
 * 修复「数字输入框的 0 无法删除/覆盖」问题。
 */

const adjustSchema = z.object({
  amount: moneyText({ message: '请输入有效金额', allowNegative: true, allowZero: false }),
  remark: z.string().optional(),
});

const giftSchema = z.object({
  amount: moneyText({ message: '请输入有效金额', allowZero: false }),
  remark: z.string().optional(),
});

const passwordSchema = z.object({
  password: z.string().min(6, '密码至少 6 位'),
});

interface BalanceFormValues {
  amount: string;
  remark: string;
}

export function AdjustDialog({
  user,
  trigger,
}: {
  user: AdminUserRow;
  /** 自定义触发按钮（列表行用 icon 幽灵按钮，详情页用默认文字按钮） */
  trigger?: React.ReactNode;
}) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<BalanceFormValues>({
    resolver: zodResolver(adjustSchema) as never,
    defaultValues: { amount: '', remark: '' },
  });

  function onSubmit(values: BalanceFormValues) {
    startTransition(async () => {
      const { adjustBalanceAction } = await import('../actions');
      const res = await adjustBalanceAction(user.id, {
        amount: values.amount,
        remark: values.remark,
      });
      if (!notify(res, '调账失败', '已调账')) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <ScaleIcon /> 调账
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> 调整余额 - {user.subject}
          </DialogTitle>
          <DialogDescription>
            已结算 {formatMoney(user.balance)}，处理中预留 {formatMoney(user.reservedBalance)}，
            可用额度 {formatMoney(user.availableBalance)}。负数调账不能侵占处理中预留。
          </DialogDescription>
        </DialogHeader>
        <form id="adj-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <NumberField
              control={form.control}
              name="amount"
              label="金额（元，正/负）"
              id="adj-amount"
              step="0.01"
            />
            <TextareaField name="remark" form={form} label="备注" id="adj-remark" />
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

export function GiftDialog({ user, trigger }: { user: AdminUserRow; trigger?: React.ReactNode }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<BalanceFormValues>({
    resolver: zodResolver(giftSchema) as never,
    defaultValues: { amount: '', remark: '' },
  });

  function onSubmit(values: BalanceFormValues) {
    startTransition(async () => {
      const { giftUserAction } = await import('../actions');
      const res = await giftUserAction(user.id, {
        amount: values.amount,
        remark: values.remark,
      });
      if (!notify(res, '赠送失败', '已赠送')) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <GiftIcon /> 赠送
          </Button>
        )}
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
            <NumberField
              control={form.control}
              name="amount"
              label="金额（元，&gt; 0）"
              id="gift-amount"
              step="0.01"
            />
            <TextareaField name="remark" form={form} label="备注" id="gift-remark" />
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

export function PasswordDialog({ user, trigger }: { user: AdminUserRow; trigger?: React.ReactNode }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ password: string }>({
    resolver: zodResolver(passwordSchema) as never,
    defaultValues: { password: '' },
  });

  function onSubmit(values: { password: string }) {
    startTransition(async () => {
      const { setPasswordAction } = await import('../actions');
      const res = await setPasswordAction(user.id, values);
      if (!notify(res, '设置失败', '已设置密码')) return;
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
        {trigger ?? (
          <Button size="sm" variant="outline">
            <KeyRoundIcon /> 改密
          </Button>
        )}
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
            <Field>
              <FieldLabel htmlFor="pw">新密码</FieldLabel>
              <div className="relative">
                <Input
                  id="pw"
                  type={show ? 'text' : 'password'}
                  {...form.register('password')}
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
            </Field>
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

/** 备注/文本域字段（余额类弹窗共用） */
function TextareaField({
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
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea id={id} rows={2} {...form.register(name)} />
    </Field>
  );
}
