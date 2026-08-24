'use client';

import { StatusPill } from '@/components/status-pill';
import {
  Button,
  ConfirmDialog,
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
  FieldError,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
  RowActions,
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
import { NumberField } from '@/components/number-field';
import { useState, useTransition } from 'react';

import {
  GemIcon,
  GiftIcon,
  Loader2Icon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { formatMoney, formatPoints } from '@/lib/formatters';
import { moneyText } from '@/lib/forms';

import type { PlanRow } from '@tokenlens/api-client';
import { useActionResult } from '@/components/action-toast';

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
function MoneyPoints({ value }: { value: string }) {
  const tUi = useTranslations('ui');
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">
        {formatPoints(value)} {tUi('points')}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('plans');
  if (status === 0) {
    return <StatusPill tone="success" label={t('listed')} />;
  }
  return <StatusPill tone="neutral" label={t('unlisted')} />;
}

function KindBadge({ kind }: { kind: PlanRow['kind'] }) {
  const t = useTranslations('plans');
  if (kind === 'pack') {
    return <StatusPill tone="accent" label={t('pack')} />;
  }
  return <StatusPill tone="info" label={t('subscription')} />;
}

export function PlansTable({ plans }: { readonly plans: ReadonlyArray<PlanRow> }) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');

  /** 周期天数展示：30→月，365→年，其余按天。 */
  function fmtPeriod(days: number): string {
    if (days === 30) return t('periodMonth');
    if (days === 365) return t('periodYear');
    return t('periodDays', { days });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="w-20">{tc('type')}</TableHead>
          <TableHead className="w-16">{t('tier')}</TableHead>
          <TableHead className="text-right">{t('price')}</TableHead>
          <TableHead className="w-20">{t('period')}</TableHead>
          <TableHead className="text-right">{t('quota')}</TableHead>
          <TableHead className="w-20">{t('seats')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
              {t('noPlans')}
            </TableCell>
          </TableRow>
        ) : (
          plans.map((p) => <PlanRowItem key={p.id} plan={p} fmtPeriod={fmtPeriod} tUi={tUi} />)
        )}
      </TableBody>
    </Table>
  );
}

function PlanRowItem({
  plan,
  fmtPeriod,
  tUi,
}: {
  plan: PlanRow;
  fmtPeriod: (days: number) => string;
  tUi: ReturnType<typeof useTranslations<'ui'>>;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const [deleting, setDeleting] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  let seatStatus = <StatusPill tone="neutral" label={t('personal')} />;
  if (plan.kind === 'pack') seatStatus = <span className="text-xs text-muted-foreground">—</span>;
  else if (plan.allowSeats) seatStatus = <StatusPill tone="accent" label={t('team')} />;

  async function runDelete() {
    setDeleting(true);
    const { deletePlanAction } = await import('@/server/plans-actions');
    const res = await deletePlanAction(plan.id);
    setDeleting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(tc('deleted'));
  }

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
      <TableCell>{seatStatus}</TableCell>
      <TableCell>
        <StatusBadge status={plan.status} />
      </TableCell>
      <TableCell className="w-16 text-center">
        {/* 行操作走全站统一的 RowActions 菜单项范式（勿在菜单面板里放独立 Button 竖排） */}
        <RowActions label={tc('actions')}>
          {plan.kind === 'pack' ? (
            <DropdownMenuItem onClick={() => setGrantOpen(true)}>
              <GiftIcon className="size-4" /> {t('grant')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <PencilIcon className="size-4" /> {tc('edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
            {deleting ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <Trash2Icon className="size-4" />
            )}
            {tc('delete')}
          </DropdownMenuItem>
        </RowActions>
        {plan.kind === 'pack' ? (
          <GrantPackDialog plan={plan} tUi={tUi} open={grantOpen} onOpenChange={setGrantOpen} />
        ) : null}
        <EditPlanDialog plan={plan} tUi={tUi} open={editOpen} onOpenChange={setEditOpen} />
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={tc('delete')}
          description={t('deleteConfirm', { name: plan.name })}
          confirmLabel={tc('delete')}
          cancelLabel={tUi('cancel')}
          tone="destructive"
          onConfirm={runDelete}
          onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
        />
      </TableCell>
    </TableRow>
  );
}

/** 发放加油包：输入 userId，扣 pack 售价、给用户余额加额度。 */
function GrantPackDialog({
  plan,
  tUi,
  open,
  onOpenChange,
}: {
  plan: PlanRow;
  tUi: ReturnType<typeof useTranslations<'ui'>>;
  /** 受控 open：由行操作菜单项打开 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const [userId, setUserId] = useState('');

  function submit() {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      toast.error(t('invalidUserId'));
      return;
    }
    startTransition(async () => {
      const { grantPackAction } = await import('@/server/plans-actions');
      const res = await grantPackAction(plan.id, uid);
      if (!notify(res, t('grantFailed'), t('granted'))) return;
      setUserId('');
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setUserId('');
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> {t('grantTitle', { name: plan.name })}
          </DialogTitle>
          <DialogDescription>
            {t('grantDescription', {
              price: formatMoney(plan.price),
              points: formatPoints(plan.quotaAmount),
            })}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormItem>
            <FieldLabel htmlFor="grant-user-id">{tc('userId')}</FieldLabel>
            <Input
              id="grant-user-id"
              type="number"
              min={1}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder={t('userIdPlaceholder')}
            />
          </FormItem>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmGrant')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 校验消息走目录：schema 在组件内用 t 构造
function buildCreateSchema(t: ReturnType<typeof useTranslations<'plans'>>) {
  return z.object({
    name: z.string().min(1, t('nameRequired')),
    kind: z.enum(['subscription', 'pack']),
    sortOrder: z
      .string()
      .refine(
        (v) => v.trim() === '' || (Number.isFinite(Number(v)) && Number.isInteger(Number(v))),
        t('tierInteger'),
      ),
    price: moneyText({ message: t('invalidPrice'), allowZero: false }),
    periodDays: z.string(),
    quotaAmount: moneyText({ message: t('invalidQuota'), allowZero: false }),
    allowSeats: z.boolean(),
  });
}

export function CreatePlanDialog() {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const createSchema = buildCreateSchema(t);
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
      const { createPlanAction } = await import('@/server/plans-actions');
      const res = await createPlanAction({
        name: values.name,
        kind: values.kind,
        sortOrder: values.sortOrder.trim() === '' ? null : Number(values.sortOrder),
        price: values.price,
        periodDays: values.kind === 'pack' ? 0 : Number(values.periodDays),
        quotaAmount: values.quotaAmount,
        allowSeats: values.allowSeats,
      });
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
            <GemIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <PlanForm form={form} onSubmit={onSubmit} formId="plan-form" />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="plan-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPlanDialog({
  plan,
  tUi,
  open,
  onOpenChange,
}: {
  plan: PlanRow;
  tUi: ReturnType<typeof useTranslations<'ui'>>;
  /** 受控 open：由行操作菜单项打开 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const editSchema = buildCreateSchema(t).extend({
    status: z.coerce.number().int(),
  });
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
      const { updatePlanAction } = await import('@/server/plans-actions');
      const res = await updatePlanAction(plan.id, {
        name: values.name,
        sortOrder: values.sortOrder.trim() === '' ? null : Number(values.sortOrder),
        price: values.price,
        periodDays: values.kind === 'pack' ? 0 : Number(values.periodDays),
        quotaAmount: values.quotaAmount,
        allowSeats: values.allowSeats,
        status: Number(values.status),
      });
      if (!notify(res, tc('saveFailed'), tc('saved'))) return;
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('editTitle', { name: plan.name })}
          </DialogTitle>
        </DialogHeader>
        <PlanForm form={form} onSubmit={onSubmit} formId="plan-edit-form" isEdit />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="plan-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
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
  const t = useTranslations('plans');
  const tc = useTranslations('common');
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
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-name">{tc('name')}</FieldLabel>
              <Input id="plan-name" placeholder={t('namePlaceholder')} {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="kind"
          render={({
            field,
          }: {
            field: {
              value: 'subscription' | 'pack';
              onChange: (v: 'subscription' | 'pack') => void;
            };
          }) => (
            <FormItem>
              <FieldLabel>{tc('type')}</FieldLabel>
              <Select
                value={field.value}
                onValueChange={(v) => field.onChange(v ?? 'subscription')}
                disabled={isEdit}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">{t('subscriptionOption')}</SelectItem>
                  <SelectItem value="pack">{t('packOption')}</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
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
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-sort">{t('tierLabel')}</FieldLabel>
              <Input id="plan-sort" type="number" step="1" placeholder={t('blank')} {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <NumberField
          control={form.control}
          name="price"
          label={t('priceLabel')}
          id="plan-price"
          step="0.01"
          min={0}
        />
        {!isPack && (
          <Controller
            control={form.control}
            name="periodDays"
            render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
              <FormItem>
                <FieldLabel>{t('period')}</FieldLabel>
                <Select value={field.value} onValueChange={(v) => v !== null && field.onChange(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">{t('monthly')}</SelectItem>
                    <SelectItem value="365">{t('yearly')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        )}
        <NumberField
          control={form.control}
          name="quotaAmount"
          label={t('quotaLabel')}
          id="plan-quota"
          step="0.01"
          min={0}
        />
        {!isPack && (
          <Controller
            control={form.control}
            name="allowSeats"
            render={({ field }: { field: { value: boolean; onChange: (v: boolean) => void } }) => (
              <FormItem>
                <FieldLabel>{t('seatsMode')}</FieldLabel>
                <Select
                  value={field.value ? '1' : '0'}
                  onValueChange={(v) => field.onChange(v === '1')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{t('personalOption')}</SelectItem>
                    <SelectItem value="1">{t('teamOption')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        )}
        {isEdit && (
          <Controller
            control={form.control}
            name="status"
            render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
              <FormItem>
                <FieldLabel>{tc('status')}</FieldLabel>
                <Select
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{t('listed')}</SelectItem>
                    <SelectItem value="1">{t('unlisted')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        )}
      </FieldGroup>
    </form>
  );
}
