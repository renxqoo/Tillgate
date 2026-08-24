'use client';

// 设置本地登录密码弹窗（列表行菜单与详情页操作组共用）

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
} from '@tillgate/ui';
import type * as React from 'react';
import { useState, useTransition } from 'react';

import { EyeIcon, EyeOffIcon, KeyRoundIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import type { AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

export function PasswordDialog({
  user,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  user: AdminUserRow;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('users');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
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
      const { setPasswordAction } = await import('@/server/users-actions');
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
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="outline">
                <KeyRoundIcon /> {t('changePassword')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon /> {t('setPasswordTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('resetLocalPassword')}</DialogDescription>
        </DialogHeader>
        <form id="pw-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <FormItem>
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
            </FormItem>
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="pw-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmSet')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
