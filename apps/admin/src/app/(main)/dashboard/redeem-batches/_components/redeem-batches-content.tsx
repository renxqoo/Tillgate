'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import { Loader2Icon, SparklesIcon, TicketIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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

const schema = z.object({
  name: z.string().min(1, '请输入批次名称'),
  amount: moneyText({ message: '请输入有效金额', allowZero: false }),
  count: z.number().int().min(1).max(1000, '最多 1000 张'),
  remark: z.string().optional(),
  expiresAt: z.string().optional(),
});

export function BatchesTable({ batches }: { readonly batches: ReadonlyArray<AdminBatchRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead className="text-right">面值</TableHead>
          <TableHead className="text-right">总数</TableHead>
          <TableHead className="text-right">已用</TableHead>
          <TableHead className="text-right">使用率</TableHead>
          <TableHead>备注</TableHead>
          <TableHead>创建人</TableHead>
          <TableHead className="w-44">创建时间</TableHead>
          <TableHead className="w-24 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              暂无批次
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
                    <Link href={`/dashboard/redeem-batches/${b.id}`}>详情</Link>
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
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [revealedCodes, setRevealedCodes] = useState<string[] | null>(null);

  type FormValues = z.input<typeof schema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: '', amount: '100', count: 10, remark: '', expiresAt: '' },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { generateBatchAction } = await import('../actions');
      const res = await generateBatchAction(values);
      if (!notify(res, '生成失败')) return;
      setRevealedCodes(res.batch!.codes);
      toast.success(`已生成 ${res.batch!.codes.length} 张充值码`);
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
          生成批次
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TicketIcon /> 生成充值码批次
          </DialogTitle>
          <DialogDescription>充值码明文仅显示一次，请立即保存</DialogDescription>
        </DialogHeader>

        {revealedCodes ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                已生成 {revealedCodes.length} 张充值码（请立即保存）
              </p>
              <CopyButton text={revealedCodes.join('\n')} label="全部复制" />
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
                    <FieldLabel htmlFor="b-name">批次名称</FieldLabel>
                    <Input id="b-name" placeholder="例如 双十一活动" {...field} />
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
                      <FieldLabel htmlFor="b-amount">面值（元）</FieldLabel>
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
                      <FieldLabel htmlFor="b-count">数量（1-1000）</FieldLabel>
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
                    <FieldLabel htmlFor="b-note">备注（可选）</FieldLabel>
                    <Input id="b-note" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="expiresAt"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="b-exp">过期时间（可选）</FieldLabel>
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
              <Button variant="outline">关闭</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">取消</Button>
              </DialogClose>
              <Button type="submit" form="batch-form" disabled={pending}>
                {pending && <Loader2Icon className="animate-spin" />}生成
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
