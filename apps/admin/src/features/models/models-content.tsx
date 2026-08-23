'use client';

import { StatusPill } from '@/components/status-pill';
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@tokenlens/ui';
import { NumberField } from '@/components/number-field';
import { useState, useTransition } from 'react';

import {
  CpuIcon,
  FlaskConicalIcon,
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
  RotateCcwIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import type { ModelTestResult } from '@/server/models-actions';
import { numericText } from '@/lib/forms';
import { fmtPrice, unitWord } from '@/lib/formatters';

/** 上下文窗口 token 数展示：65536 → 64K，1000000 → 1M，未知 → — */
function fmtContext(tokens: number | null): string {
  if (tokens == null || tokens <= 0) return '—';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

import type { ChannelOption, AdminModelRow } from '@tokenlens/api-client';
import { useActionResult } from '@/components/action-toast';
import { ConfirmAction } from '@/components/confirm-action';

const PRICING_UNITS = ['token', 'request', 'image', 'second', 'char'] as const;
type PricingUnit = (typeof PRICING_UNITS)[number];

/** 计价方式选项的 label 走目录（models 命名空间），渲染处按 locale 解析 */
function pricingUnitOptions(
  t: ReturnType<typeof useTranslations<'models'>>,
): ReadonlyArray<{ value: PricingUnit; label: string }> {
  return [
    { value: 'token', label: t('unitToken') },
    { value: 'image', label: t('unitImage') },
    { value: 'second', label: t('unitSecond') },
    { value: 'char', label: t('unitChar') },
    { value: 'request', label: t('unitRequest') },
  ];
}

/** 差价档位（勾选制）：label=界面档位名，value=预填参数值（需与请求参数完全一致，可改） */
const TIER_PRESETS: Partial<Record<PricingUnit, ReadonlyArray<{ label: string; value: string }>>> =
  {
    image: [
      { label: '1K', value: '1024*1024' },
      { label: '2K', value: '2048*2048' },
    ],
    second: [
      { label: '480p', value: '480p' },
      { label: '720p', value: '720p' },
      { label: '1080p', value: '1080p' },
    ],
  };

type TierRow = {
  /** 档位名（预设档位显示用；自定义档位 = 参数值本身） */
  label: string;
  /** 计费匹配用的请求参数值 */
  value: string;
  price: string;
  /** 预设档位是否启用（勾选）；自定义档位恒开 */
  on: boolean;
  custom: boolean;
};

/** 由计价单位 + 既有 billingConfig 构造档位行：参数值（或档位名）精确匹配预设归位，其余进自定义行 */
function buildTiers(
  unit: string,
  cfg?: { params?: { selector?: string; prices?: Record<string, string> } },
): TierRow[] {
  const presets = TIER_PRESETS[unit as PricingUnit] ?? [];
  const prices = cfg?.params?.prices ?? {};
  const rows: TierRow[] = presets.map((p) => {
    const price = prices[p.value] ?? prices[p.label];
    return { label: p.label, value: p.value, price: price ?? '', on: price != null, custom: false };
  });
  const known = new Set([...presets.map((p) => p.value), ...presets.map((p) => p.label)]);
  for (const [key, price] of Object.entries(prices)) {
    if (!known.has(key)) rows.push({ label: key, value: key, price, on: true, custom: true });
  }
  return rows;
}

/** 金额格式（与 moneyText 同口径）——分支校验挂到具体字段用 */
const MONEY_PATTERN = /^\d{1,20}(?:\.\d{1,18})?$/;

/**
 * 价格分支校验：只校验当前计价方式下可见的字段。
 * 隐藏字段不参与校验——否则切到单位计价后隐藏的 token 三价仍必填，提交必挂。
 */
function refinePricing(
  v: {
    pricingUnit: string;
    inputPrice: string;
    outputPrice: string;
    cacheInputPrice: string;
    cacheWritePrice?: string;
    unitPrice?: string;
  },
  ctx: z.RefinementCtx,
  invalidPrice: string,
) {
  const bad = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (v.pricingUnit === 'token') {
    if (!MONEY_PATTERN.test(v.inputPrice ?? '')) bad('inputPrice', invalidPrice);
    if (!MONEY_PATTERN.test(v.outputPrice ?? '')) bad('outputPrice', invalidPrice);
    if (!MONEY_PATTERN.test(v.cacheInputPrice ?? '')) bad('cacheInputPrice', invalidPrice);
    if (
      v.cacheWritePrice != null &&
      v.cacheWritePrice !== '' &&
      !MONEY_PATTERN.test(v.cacheWritePrice)
    )
      bad('cacheWritePrice', invalidPrice);
  } else if (v.pricingUnit !== '') {
    if (!MONEY_PATTERN.test(v.unitPrice ?? '')) bad('unitPrice', invalidPrice);
  }
}

/** 校验消息走目录：schema 在组件内用 t 构造 */
function buildCreateSchema(t: ReturnType<typeof useTranslations<'models'>>) {
  /** 可空整数文本（上下文窗口）：空 = 不填（提交 null，与 API nullable 对齐）；非空需为正整数 */
  const optionalIntText = z
    .string()
    .refine(
      (v) => v.trim() === '' || (Number.isInteger(Number(v)) && Number(v) > 0),
      t('contextInvalid'),
    );

  return z
    .object({
      externalName: z.string().min(1),
      realModel: z.string().min(1),
      inputPrice: z.string(),
      outputPrice: z.string(),
      cacheInputPrice: z.string(),
      cacheWritePrice: z.string(),
      pricingUnit: z
        .string()
        .refine(
          (v): v is PricingUnit => (PRICING_UNITS as readonly string[]).includes(v),
          t('unitRequired'),
        ),
      unitPrice: z.string(),
      isFree: z.boolean().optional(),
      contextLength: optionalIntText,
    })
    .superRefine((v, ctx) => refinePricing(v, ctx, t('invalidPrice')));
}

function buildEditSchema(
  t: ReturnType<typeof useTranslations<'models'>>,
  tc: ReturnType<typeof useTranslations<'common'>>,
) {
  const optionalIntText = z
    .string()
    .refine(
      (v) => v.trim() === '' || (Number.isInteger(Number(v)) && Number(v) > 0),
      t('contextInvalid'),
    );

  return z
    .object({
      externalName: z.string().min(1),
      realModel: z.string().min(1),
      inputPrice: z.string(),
      outputPrice: z.string(),
      cacheInputPrice: z.string(),
      cacheWritePrice: z.string(),
      pricingUnit: z
        .string()
        .refine(
          (v): v is PricingUnit => (PRICING_UNITS as readonly string[]).includes(v),
          t('unitRequired'),
        ),
      unitPrice: z.string(),
      isFree: z.boolean().optional(),
      contextLength: optionalIntText,
      fallbackModels: z.string().optional(),
      paramRules: z.string().optional(),
      billingPolicy: z
        .string()
        .optional()
        .refine((value) => {
          if (!value?.trim()) return true;
          try {
            JSON.parse(value);
            return true;
          } catch {
            return false;
          }
        }, t('invalidJson')),
      rpmLimit: z.string().optional(),
      tpmLimit: z.string().optional(),
      status: numericText({ message: tc('invalidInteger') }).refine(
        (v) => Number.isInteger(v),
        tc('invalidInteger'),
      ),
    })
    .superRefine((v, ctx) => refinePricing(v, ctx, t('invalidPrice')));
}

export function ModelsTable({
  models,
  channels,
}: {
  readonly models: ReadonlyArray<AdminModelRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('externalName')}</TableHead>
          <TableHead>{t('realModel')}</TableHead>
          <TableHead className="text-right">{t('inputPrice')}</TableHead>
          <TableHead className="text-right">{t('outputPrice')}</TableHead>
          <TableHead className="text-right">{t('cachePrice')}</TableHead>
          <TableHead>{t('fallbackModels')}</TableHead>
          <TableHead className="w-44">{tc('status')}</TableHead>
          <TableHead className="text-right">{t('context')}</TableHead>
          <TableHead className="w-32 text-right">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
              {t('noModels')}
            </TableCell>
          </TableRow>
        ) : (
          models.map((m) => <ModelRowItem key={m.id} model={m} channels={channels} />)
        )}
      </TableBody>
    </Table>
  );
}

function ModelRowItem({
  model,
  channels,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const locale = useLocale() as 'en' | 'zh';
  return (
    <TableRow>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{model.externalName}</code>
        {model.isFree && <StatusPill className="ml-2" tone="info" label={tc('free')} />}
      </TableCell>
      <TableCell className="font-medium">{model.realModel}</TableCell>
      <TableCell className="text-right tabular-nums">
        {model.pricingUnit && model.pricingUnit !== 'token' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>¥{fmtPrice(model.inputPrice)}/M</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {model.pricingUnit && model.pricingUnit !== 'token' ? (
          <span>
            ¥{fmtPrice(model.unitPrice ?? '0')}/{unitWord(model.pricingUnit, locale)}
          </span>
        ) : (
          <span>¥{fmtPrice(model.outputPrice)}/M</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {model.pricingUnit && model.pricingUnit !== 'token' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>¥{fmtPrice(model.cacheInputPrice)}/M</span>
        )}
      </TableCell>
      <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
        {model.fallbackModels ?? '—'}
      </TableCell>
      <TableCell>
        {model.status === 0 ? (
          <StatusPill tone="success" label={tc('enabled')} />
        ) : (
          <StatusPill tone="neutral" label={t('delisted')} />
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtContext(model.contextLength)}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <BindChannelsDialog model={model} channels={channels} />
          <EditModelDialog model={model} />
          <TestModelDialog model={model} />
          {model.status === 0 ? (
            <ConfirmAction
              confirm={t('delistConfirm', { name: model.externalName })}
              action={async () =>
                (await import('@/server/models-actions')).deleteModelAction(model.id)
              }
              success={t('delistSuccess')}
            >
              {({ pending, onClick }) => (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={onClick}
                  className="text-destructive hover:text-destructive"
                  title={t('delist')}
                >
                  {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                </Button>
              )}
            </ConfirmAction>
          ) : (
            <ConfirmAction
              confirm={t('restoreConfirm', { name: model.externalName })}
              action={async () =>
                (await import('@/server/models-actions')).restoreModelAction(model.id)
              }
              success={t('restoreSuccess')}
            >
              {({ pending, onClick }) => (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={onClick}
                  title={t('restore')}
                >
                  {pending ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <RotateCcwIcon className="size-4" />
                  )}
                </Button>
              )}
            </ConfirmAction>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function CreateModelDialog() {
  const t = useTranslations('models');
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
      externalName: '',
      realModel: '',
      inputPrice: '',
      outputPrice: '',
      cacheInputPrice: '',
      cacheWritePrice: '',
      pricingUnit: '',
      unitPrice: '',
      isFree: false,
      contextLength: '',
    },
  });

  function onSubmit(values: WithBillingConfig<FormValues>) {
    startTransition(async () => {
      const { createModelAction } = await import('@/server/models-actions');
      const tokenMode = values.pricingUnit === 'token';
      const res = await createModelAction({
        externalName: values.externalName,
        realModel: values.realModel,
        pricingUnit: values.pricingUnit,
        // 只提交当前计价方式下的价格：token 三价 / 单位单价（另一侧字段对 API 无意义，补 0 占位）
        ...(tokenMode
          ? {
              inputPrice: values.inputPrice,
              outputPrice: values.outputPrice,
              cacheInputPrice: values.cacheInputPrice,
              ...(values.cacheWritePrice !== '' ? { cacheWritePrice: values.cacheWritePrice } : {}),
            }
          : {
              inputPrice: '0',
              outputPrice: '0',
              cacheInputPrice: '0',
              unitPrice: values.unitPrice,
            }),
        // billingConfig 由 ModelForm 差价编辑器并入（单位计价 + 按参数差价时存在）
        ...(values.billingConfig != null ? { billingConfig: values.billingConfig } : {}),
        isFree: values.isFree ?? false,
        contextLength: values.contextLength.trim() === '' ? null : Number(values.contextLength),
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
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CpuIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <ModelForm form={form} onSubmit={onSubmit} formId="model-form" />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="model-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ModelForm 差价编辑器并入的提交载荷扩展（billingConfig 不走 RHF 字段） */
type WithBillingConfig<V> = V & {
  billingConfig?: {
    strategy?: string;
    params?: { selector?: string; prices?: Record<string, string> };
  };
};

function EditModelDialog({ model }: { model: AdminModelRow }) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const editSchema = buildEditSchema(t, tc);
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      externalName: model.externalName,
      realModel: model.realModel,
      inputPrice: model.inputPrice ?? '',
      outputPrice: model.outputPrice ?? '',
      cacheInputPrice: model.cacheInputPrice ?? '',
      cacheWritePrice: model.cacheWritePrice ?? '',
      pricingUnit: model.pricingUnit ?? 'token',
      unitPrice: model.unitPrice ? String(Number(model.unitPrice)) : '',
      isFree: model.isFree ?? false,
      contextLength: model.contextLength == null ? '' : String(model.contextLength),
      fallbackModels: model.fallbackModels ?? '',
      paramRules: model.paramRules ?? '',
      billingPolicy: model.billingPolicy ? JSON.stringify(model.billingPolicy, null, 2) : '',
      rpmLimit: model.rpmLimit === null ? '' : String(model.rpmLimit),
      tpmLimit: model.tpmLimit === null ? '' : String(model.tpmLimit),
      status: String(model.status),
    },
  });

  function onSubmit(values: WithBillingConfig<FormValues>) {
    startTransition(async () => {
      const { updateModelAction } = await import('@/server/models-actions');
      const tokenMode = values.pricingUnit === 'token';
      const res = await updateModelAction(model.id, {
        externalName: values.externalName,
        realModel: values.realModel,
        pricingUnit: values.pricingUnit,
        // 只提交当前计价方式下的价格（另一侧保留 DB 旧值，计费按 pricingUnit 分流不受影响）
        ...(tokenMode
          ? {
              inputPrice: values.inputPrice,
              outputPrice: values.outputPrice,
              cacheInputPrice: values.cacheInputPrice,
              ...(values.cacheWritePrice !== '' ? { cacheWritePrice: values.cacheWritePrice } : {}),
            }
          : { unitPrice: values.unitPrice }),
        // 差价配置显式管理：勾选差价提交 variant，否则 null 清除（避免 DB 残留与界面不一致）
        ...(tokenMode || values.billingConfig == null
          ? { billingConfig: null }
          : { billingConfig: values.billingConfig }),
        isFree: values.isFree ?? false,
        contextLength: values.contextLength.trim() === '' ? null : Number(values.contextLength),
        fallbackModels: values.fallbackModels?.trim() || undefined,
        paramRules: values.paramRules?.trim() || undefined,
        billingPolicy: values.billingPolicy?.trim()
          ? (JSON.parse(values.billingPolicy) as Record<string, unknown>)
          : null,
        rpmLimit: values.rpmLimit === '' ? null : Number(values.rpmLimit),
        tpmLimit: values.tpmLimit === '' ? null : Number(values.tpmLimit),
        status: Number(values.status),
      });
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
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('editTitle', { name: model.externalName })}
          </DialogTitle>
        </DialogHeader>
        <ModelForm
          form={form}
          onSubmit={onSubmit}
          formId="model-edit-form"
          isEdit
          initialBillingConfig={model.billingConfig ?? undefined}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="model-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ModelForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
  initialBillingConfig,
}: {
  form: any;
  // biome-ignore lint: 表单值形状由两个调用方的 zod 推断，此处宽收（差价编辑器在内部并入 billingConfig）
  onSubmit: (v: any) => void;
  formId: string;
  isEdit?: boolean;
  /** 差价编辑器初始值（编辑回显——billingConfig 不走 RHF 字段） */
  initialBillingConfig?: { params?: { selector?: string; prices?: Record<string, string> } };
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const locale = useLocale() as 'en' | 'zh';
  // 计价方式优先：未选择时隐藏全部价格输入；token 显三价+缓存写价；单位模式（图片/视频/语音/按次）显单位单价+可选差价。
  // useWatch（而非 form.watch）确保 Controller 外的订阅重渲染稳定。
  const pricingUnit: string = useWatch({ control: form.control, name: 'pricingUnit' }) ?? '';
  const chosen = pricingUnit !== '';
  const unitMode = chosen && pricingUnit !== 'token';
  // 差价档位编辑器（variant 策略）：直接勾选预设档位（1K/2K/720p…）出价格框；selector=取价参数名。
  // 切换计价方式时档位按新单位重建（已填价格不跨单位保留）。
  const initialConfig = initialBillingConfig;
  const [selector, setSelector] = useState<string>(initialConfig?.params?.selector ?? 'size');
  const [tiers, setTiers] = useState<TierRow[]>(() =>
    buildTiers(form.getValues('pricingUnit') ?? '', initialConfig),
  );
  return (
    <form
      id={formId}
      onSubmit={form.handleSubmit((values: any) => {
        // 差价档位 → variant billingConfig：勾选且填写完整的档位进价格表（预扣取最高价由计费域保证）
        const enabled = tiers.filter((tr) => tr.on);
        const active = enabled.filter((tr) => tr.value.trim() !== '' && tr.price.trim() !== '');
        if (unitMode && active.length !== enabled.length) {
          form.setError('root', {
            type: 'manual',
            message: t('tiersFillError'),
          });
          return;
        }
        onSubmit({
          ...values,
          ...(unitMode && active.length > 0
            ? {
                billingConfig: {
                  strategy: 'variant',
                  params: {
                    selector: selector.trim() || 'size',
                    prices: Object.fromEntries(
                      active.map((tr) => [tr.value.trim(), tr.price.trim()]),
                    ),
                  },
                },
              }
            : {}),
        });
      })}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto"
    >
      <FieldGroup>
        <div className="grid grid-cols-2 gap-3">
          <Controller
            control={form.control}
            name="externalName"
            render={({
              field,
              fieldState,
            }: {
              field: { value: string };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-ext">{t('externalName')}</FieldLabel>
                <Input id="m-ext" placeholder={t('externalNamePlaceholder')} {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="realModel"
            render={({
              field,
              fieldState,
            }: {
              field: { value: string };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-real">{t('realModel')}</FieldLabel>
                <Input id="m-real" placeholder={t('realModelPlaceholder')} {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </div>
        {/* 计价方式：决定下方出现哪些价格输入（未选择时价格区整体隐藏）；切换时差价档位按新单位重建 */}
        <Controller
          control={form.control}
          name="pricingUnit"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="m-unit">{t('pricingMethod')}</FieldLabel>
              <select
                id="m-unit"
                value={field.value}
                onChange={(e) => {
                  field.onChange(e);
                  setTiers(buildTiers(e.target.value, undefined));
                }}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="" disabled>
                  {t('selectUnitPrompt')}
                </option>
                {pricingUnitOptions(t).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        {!chosen ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
            {t('chooseUnitHint')}
          </p>
        ) : null}
        {pricingUnit === 'token' ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumberField
              control={form.control}
              name="inputPrice"
              label={t('inputPrice')}
              id="m-in"
              step="0.0001"
            />
            <NumberField
              control={form.control}
              name="outputPrice"
              label={t('outputPrice')}
              id="m-out"
              step="0.0001"
            />
            <NumberField
              control={form.control}
              name="cacheInputPrice"
              label={t('cachePrice')}
              id="m-cache"
              step="0.0001"
            />
            <NumberField
              control={form.control}
              name="cacheWritePrice"
              label={t('cacheWritePrice')}
              id="m-cache-w"
              step="0.0001"
            />
          </div>
        ) : null}
        {unitMode ? (
          <NumberField
            control={form.control}
            name="unitPrice"
            label={t('unitPriceLabel', { unit: unitWord(pricingUnit, locale) })}
            id="m-unit-price"
            step="0.0001"
          />
        ) : null}
        {unitMode && tiers.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{t('tiersTitle')}</p>
            <div className="grid gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="m-selector">
                {t('selectorLabel')}
              </label>
              <Input
                id="m-selector"
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
                placeholder="size"
                className="h-8"
              />
            </div>
            {tiers.map((tier, i) => {
              const patch = (next: Partial<TierRow>) =>
                setTiers((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
              return (
                <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
                  {tier.custom ? (
                    <>
                      <span className="text-xs text-muted-foreground">{t('customTier')}</span>
                      <Input
                        value={tier.value}
                        onChange={(e) => patch({ value: e.target.value, label: e.target.value })}
                        placeholder={t('paramValuePlaceholder')}
                        className="h-8"
                      />
                    </>
                  ) : (
                    <>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={tier.on}
                          onCheckedChange={(v) => {
                            patch({ on: v === true });
                            form.clearErrors('root');
                          }}
                        />
                        {tier.label}
                      </label>
                      {tier.on ? (
                        <Input
                          value={tier.value}
                          onChange={(e) => patch({ value: e.target.value })}
                          title={t('tierValueTitle')}
                          className="h-8"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{tier.value}</span>
                      )}
                    </>
                  )}
                  {tier.custom || tier.on ? (
                    <Input
                      value={tier.price}
                      onChange={(e) => patch({ price: e.target.value })}
                      placeholder={t('unitPricePlaceholder')}
                      className="h-8"
                      inputMode="decimal"
                    />
                  ) : (
                    <span />
                  )}
                  {tier.custom ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setTiers((cur) => cur.filter((_, j) => j !== i))}
                    >
                      {tc('remove')}
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setTiers((cur) => [
                  ...cur,
                  { label: '', value: '', price: '', on: true, custom: true },
                ])
              }
            >
              {t('addTier')}
            </Button>
            {form.formState.errors.root ? (
              <p className="text-sm text-destructive">
                {(form.formState.errors.root as { message?: string }).message ??
                  t('tiersIncomplete')}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('tiersHint')}</p>
          </div>
        ) : null}
        <NumberField
          control={form.control}
          name="contextLength"
          label={t('contextLabel')}
          id="m-ctx"
          step="1"
        />
        {chosen ? (
          <p className="text-xs text-muted-foreground">
            {unitMode
              ? t('unitModeHint', { unit: unitWord(pricingUnit, locale) })
              : t('tokenModeHint')}
          </p>
        ) : null}
        <Controller
          control={form.control}
          name="isFree"
          render={({ field }: { field: { value?: boolean; onChange: (v: boolean) => void } }) => (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.value ?? false}
                onCheckedChange={(v) => field.onChange(v === true)}
              />
              {t('isFreeLabel')}
            </label>
          )}
        />
        {isEdit && (
          <Collapsible className="rounded-md border p-3">
            <CollapsibleTrigger
              render={
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                  {t('advanced')}
                </Button>
              }
            />
            <CollapsibleContent className="space-y-4 pt-3">
              <Controller
                control={form.control}
                name="fallbackModels"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-fb">{t('fallbackLabel')}</FieldLabel>
                    <Input id="m-fb" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="paramRules"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-rules">{t('paramRulesLabel')}</FieldLabel>
                    <Textarea id="m-rules" rows={3} className="font-mono text-xs" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="billingPolicy"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-billing-policy">{t('billingPolicyLabel')}</FieldLabel>
                    <Textarea
                      id="m-billing-policy"
                      rows={8}
                      className="font-mono text-xs"
                      placeholder={
                        '{"version":1,"billingMode":"unified_input_tokens","maxInputTokens":128000,"modalities":{"image":{"maxItems":20,"maxInlineBytes":20971520}}}'
                      }
                      {...field}
                    />
                  </Field>
                )}
              />
              <div className="grid grid-cols-3 gap-3">
                <Controller
                  control={form.control}
                  name="rpmLimit"
                  render={({ field }: { field: { value: string } }) => (
                    <Field>
                      <FieldLabel htmlFor="m-rpm">{t('rpm')}</FieldLabel>
                      <Input id="m-rpm" type="number" {...field} />
                    </Field>
                  )}
                />
                <Controller
                  control={form.control}
                  name="tpmLimit"
                  render={({ field }: { field: { value: string } }) => (
                    <Field>
                      <FieldLabel htmlFor="m-tpm">{t('tpm')}</FieldLabel>
                      <Input id="m-tpm" type="number" {...field} />
                    </Field>
                  )}
                />
                <NumberField
                  control={form.control}
                  name="status"
                  label={tc('status')}
                  id="m-status"
                  step="1"
                  min={0}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </FieldGroup>
    </form>
  );
}

function BindChannelsDialog({
  model,
  channels,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  const t = useTranslations('models');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<number[]>(model.channelIds ?? []);

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function onSubmit() {
    startTransition(async () => {
      const { bindChannelsAction } = await import('@/server/models-actions');
      const res = await bindChannelsAction(model.id, selected);
      if (!notify(res, t('bindFailed'), t('channelsBound', { count: selected.length }))) return;
      setSelected([]);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // 每次打开回显当前已绑定渠道（取消后再打开也重置为最新绑定）
        if (o) setSelected(model.channelIds ?? []);
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm" variant="ghost" title={t('bindChannels')}>
            <NetworkIcon />
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> {t('bindTitle', { name: model.externalName })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('noChannels')}</p>
          ) : (
            channels.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border p-2 hover:bg-muted/50"
              >
                <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
                <div className="flex-1">
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.providerName}</p>
                </div>
                <span className="text-xs text-muted-foreground">#{c.id}</span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmBind', { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 模型级测试：逐绑定渠道真实最小生成（"1" + max_tokens 1，厘级成本） */
export function TestModelDialog({ model }: { model: AdminModelRow }) {
  const t = useTranslations('models');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<ModelTestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setResults(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            title={t('testTitle')}
            onClick={() => {
              setResults(null);
              setError(null);
              startTransition(async () => {
                const { testModelAction } = await import('@/server/models-actions');
                const res = await testModelAction(model.id);
                if (res.error) setError(res.error);
                else setResults(res.results ?? []);
              });
            }}
          >
            <FlaskConicalIcon />
          </Button>
        }
      />
      <DialogContent className="w-[32rem] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>{t('testDialogTitle', { name: model.externalName })}</DialogTitle>
          <DialogDescription>{t('testDescription')}</DialogDescription>
        </DialogHeader>
        {pending ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2Icon className="mr-2 animate-spin" /> {t('testing')}
          </div>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : results ? (
          results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('noBoundChannels')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {results.map((r) => (
                <li
                  key={r.channelId}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{r.channel}</span>
                  {r.ok ? (
                    <span className="text-emerald-600">
                      ✓ {r.durationMs}ms · {r.tokens ?? 0} tokens
                    </span>
                  ) : (
                    <span className="max-w-56 truncate text-destructive" title={r.error?.message}>
                      ✗ {r.error?.code ?? 'error'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
