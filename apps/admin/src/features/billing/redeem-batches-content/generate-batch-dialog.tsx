'use client';

// 生成兑换码批次弹窗：表单 + 结果码展示两阶段

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
  FieldError,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { Loader2Icon, SparklesIcon, TicketIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { z } from 'zod';

import { useActionResult } from '@/components/action-toast';
import { moneyText } from '@/lib/forms';

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

// eslint-disable-next-line max-lines-per-function -- 生成批次弹窗（表单 + 结果码展示两阶段）平铺，拆分需抽结果阶段子组件（存量棘轮，行为等价优先）
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
      const { generateBatchAction } = await import('@/server/redeem-batches-actions');
      const res = await generateBatchAction(values);
      if (!notify(res, t('generateFailed'))) return;
      // 生成成功必有批次载荷；显式守卫代替断言（防御不可能的空批次数组崩溃）
      const { batch } = res;
      if (!batch) return;
      setRevealedCodes(batch.codes);
      toast.success(t('generated', { count: batch.codes.length }));
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
      <DialogTrigger
        render={
          <Button>
            <SparklesIcon />
            {t('generate')}
          </Button>
        }
      />
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
              <CopyButton
                value={revealedCodes.join('\n')}
                size="sm"
                variant="outline"
                copyLabel={t('copyAll')}
              />
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
                  <FormItem data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="b-name">{t('batchName')}</FieldLabel>
                    <Input id="b-name" placeholder={t('namePlaceholder')} {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <Controller
                  control={form.control}
                  name="amount"
                  render={({ field, fieldState }) => (
                    <FormItem data-invalid={fieldState.invalid}>
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
                    </FormItem>
                  )}
                />
                <Controller
                  control={form.control}
                  name="count"
                  render={({ field, fieldState }) => (
                    <FormItem data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="b-count">{t('countLabel')}</FieldLabel>
                      <Input
                        id="b-count"
                        type="number"
                        {...field}
                        value={field.value ?? 0}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </FormItem>
                  )}
                />
              </div>
              <Controller
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FieldLabel htmlFor="b-note">{t('remarkOptional')}</FieldLabel>
                    <Input id="b-note" {...field} />
                  </FormItem>
                )}
              />
              <Controller
                control={form.control}
                name="expiresAt"
                render={({ field }) => (
                  <FormItem>
                    <FieldLabel htmlFor="b-exp">{t('expiresLabel')}</FieldLabel>
                    <Input id="b-exp" type="datetime-local" {...field} />
                  </FormItem>
                )}
              />
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {revealedCodes ? (
            <DialogClose render={<Button variant="outline">{tc('close')}</Button>} />
          ) : (
            <>
              <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
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
