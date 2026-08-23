'use client';

import type * as React from 'react';
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  RowActions,
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
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tCommon('name')}</TableHead>
          <TableHead>{t('colClientId')}</TableHead>
          <TableHead>{t('colAppId')}</TableHead>
          <TableHead>{tCommon('status')}</TableHead>
          <TableHead>{tCommon('createdAt')}</TableHead>
          <TableHead>{t('colRotatedAt')}</TableHead>
          <TableHead className="w-16 text-center">{tCommon('actions')}</TableHead>
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
              <TableCell className="min-w-56">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ShieldCheckIcon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate font-medium">{a.name}</span>
                    {a.description ? (
                      <span className="block truncate text-sm text-muted-foreground">
                        {a.description}
                      </span>
                    ) : null}
                  </div>
                </div>
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
              <TableCell className="w-16 text-center">
                <AppRowActions app={a} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function AppRowActions({ app }: { app: AppRow }) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <RowActions label={tCommon('actions')}>
        {app.status === 0 ? (
          <>
            <DropdownMenuItem onClick={() => setRotateOpen(true)}>
              <RefreshCwIcon /> {t('rotateSecret')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2Icon /> {tCommon('delete')}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled>{t('statusDisabled')}</DropdownMenuItem>
        )}
      </RowActions>
      <RotateSecretInline
        id={app.id}
        name={app.name}
        trigger={null}
        open={rotateOpen}
        onOpenChange={setRotateOpen}
      />
      {/* 弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
      <ConfirmAction
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        confirm={t('deleteConfirm', { name: app.name })}
        action={async () => deleteAppAction(app.id)}
        errorTitle={tCommon('deleteFailed')}
        success={t('deletedToast')}
      />
    </>
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

function RotateSecretInline({
  id,
  name,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  id: number;
  name: string;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
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
      {trigger !== null ? (
        <DialogTrigger render={trigger ?? <Button variant="ghost" size="sm" />}>
          <RefreshCwIcon />
          {t('rotateSecret')}
        </DialogTrigger>
      ) : null}
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
          className={
            'flex-1 break-all rounded bg-background/80 p-2 text-xs ' + (mono ? 'font-mono' : '')
          }
        >
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
