'use client';

// 创建 Key 弹窗：名称/计费来源(余额或订阅)/备注表单 + 成功后明文一次性回显

import { useState } from 'react';

import { KeyRoundIcon, Loader2Icon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import * as z from 'zod';

import {
  Button,
  CopyButton,
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

import { actionResult } from '@/features/shared/action-result';
import { createKeyAction } from '@/server/actions/keys';

interface CreateKeyValues {
  name: string;
  remark?: string;
  subscriptionId: number | null;
}

export function CreateKeyDialog({
  subscriptions,
}: {
  readonly subscriptions: ReadonlyArray<{ id: number; label: string }>;
}) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const [open, setOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const createSchema = z.object({
    name: z.string().min(1, t('nameRequired')).max(100),
    remark: z.string().max(200).optional(),
    subscriptionId: z.number().int().positive().nullable(),
  });

  const form = useForm<CreateKeyValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', remark: '', subscriptionId: null },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setRevealedKey(null);
          form.reset();
        }
      }}
    >
      <DialogTrigger render={<Button />}>
        <KeyRoundIcon />
        {t('createKey')}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('createTitle')}</DialogTitle>
          <DialogDescription>{t('createDesc')}</DialogDescription>
        </DialogHeader>

        {revealedKey ? (
          <div className="rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {t('plaintextNotice')}
              </p>
              <CopyButton value={revealedKey} />
            </div>
            <code className="block break-all font-mono text-sm">{revealedKey}</code>
          </div>
        ) : (
          <form
            id="create-key-form"
            onSubmit={form.handleSubmit(async (values) => {
              const res = await createKeyAction(values);
              if (!actionResult(res, tCommon('createFailed'))) return;
              // 成功契约：无 error 时 key（含一次性明文）必在；缺字段视为契约破坏，跳过回显
              const { key } = res;
              if (key === undefined) return;
              setRevealedKey(key.plaintext);
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
                    <FieldLabel htmlFor="key-name">{tCommon('name')}</FieldLabel>
                    <Input id="key-name" placeholder={t('namePlaceholder')} {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="subscriptionId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="key-source">{t('billingSource')}</FieldLabel>
                    <select
                      id="key-source"
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value === '' ? null : Number(e.target.value))
                      }
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">{t('balanceOption')}</option>
                      {subscriptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {t('planOption', { label: s.label })}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="remark"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="key-remark">{t('remarkOptional')}</FieldLabel>
                    <Input id="key-remark" placeholder={t('remarkPlaceholder')} {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {revealedKey ? (
            <DialogClose render={<Button variant="outline" />}>{tCommon('done')}</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
              <Button type="submit" form="create-key-form" disabled={form.formState.isSubmitting}>
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
