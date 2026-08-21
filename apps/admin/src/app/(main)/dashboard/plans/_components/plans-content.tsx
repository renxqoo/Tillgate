'use client';

import { useState, useTransition } from 'react';

import {
  GemIcon,
  GiftIcon,
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
import { moneyText } from '@ai-gateway/ui/lib/forms';

import type { PlanRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

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
      <StatusPill tone="success" label="上架" />
    );
  }
  return (
    <StatusPill tone="neutral" label="下架" />
  );
}

function KindBadge({ kind }: { kind: PlanRow['kind'] }) {
  if (kind === 'pack') {
    return (
      <StatusPill tone="accent" label="加油包" />
    );
  }
  return (
    <StatusPill tone="info" label="包月" />
  );
}

export function PlansTable({ plans }: { readonly plans: ReadonlyArray<PlanRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead className="w-20">类型</TableHead>
          <TableHead className="w-16">层级</TableHead>
          <TableHead className="text-right">价格</TableHead>
          <TableHead className="w-20">周期</TableHead>
          <TableHead className="text-right">额度</TableHead>
          <TableHead className="w-20">席位</TableHead>
          <TableHead className="w-24">状态</TableHead>
          <TableHead className="w-36 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
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
  return (
    <TableRow>
      <TableCell className="font-medium">{plan.name}</TableCell>
      <TableCell>
        <KindBadge kind={plan.kind} />
      </TableCell>
      <TableCell className="tabular-nums">{plan.sortOrder ?? '—'}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={plan.price} />
      </TableCell>
      <TableCell>{plan.kind === 'pack' ? '—' : fmtPeriod(plan.periodDays)}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={plan.quotaAmount} />
      </TableCell>
      <TableCell>
        {plan.kind === 'pack' ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : plan.allowSeats ? (
          <StatusPill tone="accent" label="团队" />
        ) : (
          <StatusPill tone="neutral" label="个人" />
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={plan.status} />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {plan.kind === 'pack' ? <GrantPackDialog plan={plan} /> : null}
          <EditPlanDialog plan={plan} />
          <ConfirmAction
            confirm={`确定删除套餐 ${plan.name}？若有有效订阅会失败。`}
            action={async () => (await import('../actions')).deletePlanAction(plan.id)}
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

/** 发放加油包：输入 userId，扣 pack 售价、给用户余额加额度。 */
function GrantPackDialog({ plan }: { plan: PlanRow }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [userId, setUserId] = useState('');

  function submit() {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      toast.error('请输入有效用户 ID');
      return;
    }
    startTransition(async () => {
      const { grantPackAction } = await import('../actions');
      const res = await grantPackAction(plan.id, uid);
      if (!notify(res, '发放失败', '已发放')) return;
      setUserId('');
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setUserId('');
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="发放加油包">
          <GiftIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> 发放加油包 - {plan.name}
          </DialogTitle>
          <DialogDescription>
            给指定用户发放该加油包：扣售价 {formatMoney(plan.price)} 元，用户余额增加{' '}
            {formatPoints(plan.quotaAmount)} 积分。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="grant-user-id">用户 ID</FieldLabel>
            <Input
              id="grant-user-id"
              type="number"
              min={1}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="例如 1001"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认发放
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const createSchema = z.object({
  name: z.string().min(1, '请输入名称'),
  kind: z.enum(['subscription', 'pack']),
  sortOrder: z
    .string()
    .refine(
      (v) => v.trim() === '' || (Number.isFinite(Number(v)) && Number.isInteger(Number(v))),
      '层级须为整数',
    ),
  price: moneyText({ message: '请输入有效价格', allowZero: false }),
  periodDays: z.string(),
  quotaAmount: moneyText({ message: '请输入有效额度', allowZero: false }),
  allowSeats: z.boolean(),
});

const editSchema = createSchema.extend({
  status: z.coerce.number().int(),
});

export function CreatePlanDialog() {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      name: '',
      kind: 'subscription',
      sortOrder: '',
      price: '',
      periodDays: '30',
      quotaAmount: '',
      allowSeats: false,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createPlanAction } = await import('../actions');
      const res = await createPlanAction({
        name: values.name,
        kind: values.kind,
        sortOrder: values.sortOrder.trim() === '' ? null : Number(values.sortOrder),
        price: values.price,
        periodDays: values.kind === 'pack' ? 0 : Number(values.periodDays),
        quotaAmount: values.quotaAmount,
        allowSeats: values.allowSeats,
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
          新建套餐
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GemIcon /> 新建套餐
          </DialogTitle>
          <DialogDescription>设置类型、售价、周期与套餐额度（额度按官方价×系数折算扣减）</DialogDescription>
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

function EditPlanDialog({ plan }: { plan: PlanRow }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: plan.name,
      kind: plan.kind,
      sortOrder: plan.sortOrder === null ? '' : String(plan.sortOrder),
      price: plan.price,
      periodDays: String(plan.periodDays),
      quotaAmount: plan.quotaAmount,
      allowSeats: plan.allowSeats,
      status: plan.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updatePlanAction } = await import('../actions');
      const res = await updatePlanAction(plan.id, {
        name: values.name,
        sortOrder: values.sortOrder.trim() === '' ? null : Number(values.sortOrder),
        price: values.price,
        periodDays: values.kind === 'pack' ? 0 : Number(values.periodDays),
        quotaAmount: values.quotaAmount,
        allowSeats: values.allowSeats,
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
  const kind: 'subscription' | 'pack' = form.watch('kind');
  const isPack = kind === 'pack';

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
              <Input id="plan-name" placeholder="例如 标准月卡 / 旗舰年卡 / 加油包" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="kind"
          render={({
            field,
          }: {
            field: { value: 'subscription' | 'pack'; onChange: (v: 'subscription' | 'pack') => void };
          }) => (
            <Field>
              <FieldLabel>类型</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">包月订阅</SelectItem>
                  <SelectItem value="pack">加油包</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="sortOrder"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-sort">层级（可空，越大越高级）</FieldLabel>
              <Input id="plan-sort" type="number" step="1" placeholder="可空" {...field} />
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
        {!isPack && (
          <Controller
            control={form.control}
            name="periodDays"
            render={({
              field,
            }: {
              field: { value: string; onChange: (v: string) => void };
            }) => (
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
        )}
        <NumberField
          control={form.control}
          name="quotaAmount"
          label="套餐额度（元）"
          id="plan-quota"
          step="0.01"
          min={0}
        />
        {!isPack && (
          <Controller
            control={form.control}
            name="allowSeats"
            render={({
              field,
            }: {
              field: { value: boolean; onChange: (v: boolean) => void };
            }) => (
              <Field>
                <FieldLabel>席位模式</FieldLabel>
                <Select
                  value={field.value ? '1' : '0'}
                  onValueChange={(v) => field.onChange(v === '1')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">个人套餐（固定 1 席）</SelectItem>
                    <SelectItem value="1">团队套餐（支持加席位）</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
        )}
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
