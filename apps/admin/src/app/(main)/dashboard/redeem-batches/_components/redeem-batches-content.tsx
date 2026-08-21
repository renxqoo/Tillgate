'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import { Loader2Icon, SparklesIcon, TicketIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';

import { CopyButton } from '@ai-gateway/ui/components/shell/copy-button';
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client/formatters';
import type { AdminBatchRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { moneyText } from '@ai-gateway/ui/lib/forms';

/** 校验消息走目录：schema 在组件内用 t 构造 */
function buildSchema(
  t: ReturnType<typeof useTranslations<'redeemBatches'>>,
  tUi: ReturnType<typeof useTranslations<'ui'>>,
) {
  return z.object({
    name: z.string().min(1, t('nameRequired')),
    amount: moneyText({ message: tUi('invalidAmount'), allowZero: false }),
    count: z.number().int().min(1).max(1000, t('maxCount')),
    remark: z.string().optional(),
    expiresAt: z.string().optional(),
  });
}

export function BatchesTable({ batches }: { readonly batches: ReadonlyArray<AdminBatchRow> }) {
  const t = useTranslations('redeemBatches');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="text-right">{t('faceValue')}</TableHead>
          <TableHead className="text-right">{t('total')}</TableHead>
          <TableHead className="text-right">{t('used')}</TableHead>
          <TableHead className="text-right">{t('usage')}</TableHead>
          <TableHead>{tc('remark')}</TableHead>
          <TableHead>{t('createdBy')}</TableHead>
          <TableHead className="w-44">{tc('createdAt')}</TableHead>
          <TableHead className="w-24 text-right">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              {t('noBatches')}
            </TableCell>
          </TableRow>
        ) : (
          batches.map((b) => {
            const usedRate = b.total > 0 ? Math.round((b.usedCount / b.total) * 100) : 0;
            return (
              <TableRow key={b.id}>
                <TableCell className="font-medium">
                  <Link href={`/dashboard/redeem-batches/${b.id}`} className="hover:underline">
                    {b.name}
                  </Link>
                  <span className="ml-1 text-xs text-muted-foreground">#{b.id}</span>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  ¥{formatMoney(b.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{b.total}</TableCell>
                <TableCell className="text-right tabular-nums">{b.usedCount}</TableCell>
                <TableCell className="text-right">
                  <UsageBadge rate={usedRate} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{b.remark ?? '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{b.createdBy}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {fmtDateTime(b.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/dashboard/redeem-batches/${b.id}`}>{tc('detail')}</Link>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function UsageBadge({ rate }: { rate: number }) {
  const color =
    rate >= 80
      ? 'text-emerald-600 dark:text-emerald-400'
      : rate >= 30
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  return <span className={`text-xs font-medium tabular-nums ${color}`}>{rate}%</span>;
}

export function GenerateBatchDialog() {
  const t = useTranslations('redeemBatches');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [revealedCodes, setRevealedCodes] = useState<string[] | null>(null);
  const schema = buildSchema(t, tUi);

  type FormValues = z.input<typeof schema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', amount: '100', count: 10, remark: '', expiresAt: '' },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { generateBatchAction } = await import('../actions');
      const res = await generateBatchAction(values);
      if (!notify(res, t('generateFailed'))) return;
      setRevealedCodes(res.batch!.codes);
      toast.success(t('generated', { count: res.batch!.codes.length }));
    });
  }

  function onOpenChange(o: boolean) {
    setOpen(o);
    if (!o) {
      setRevealedCodes(null);
      form.reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <SparklesIcon />
          {t('generate')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TicketIcon /> {t('generateTitle')}
          </DialogTitle>
          <DialogDescription>{t('generateDescription')}</DialogDescription>
        </DialogHeader>

        {revealedCodes ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {t('revealed', { count: revealedCodes.length })}
              </p>
              <CopyButton text={revealedCodes.join('\n')} label={t('copyAll')} />
            </div>
            <div className="max-h-80 space-y-1 overflow-y-auto rounded bg-background/80 p-3 font-mono text-xs">
              {revealedCodes.map((c, i) => (
                <div key={i}>{c}</div>
              ))}
            </div>
          </div>
        ) : (
          <form id="batch-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FieldGroup>
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="b-name">{t('batchName')}</FieldLabel>
                    <Input id="b-name" placeholder={t('namePlaceholder')} {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <Controller
                  control={form.control}
                  name="amount"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="b-amount">{t('amountLabel')}</FieldLabel>
                      <Input
                        id="b-amount"
                        type="number"
                        step="0.01"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value)}
                      />
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
                <Controller
                  control={form.control}
                  name="count"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="b-count">{t('countLabel')}</FieldLabel>
                      <Input
                        id="b-count"
                        type="number"
                        {...field}
                        value={field.value ?? 0}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
              </div>
              <Controller
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="b-note">{t('remarkOptional')}</FieldLabel>
                    <Input id="b-note" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="expiresAt"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="b-exp">{t('expiresLabel')}</FieldLabel>
                    <Input id="b-exp" type="datetime-local" {...field} />
                  </Field>
                )}
              />
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {revealedCodes ? (
            <DialogClose asChild>
              <Button variant="outline">{tc('close')}</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">{tUi('cancel')}</Button>
              </DialogClose>
              <Button type="submit" form="batch-form" disabled={pending}>
                {pending && <Loader2Icon className="animate-spin" />}
                {t('generateShort')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
