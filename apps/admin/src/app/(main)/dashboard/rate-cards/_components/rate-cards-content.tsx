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
import { numericText } from '@ai-gateway/ui/lib/forms';

import type { RateCardRow } from '../types';

const createSchema = z.object({
  name: z.string().min(1),
  coefficient: numericText({ message: '请输入有效系数' }).refine(
    (v) => v >= 0 && v <= 10,
    '系数范围 0-10',
  ),
  description: z.string().optional(),
});

export function RateCardsTable({ cards }: { readonly cards: ReadonlyArray<RateCardRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead className="text-right">系数</TableHead>
          <TableHead>说明</TableHead>
          <TableHead className="w-24">状态</TableHead>
          <TableHead className="w-44">更新时间</TableHead>
          <TableHead className="w-28 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              暂无费率卡
            </TableCell>
          </TableRow>
        ) : (
          cards.map((c) => <RateCardRowItem key={c.id} card={c} />)
        )}
      </TableBody>
    </Table>
  );
}

function RateCardRowItem({ card }: { card: RateCardRow }) {
  const [pending, setPending] = useState(false);
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
          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            启用
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            禁用
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(card.updatedAt).toLocaleString('zh-CN')}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button asChild size="sm" variant="ghost" title="查看用户">
            <Link href={`/dashboard/rate-cards/${card.id}`}>
              <EyeIcon />
            </Link>
          </Button>
          <EditRateCardDialog card={card} />
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={async () => {
              if (!confirm(`确定删除费率卡 ${card.name}？若有绑定用户会失败。`)) return;
              setPending(true);
              const { deleteRateCardAction } = await import('../actions');
              const res = await deleteRateCardAction(card.id);
              setPending(false);
              if (res.error) toast.error(res.error);
              else toast.success('已删除');
            }}
            className="text-destructive hover:text-destructive"
          >
            {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function CreateRateCardDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
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
        coefficient: Number(values.coefficient),
        description: values.description?.trim() || undefined,
      });
      if (res.error) {
        toast.error('创建失败', { description: res.error });
        return;
      }
      toast.success('已创建');
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircleIcon />
          新建费率卡
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BanknoteIcon /> 新建费率卡
          </DialogTitle>
          <DialogDescription>设置系数（用于打折或加成）</DialogDescription>
        </DialogHeader>
        <RateCardForm form={form} onSubmit={onSubmit} formId="rc-form" />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="rc-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const editSchema = z.object({
  name: z.string().min(1),
  coefficient: numericText({ message: '请输入有效系数' }).refine(
    (v) => v >= 0 && v <= 10,
    '系数范围 0-10',
  ),
  description: z.string().optional(),
  status: z.coerce.number().int(),
});

function EditRateCardDialog({ card }: { card: RateCardRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
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
        coefficient: Number(values.coefficient),
        description: values.description?.trim() || undefined,
        status: Number(values.status),
      });
      if (res.error) {
        toast.error('保存失败', { description: res.error });
        return;
      }
      toast.success('已保存');
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="编辑">
          <PencilIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> 编辑费率卡 - {card.name}
          </DialogTitle>
        </DialogHeader>
        <RateCardForm form={form} onSubmit={onSubmit} formId="rc-edit-form" isEdit />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="rc-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}保存
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
              <FieldLabel htmlFor="rc-name">名称</FieldLabel>
              <Input id="rc-name" placeholder="例如 标准版 / 8 折版" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <NumberField
          control={form.control}
          name="coefficient"
          label="系数（0-10，1 = 原价）"
          id="rc-coef"
          step="0.05"
          min={0}
        />
        <Controller
          control={form.control}
          name="description"
          render={({ field }: { field: { value: string } }) => (
            <Field>
              <FieldLabel htmlFor="rc-desc">说明</FieldLabel>
              <Input id="rc-desc" placeholder="可选" {...field} />
            </Field>
          )}
        />
        {isEdit && (
          <Controller
            control={form.control}
            name="status"
            render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
              <Field>
                <FieldLabel>状态</FieldLabel>
                <Select
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">启用</SelectItem>
                    <SelectItem value="1">禁用</SelectItem>
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
