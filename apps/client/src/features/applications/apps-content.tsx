'use client';

import { useState } from 'react';

import { Loader2Icon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react';
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
} from '@tokenlens/ui';
import type { AppCreated, AppRow } from '@tokenlens/api-client';

import { actionResult } from '@/features/shared/action-result';
import { formatDateTime } from '@/features/shared/format';
import { ConfirmAction } from '@/features/shared/confirm-action';
import { createAppAction, deleteAppAction, rotateSecretAction } from '@/server/actions/apps';

interface CreateAppValues {
  name: string;
  description?: string;
}

export function AppsTable({ apps }: { readonly apps: ReadonlyArray<AppRow> }) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tCommon('name')}</TableHead>
          <TableHead>{t('colClientId')}</TableHead>
          <TableHead>{t('colAppId')}</TableHead>
          <TableHead>{tCommon('status')}</TableHead>
          <TableHead>{tCommon('createdAt')}</TableHead>
          <TableHead>{t('colRotatedAt')}</TableHead>
          <TableHead className="w-40 text-right">{tCommon('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              {t('noApps')}
            </TableCell>
          </TableRow>
        ) : (
          apps.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="font-medium">
                {a.name}
                {a.description ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {a.description}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.clientId}</code>
                  <CopyButton value={a.clientId} />
                </div>
              </TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {a.appId}
                </code>
              </TableCell>
              <TableCell>
                <StatusBadge status={a.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(a.createdAt, locale)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(a.rotatedAt, locale)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {a.status === 0 && <RotateSecretInline id={a.id} name={a.name} />}
                  {a.status === 0 && <DeleteInline id={a.id} name={a.name} />}
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('apps');
  return status === 0 ? (
    <StatusPill tone="success">{t('statusEnabled')}</StatusPill>
  ) : (
    <StatusPill tone="neutral">{t('statusDisabled')}</StatusPill>
  );
}

function DeleteInline({ id, name }: { id: number; name: string }) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  return (
    <ConfirmAction
      confirm={t('deleteConfirm', { name })}
      action={async () => deleteAppAction(id)}
      errorTitle={tCommon('deleteFailed')}
      success={t('deletedToast')}
    >
      {({ pending, onClick }) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onClick}
          className="text-destructive hover:text-destructive"
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          {tCommon('delete')}
        </Button>
      )}
    </ConfirmAction>
  );
}

function RotateSecretInline({ id, name }: { id: number; name: string }) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setRevealed(null);
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <RefreshCwIcon />
        {t('rotateSecret')}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('rotateTitle')}</DialogTitle>
          <DialogDescription>{t('rotateDesc', { name })}</DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              {t('newSecretNotice')}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background/80 p-2 font-mono text-xs">
                {revealed}
              </code>
              <CopyButton value={revealed} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('rotateConfirmText')}</p>
        )}

        <DialogFooter>
          {revealed ? (
            <DialogClose render={<Button variant="outline" />}>{tCommon('done')}</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
              <Button
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  const res = await rotateSecretAction(id);
                  setPending(false);
                  if (!actionResult(res, t('rotateFailed'))) return;
                  setRevealed(res.clientSecret!);
                  toast.success(t('rotatedToast'));
                }}
              >
                {pending && <Loader2Icon className="animate-spin" />}
                {t('confirmRotate')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
              setCreated(res.app!);
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

function CreatedField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code
          className={'flex-1 break-all rounded bg-background/80 p-2 text-xs ' + (mono ? 'font-mono' : '')}
        >
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
