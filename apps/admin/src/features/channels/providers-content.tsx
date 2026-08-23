'use client';

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tokenlens/ui';
import { StatusPill } from '@/components/status-pill';
import { useState, useTransition } from 'react';

import { Loader2Icon, PencilIcon, PlusCircleIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import type { AdminProviderRow } from '@tokenlens/api-client';
import { fmtDateTime } from '@/lib/formatters';
import { useActionResult } from '@/components/action-toast';
import { ConfirmAction } from '@/components/confirm-action';

// 校验消息走目录：schema 在组件内用 t 构造
function buildSchema(t: ReturnType<typeof useTranslations<'providers'>>) {
  return z.object({
    name: z.string().min(1, t('nameRequired')),
    baseUrl: z.string().url(t('invalidUrl')),
    protocol: z.string().min(1),
    vendor: z.string(),
    status: z.coerce.number().int(),
  });
}
type FormValues = {
  name: string;
  baseUrl: string;
  protocol: string;
  vendor: string;
  status: number;
};

export function ProvidersTable({
  providers,
  protocols,
  vendors,
}: {
  readonly providers: ReadonlyArray<AdminProviderRow>;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead className="w-40">{t('protocolVendor')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead className="w-44">{tc('updatedAt')}</TableHead>
          <TableHead className="w-24 text-right">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              {t('noProviders')}
            </TableCell>
          </TableRow>
        ) : (
          providers.map((p) => (
            <ProviderRowItem key={p.id} provider={p} protocols={protocols} vendors={vendors} />
          ))
        )}
      </TableBody>
    </Table>
  );
}

function ProviderRowItem({
  provider,
  protocols,
  vendors,
}: {
  provider: AdminProviderRow;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  return (
    <TableRow>
      <TableCell className="font-medium">{provider.name}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{provider.baseUrl}</code>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {provider.protocol}
        {provider.vendor ? (
          <span className="ml-1 rounded bg-muted px-1 py-0.5">{provider.vendor}</span>
        ) : null}
      </TableCell>
      <TableCell>
        {provider.status === 0 ? (
          <StatusPill tone="success" label={tc('enabled')} />
        ) : (
          <StatusPill tone="neutral" label={tc('disabled')} />
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {provider.updatedAt ? fmtDateTime(provider.updatedAt) : fmtDateTime(provider.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <EditProviderDialog provider={provider} protocols={protocols} vendors={vendors} />
          <ConfirmAction
            confirm={t('deleteConfirm', { name: provider.name })}
            action={async () =>
              (await import('@/server/providers-actions')).deleteProviderAction(provider.id)
            }
            success={tc('deleted')}
          >
            {({ pending, onClick }) => (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={onClick}
                className="text-destructive hover:text-destructive"
              >
                {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
              </Button>
            )}
          </ConfirmAction>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function CreateProviderDialog({
  protocols,
  vendors,
}: {
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const schema = buildSchema(t);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      name: '',
      baseUrl: '',
      protocol: protocols[0] ?? 'openai-compatible',
      vendor: '',
      status: 0,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createProviderAction } = await import('@/server/providers-actions');
      const res = await createProviderAction(values);
      if (!notify(res, tc('createFailed'), tc('created'))) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlusCircleIcon />
            {t('create')}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <ProviderForm
          form={form}
          onSubmit={onSubmit}
          formId="provider-form"
          protocols={protocols}
          vendors={vendors}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="provider-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProviderDialog({
  provider,
  protocols,
  vendors,
}: {
  provider: AdminProviderRow;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const schema = buildSchema(t);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      vendor: provider.vendor ?? '',
      status: provider.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateProviderAction } = await import('@/server/providers-actions');
      const res = await updateProviderAction(provider.id, values);
      if (!notify(res, tc('saveFailed'), tc('saved'))) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="ghost" title={tc('edit')}>
            <PencilIcon />
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('editTitle', { name: provider.name })}
          </DialogTitle>
        </DialogHeader>
        <ProviderForm
          form={form}
          onSubmit={onSubmit}
          formId="provider-edit-form"
          protocols={protocols}
          vendors={vendors}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="provider-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ProviderForm({
  form,
  onSubmit,
  formId,
  protocols,
  vendors,
}: {
  form: any;
  onSubmit: (v: FormValues) => void;
  formId: string;
  protocols: ReadonlyArray<string>;
  vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        <Controller
          control={form.control}
          name="name"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="p-name">{tc('name')}</FieldLabel>
              <Input id="p-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrl"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="p-url">Base URL</FieldLabel>
              <Input id="p-url" placeholder="https://api.openai.com/v1" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="protocol"
          render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
            <Field>
              <FieldLabel>{t('protocol')}</FieldLabel>
              <Select value={field.value} onValueChange={(v) => field.onChange(v ?? '')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {protocols.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="vendor"
          render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
            <Field>
              <FieldLabel>{t('vendorProfile')}</FieldLabel>
              <Select
                value={field.value || 'none'}
                onValueChange={(v) => field.onChange(!v || v === 'none' ? '' : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('noVendor')}</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="status"
          render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
            <Field>
              <FieldLabel>{tc('status')}</FieldLabel>
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">{tc('enabled')}</SelectItem>
                  <SelectItem value="1">{tc('disabled')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
      </FieldGroup>
    </form>
  );
}
