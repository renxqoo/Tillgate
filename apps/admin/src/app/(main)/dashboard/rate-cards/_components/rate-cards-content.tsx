'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import {
  BanknoteIcon,
  EyeIcon,
  Loader2Icon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
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
import { Field, FieldError, FieldGroup, FieldLabel } from '@ai-gateway/ui/components/ui/field';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { NumberField } from '@ai-gateway/ui/components/ui/number-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ai-gateway/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';

import type { AdminRateCardRow } from '@ai-gateway/api-client/types';
import { fmtDateTime } from "@ai-gateway/api-client/formatters";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

// 校验消息走目录：schema 在组件内用 t 构造
function buildSchema(t: ReturnType<typeof useTranslations<'rateCards'>>) {
  return z.object({
    name: z.string().min(1),
    coefficient: z.string().regex(/^(?:[0-9](?:\.\d{1,3})?)$/, t('coefficientRange'))
      .refine((v) => v !== '0' && !/^0\.0+$/.test(v), t('coefficientPositive')),
    description: z.string().optional(),
  });
}

export function RateCardsTable({ cards }: { readonly cards: ReadonlyArray<AdminRateCardRow> }) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="text-right">{t('coefficient')}</TableHead>
          <TableHead>{t('descriptionLabel')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead className="w-44">{tc('updatedAt')}</TableHead>
          <TableHead className="w-28 text-right">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              {t('noRateCards')}
            </TableCell>
          </TableRow>
        ) : (
          cards.map((c) => <RateCardRowItem key={c.id} card={c} />)
        )}
      </TableBody>
    </Table>
  );
}

function RateCardRowItem({ card }: { card: AdminRateCardRow }) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link href={`/dashboard/rate-cards/${card.id}`} className="hover:underline">
          {card.name}
        </Link>
      </TableCell>
      <TableCell className="text-right tabular-nums">×{card.coefficient}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{card.description ?? '—'}</TableCell>
      <TableCell>
        {card.status === 0 ? (
          <StatusPill tone="success" label={tc('enabled')} />
        ) : (
          <StatusPill tone="neutral" label={tc('disabled')} />
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {fmtDateTime(card.updatedAt)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button asChild size="sm" variant="ghost" title={t('viewUsers')}>
            <Link href={`/dashboard/rate-cards/${card.id}`}>
              <EyeIcon />
            </Link>
          </Button>
          <EditRateCardDialog card={card} />
          <ConfirmAction
            confirm={t('deleteConfirm', { name: card.name })}
            action={async () => (await import('../actions')).deleteRateCardAction(card.id)}
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

export function CreateRateCardDialog() {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const createSchema = buildSchema(t);
  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: { name: '', coefficient: '1', description: '' },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createRateCardAction } = await import('../actions');
      const res = await createRateCardAction({
        name: values.name,
        coefficient: values.coefficient,
        description: values.description?.trim() || undefined,
      });
      if (!notify(res, tc('createFailed'), tc('created'))) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircleIcon />
          {t('create')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BanknoteIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <RateCardForm form={form} onSubmit={onSubmit} formId="rc-form" />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tUi('cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="rc-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditRateCardDialog({ card }: { card: AdminRateCardRow }) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const editSchema = buildSchema(t).extend({
    status: z.coerce.number().int(),
  });
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: card.name,
      coefficient: card.coefficient,
      description: card.description ?? '',
      status: card.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateRateCardAction } = await import('../actions');
      const res = await updateRateCardAction(card.id, {
        name: values.name,
        coefficient: values.coefficient,
        description: values.description?.trim() || undefined,
        status: Number(values.status),
      });
      if (!notify(res, tc('saveFailed'), tc('saved'))) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title={tc('edit')}>
          <PencilIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('editTitle', { name: card.name })}
          </DialogTitle>
        </DialogHeader>
        <RateCardForm form={form} onSubmit={onSubmit} formId="rc-edit-form" isEdit />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tUi('cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="rc-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RateCardForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
}: {
  form: any;
  onSubmit: (v: never) => void;
  formId: string;
  isEdit?: boolean;
}) {
  const t = useTranslations('rateCards');
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
              <FieldLabel htmlFor="rc-name">{tc('name')}</FieldLabel>
              <Input id="rc-name" placeholder={t('namePlaceholder')} {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <NumberField
          control={form.control}
          name="coefficient"
          label={t('coefficientLabel')}
          id="rc-coef"
          step="0.05"
          min={0.001}
        />
        <Controller
          control={form.control}
          name="description"
          render={({ field }: { field: { value: string } }) => (
            <Field>
              <FieldLabel htmlFor="rc-desc">{t('descriptionLabel')}</FieldLabel>
              <Input id="rc-desc" placeholder={tc('optional')} {...field} />
            </Field>
          )}
        />
        {isEdit && (
          <Controller
            control={form.control}
            name="status"
            render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
              <Field>
                <FieldLabel>{tc('status')}</FieldLabel>
                <Select
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
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
        )}
      </FieldGroup>
    </form>
  );
}
