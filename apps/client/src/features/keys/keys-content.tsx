'use client';

import { useState } from 'react';

import { KeyRoundIcon, Loader2Icon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';

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
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@tillgate/ui';
import type { KeyRow } from '@tillgate/api-client';

import { actionResult } from '@/features/shared/action-result';
import { formatDateTime, formatMoney } from '@/features/shared/format';
import { createKeyAction } from '@/server/actions/keys';

import { KeyRowActions } from './key-row-actions';

interface CreateKeyValues {
  name: string;
  remark?: string;
  subscriptionId: number | null;
}

export function KeysTable({
  keys,
  subscriptionLabels,
}: {
  readonly keys: ReadonlyArray<KeyRow>;
  readonly subscriptionLabels: ReadonlyMap<number, string>;
}) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const locale = useLocale();

  const fmtLimit = (v: number | null): string =>
    v === null ? tCommon('unlimited') : v.toLocaleString('en-US');
  const fmtMoney = (v: string | null): string =>
    v === null ? tCommon('unlimited') : formatMoney(v, locale);

  return (
    <Table>
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tCommon('name')}</TableHead>
          <TableHead>{t('colType')}</TableHead>
          <TableHead>{t('colKey')}</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          <TableHead className="text-right">{t('colDailyLimit')}</TableHead>
          <TableHead>{tCommon('status')}</TableHead>
          <TableHead>{tCommon('createdAt')}</TableHead>
          <TableHead>{t('colLastUsed')}</TableHead>
          <TableHead className="w-16 text-center">{tCommon('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
              {t('noKeys')}
            </TableCell>
          </TableRow>
        ) : (
          keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="min-w-56">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <KeyRoundIcon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate font-medium">{k.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {k.remark || k.keyPreview}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <SourceBadge
                  label={
                    k.subscriptionId != null
                      ? (subscriptionLabels.get(k.subscriptionId) ?? t('planFallback'))
                      : t('sourceBalance')
                  }
                  balanceLabel={t('sourceBalance')}
                />
              </TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.keyPreview}</code>
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtLimit(k.rpmLimit)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtLimit(k.tpmLimit)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtMoney(k.dailySpendLimit)}
              </TableCell>
              <TableCell>
                <StatusBadge status={k.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(k.createdAt, locale)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(k.lastUsedAt, locale)}
              </TableCell>
              <TableCell className="w-16 text-center">
                <KeyRowActions keyRow={k} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('keys');
  if (status === 0) {
    return <StatusPill tone="success">{t('statusActive')}</StatusPill>;
  }
  return <StatusPill tone="destructive">{t('statusRevoked')}</StatusPill>;
}

function SourceBadge({ label, balanceLabel }: { label: string; balanceLabel: string }) {
  const isBalance = label === balanceLabel;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isBalance
          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
          : 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
      }`}
    >
      {label}
    </span>
  );
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
              setRevealedKey(res.key!.plaintext);
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
