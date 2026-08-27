'use client';

// 创建应用弹窗：名称/备注表单 + 创建成功后 client_id/app_id/client_secret 一次性回显

import { useState } from 'react';

import { Loader2Icon, ShieldCheckIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import * as z from 'zod';

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
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  toast,
} from '@tillgate/ui';
import type { AppCreated } from '@tillgate/api-client';

import { actionResult } from '@/features/shared/action-result';
import { createAppAction } from '@/server/actions/apps';

import { CreatedField } from './created-field';

interface CreateAppValues {
  name: string;
  description?: string;
}

export function CreateAppDialog() {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<AppCreated | null>(null);

  const createSchema = z.object({
    name: z.string().min(1, t('nameRequired')).max(100),
    description: z.string().max(255).optional(),
  });

  const form = useForm<CreateAppValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', description: '' },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCreated(null);
          form.reset();
        }
      }}
    >
      <DialogTrigger render={<Button />}>
        <ShieldCheckIcon />
        {t('createApp')}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('createTitle')}</DialogTitle>
          <DialogDescription>{t('createDesc')}</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              {t('createdNotice')}
            </p>
            <CreatedField label="client_id" value={created.clientId} />
            <CreatedField label="app_id" value={created.appId} />
            <CreatedField label="client_secret" value={created.clientSecret} mono />
          </div>
        ) : (
          <form
            id="create-app-form"
            onSubmit={form.handleSubmit(async (values) => {
              const res = await createAppAction(values);
              if (!actionResult(res, tCommon('createFailed'))) return;
              // 成功契约：无 error 时 app 必在；缺字段视为契约破坏，跳过回显
              const { app } = res;
              if (app === undefined) return;
              setCreated(app);
              toast.success(t('createdToast'));
            })}
            className="space-y-4"
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="app-name">{tCommon('name')}</FieldLabel>
                    <Input id="app-name" placeholder={t('namePlaceholder')} {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="description"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="app-description">{t('descOptional')}</FieldLabel>
                    <Input id="app-description" {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {created ? (
            <DialogClose render={<Button variant="outline" />}>{tCommon('done')}</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
              <Button type="submit" form="create-app-form" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
                {tCommon('create')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
