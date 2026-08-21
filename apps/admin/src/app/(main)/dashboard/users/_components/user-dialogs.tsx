'use client';

import * as React from 'react';
import { useState, useTransition } from 'react';

import { EyeIcon, EyeOffIcon, GiftIcon, KeyRoundIcon, Loader2Icon, ScaleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('users');
  const tUi = useTranslations('ui');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // 校验消息走目录：schema 在组件内用 t 构造
  const adjustSchema = z.object({
    amount: moneyText({ message: tUi('invalidAmount'), allowNegative: true, allowZero: false }),
    remark: z.string().optional(),
  });
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
      if (!notify(res, t('adjustFailed'), t('adjusted'))) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <ScaleIcon /> {t('adjust')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> {t('adjustTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>
            {t('adjustDescription', {
              balance: formatMoney(user.balance),
              reserved: formatMoney(user.reservedBalance),
              available: formatMoney(user.availableBalance),
            })}
          </DialogDescription>
        </DialogHeader>
        <form id="adj-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <NumberField
              control={form.control}
              name="amount"
              label={t('amountSigned')}
              id="adj-amount"
              step="0.01"
            />
            <TextareaField name="remark" form={form} label={tc('remark')} id="adj-remark" />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tUi('cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="adj-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmAdjust')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GiftDialog({ user, trigger }: { user: AdminUserRow; trigger?: React.ReactNode }) {
  const t = useTranslations('users');
  const tUi = useTranslations('ui');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const giftSchema = z.object({
    amount: moneyText({ message: tUi('invalidAmount'), allowZero: false }),
    remark: z.string().optional(),
  });
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
      if (!notify(res, t('giftFailed'), t('gifted'))) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <GiftIcon /> {t('gift')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> {t('giftTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('giftDescription')}</DialogDescription>
        </DialogHeader>
        <form id="gift-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <NumberField
              control={form.control}
              name="amount"
              label={t('amountPositive')}
              id="gift-amount"
              step="0.01"
            />
            <TextareaField name="remark" form={form} label={tc('remark')} id="gift-remark" />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tUi('cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="gift-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmGift')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PasswordDialog({ user, trigger }: { user: AdminUserRow; trigger?: React.ReactNode }) {
  const t = useTranslations('users');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false);
  const [pending, startTransition] = useTransition();
  const passwordSchema = z.object({
    password: z.string().min(6, t('passwordMin6')),
  });
  const form = useForm<{ password: string }>({
    resolver: zodResolver(passwordSchema) as never,
    defaultValues: { password: '' },
  });

  function onSubmit(values: { password: string }) {
    startTransition(async () => {
      const { setPasswordAction } = await import('../actions');
      const res = await setPasswordAction(user.id, values);
      if (!notify(res, t('setPasswordFailed'), t('passwordSet'))) return;
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
            <KeyRoundIcon /> {t('changePassword')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon /> {t('setPasswordTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('resetLocalPassword')}</DialogDescription>
        </DialogHeader>
        <form id="pw-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="pw">{t('newPassword')}</FieldLabel>
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
            <Button variant="outline">{tUi('cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="pw-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmSet')}
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
