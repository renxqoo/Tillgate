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

const createSchema = z.object({
  name: z.string().min(1),
  coefficient: z.string().regex(/^(?:[0-9](?:\.\d{1,3})?)$/, '系数范围 0.001-9.999，最多 3 位小数')
    .refine((v) => v !== '0' && !/^0\.0+$/.test(v), '系数必须大于 0'),
  description: z.string().optional(),
});

export function RateCardsTable({ cards }: { readonly cards: ReadonlyArray<AdminRateCardRow> }) {
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

function RateCardRowItem({ card }: { card: AdminRateCardRow }) {
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
          <StatusPill tone="success" label="启用" />
        ) : (
          <StatusPill tone="neutral" label="禁用" />
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {fmtDateTime(card.updatedAt)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button asChild size="sm" variant="ghost" title="查看用户">
            <Link href={`/dashboard/rate-cards/${card.id}`}>
              <EyeIcon />
            </Link>
          </Button>
          <EditRateCardDialog card={card} />
          <ConfirmAction
            confirm={`确定删除费率卡 ${card.name}？若有绑定用户会失败。`}
            action={async () => (await import('../actions')).deleteRateCardAction(card.id)}
            success='已删除'
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
  const notify = useActionResult();
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
        coefficient: values.coefficient,
        description: values.description?.trim() || undefined,
      });
      if (!notify(res, '创建失败', '已创建')) return;
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
  coefficient: z.string().regex(/^(?:[0-9](?:\.\d{1,3})?)$/, '系数范围 0.001-9.999，最多 3 位小数')
    .refine((v) => v !== '0' && !/^0\.0+$/.test(v), '系数必须大于 0'),
  description: z.string().optional(),
  status: z.coerce.number().int(),
});

function EditRateCardDialog({ card }: { card: AdminRateCardRow }) {
  const notify = useActionResult();
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
        coefficient: values.coefficient,
        description: values.description?.trim() || undefined,
        status: Number(values.status),
      });
      if (!notify(res, '保存失败', '已保存')) return;
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
          label="系数（0.001-9.999，1 = 原价）"
          id="rc-coef"
          step="0.05"
          min={0.001}
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
