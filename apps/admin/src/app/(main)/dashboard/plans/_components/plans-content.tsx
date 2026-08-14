'use client';

import { useState, useTransition } from 'react';

import {
  GemIcon,
  Loader2Icon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
} from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { formatMoney, formatPoints } from '@ai-gateway/api-client/formatters';
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

import type { PlanRow } from '../types';

/** 周期天数展示：30→月，365→年，其余按天。 */
function fmtPeriod(days: number): string {
  if (days === 30) return '月';
  if (days === 365) return '年';
  return `${days} 天`;
}

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
function MoneyPoints({ value }: { value: string }) {
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{formatPoints(value)} 积分</span>
    </span>
  );
}

function StatusBadge({ status }: { status: number }) {
  if (status === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        上架
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      下架
    </span>
  );
}

export function PlansTable({ plans }: { readonly plans: ReadonlyArray<PlanRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead className="text-right">价格</TableHead>
          <TableHead className="w-20">周期</TableHead>
          <TableHead className="text-right">额度</TableHead>
          <TableHead>余额兜底</TableHead>
          <TableHead className="w-24">状态</TableHead>
          <TableHead className="w-28 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              暂无套餐
            </TableCell>
          </TableRow>
        ) : (
          plans.map((p) => <PlanRowItem key={p.id} plan={p} />)
        )}
      </TableBody>
    </Table>
  );
}

function PlanRowItem({ plan }: { plan: PlanRow }) {
  const [pending, setPending] = useState(false);
  return (
    <TableRow>
      <TableCell className="font-medium">{plan.name}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={plan.price} />
      </TableCell>
      <TableCell>{fmtPeriod(plan.periodDays)}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={plan.quotaAmount} />
      </TableCell>
      <TableCell>
        {plan.fallbackToBalance ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            允许
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            不允许
          </span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={plan.status} />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <EditPlanDialog plan={plan} />
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={async () => {
              if (!confirm(`确定删除套餐 ${plan.name}？若有有效订阅会失败。`)) return;
              setPending(true);
              const { deletePlanAction } = await import('../actions');
              const res = await deletePlanAction(plan.id);
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

const createSchema = z.object({
  name: z.string().min(1, '请输入名称'),
  price: numericText({ message: '请输入有效价格' }).refine((v) => v > 0, '价格须 > 0'),
  periodDays: z.string().refine((v) => v === '30' || v === '365', '请选择周期'),
  quotaAmount: numericText({ message: '请输入有效额度' }).refine((v) => v > 0, '额度须 > 0'),
  fallbackToBalance: z.boolean(),
});

export function CreatePlanDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      name: '',
      price: '',
      periodDays: '30',
      quotaAmount: '',
      fallbackToBalance: false,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createPlanAction } = await import('../actions');
      const res = await createPlanAction({
        name: values.name,
        price: Number(values.price),
        periodDays: Number(values.periodDays),
        quotaAmount: Number(values.quotaAmount),
        fallbackToBalance: values.fallbackToBalance,
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
          新建套餐
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GemIcon /> 新建套餐
          </DialogTitle>
          <DialogDescription>设置售价、周期与套餐额度（额度耗尽后可余额兜底）</DialogDescription>
        </DialogHeader>
        <PlanForm form={form} onSubmit={onSubmit} formId="plan-form" />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="plan-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const editSchema = z.object({
  name: z.string().min(1, '请输入名称'),
  price: numericText({ message: '请输入有效价格' }).refine((v) => v > 0, '价格须 > 0'),
  periodDays: z.string().refine((v) => v === '30' || v === '365', '请选择周期'),
  quotaAmount: numericText({ message: '请输入有效额度' }).refine((v) => v > 0, '额度须 > 0'),
  fallbackToBalance: z.boolean(),
  status: z.coerce.number().int(),
});

function EditPlanDialog({ plan }: { plan: PlanRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: plan.name,
      price: plan.price,
      periodDays: String(plan.periodDays),
      quotaAmount: plan.quotaAmount,
      fallbackToBalance: plan.fallbackToBalance,
      status: plan.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updatePlanAction } = await import('../actions');
      const res = await updatePlanAction(plan.id, {
        name: values.name,
        price: Number(values.price),
        periodDays: Number(values.periodDays),
        quotaAmount: Number(values.quotaAmount),
        fallbackToBalance: values.fallbackToBalance,
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
            <PencilIcon /> 编辑套餐 - {plan.name}
          </DialogTitle>
        </DialogHeader>
        <PlanForm form={form} onSubmit={onSubmit} formId="plan-edit-form" isEdit />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="plan-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 复用表单字段（创建 / 编辑）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PlanForm({
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
              <FieldLabel htmlFor="plan-name">名称</FieldLabel>
              <Input id="plan-name" placeholder="例如 标准月卡 / 旗舰年卡" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <NumberField
          control={form.control}
          name="price"
          label="售价（元）"
          id="plan-price"
          step="0.01"
          min={0}
        />
        <Controller
          control={form.control}
          name="periodDays"
          render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
            <Field>
              <FieldLabel>周期</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">月付（30 天）</SelectItem>
                  <SelectItem value="365">年付（365 天）</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <NumberField
          control={form.control}
          name="quotaAmount"
          label="套餐额度（元）"
          id="plan-quota"
          step="0.01"
          min={0}
        />
        <Controller
          control={form.control}
          name="fallbackToBalance"
          render={({
            field,
          }: {
            field: { value: boolean; onChange: (v: boolean) => void };
          }) => (
            <Field>
              <FieldLabel>额度耗尽后</FieldLabel>
              <Select
                value={field.value ? '1' : '0'}
                onValueChange={(v) => field.onChange(v === '1')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">余额兜底</SelectItem>
                  <SelectItem value="0">停止（不扣余额）</SelectItem>
                </SelectContent>
              </Select>
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
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">上架</SelectItem>
                    <SelectItem value="1">下架</SelectItem>
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
