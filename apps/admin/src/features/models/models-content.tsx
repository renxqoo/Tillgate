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
  DropdownMenuItem,
  DropdownMenuSeparator,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@tokenlens/ui';
import { NumberField } from '@/components/number-field';
import { useEffect, useState, useTransition, type ReactElement } from 'react';

import {
  ArrowDownIcon,
  CoinsIcon,
  CpuIcon,
  FilmIcon,
  FlaskConicalIcon,
  HashIcon,
  ImageIcon,
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
  RotateCcwIcon,
  TypeIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import type { ModelTestResult } from '@/server/models-actions';
import { numericText } from '@/lib/forms';
import { fmtPrice, fmtDateTime, unitWord } from '@/lib/formatters';

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

/** 计价方式卡片（直接点选，不走下拉）：name=卡片标题，desc=卡片说明，文案走 models 目录 */
function pricingUnitOptions(
  t: ReturnType<typeof useTranslations<'models'>>,
): ReadonlyArray<{ value: PricingUnit; name: string; desc: string; icon: typeof CoinsIcon }> {
  return [
    { value: 'token', name: t('unitTokenName'), desc: t('unitTokenDesc'), icon: CoinsIcon },
    { value: 'image', name: t('unitImageName'), desc: t('unitImageDesc'), icon: ImageIcon },
    { value: 'second', name: t('unitSecondName'), desc: t('unitSecondDesc'), icon: FilmIcon },
    { value: 'char', name: t('unitCharName'), desc: t('unitCharDesc'), icon: TypeIcon },
    { value: 'request', name: t('unitRequestName'), desc: t('unitRequestDesc'), icon: HashIcon },
  ];
}

/** 差价档位（勾选制）：label=界面档位名，value=固定参数值（与请求参数完全一致，不可改，杜绝手输错值） */
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

/** 取价参数名候选（按计价方式给出常用请求体字段，直接选择而非手输；支持 "size:quality" 组合键） */
const SELECTOR_OPTIONS: Partial<Record<PricingUnit, ReadonlyArray<string>>> = {
  image: ['size', 'quality', 'size:quality', 'model'],
  second: ['resolution', 'quality', 'model'],
  char: ['model', 'voice'],
  request: ['model'],
};

/** 各计价方式默认取价参数名（切换计价方式时重置；编辑回显优先用存量值） */
const DEFAULT_SELECTOR: Partial<Record<PricingUnit, string>> = {
  image: 'size',
  second: 'resolution',
  char: 'model',
  request: 'model',
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

/** 列表用：billingConfig 档位价升序（无 / token 计价 → 空数组） */
function tierPricesOf(
  model: Pick<AdminModelRow, 'pricingUnit' | 'billingConfig'>,
): Array<{ value: string; price: string }> {
  const prices = model.billingConfig?.params?.prices;
  if (!prices || !model.pricingUnit || model.pricingUnit === 'token') return [];
  return Object.entries(prices)
    .map(([value, price]) => ({ value, price: String(price) }))
    .toSorted((a, b) => Number(a.price) - Number(b.price));
}

/** 档位展示名：预设参数值归位到档位名（1024*1024 → 1K），其余显示原值 */
function tierLabelFor(unit: string, value: string): string {
  const preset = (TIER_PRESETS[unit as PricingUnit] ?? []).find((p) => p.value === value);
  return preset?.label ?? value;
}

/** 分时段窗口行（schedule 策略编辑态）：start/end = HH:MM，价格字段空串 = 不覆盖该轴 */
type WindowRow = {
  label: string;
  start: string;
  end: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
};

const EMPTY_WINDOW_ROW: WindowRow = {
  label: '',
  start: '18:00',
  end: '07:00',
  inputPrice: '',
  outputPrice: '',
  cacheInputPrice: '',
  unitPrice: '',
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** billingConfig 回显 → 窗口行（schedule 之外 / 空表 → 空数组） */
function buildWindows(cfg?: {
  strategy?: string;
  params?: { windows?: Array<Record<string, string>> };
}): WindowRow[] {
  if (cfg?.strategy !== 'schedule') return [];
  return (cfg.params?.windows ?? []).map((w) => ({
    label: w.label ?? '',
    start: w.start ?? '',
    end: w.end ?? '',
    inputPrice: w.inputPrice ?? '',
    outputPrice: w.outputPrice ?? '',
    cacheInputPrice: w.cacheInputPrice ?? '',
    unitPrice: w.unitPrice ?? '',
  }));
}

/** 窗口行有效性（形状面）：HH:MM、start ≠ end、至少一个价格字段——重叠/数值域由服务端把关 */
function windowRowInvalid(row: WindowRow): boolean {
  const prices = [row.inputPrice, row.outputPrice, row.cacheInputPrice, row.unitPrice];
  const hasPrice = prices.some((p) => p.trim() !== '');
  return !HHMM_RE.test(row.start) || !HHMM_RE.test(row.end) || row.start === row.end || !hasPrice;
}

/** 窗口行 → 提交形状：空串字段剔除（字段级覆盖——未覆盖轴回落基价列） */
const trimToPayload = (v: string) => (v.trim() === '' ? undefined : v.trim());

function toWindowPayload(row: WindowRow) {
  const pick = (v: string) => trimToPayload(v);
  return {
    ...(pick(row.label) !== undefined ? { label: pick(row.label) } : {}),
    start: row.start,
    end: row.end,
    ...(pick(row.inputPrice) !== undefined ? { inputPrice: pick(row.inputPrice) } : {}),
    ...(pick(row.outputPrice) !== undefined ? { outputPrice: pick(row.outputPrice) } : {}),
    ...(pick(row.cacheInputPrice) !== undefined
      ? { cacheInputPrice: pick(row.cacheInputPrice) }
      : {}),
    ...(pick(row.unitPrice) !== undefined ? { unitPrice: pick(row.unitPrice) } : {}),
  };
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
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
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

/**
 * 列表「输出价」列（单位计价）：有差价档位时显示最低价（起），
 * hover 悬浮展示全部档位价（预设档位名 + 参数值）与统一单价回落。
 */
function UnitPriceCell({ model, locale }: { model: AdminModelRow; locale: 'en' | 'zh' }) {
  const t = useTranslations('models');
  const unit = model.pricingUnit ?? 'request';
  const word = unitWord(unit, locale);
  const tiers = tierPricesOf(model);
  const flat = model.unitPrice ?? '';
  // 展示最低价：档位价与统一单价一起取最小（未命中档位的请求按统一单价计费）
  const candidates = [...tiers.map((x) => x.price), ...(flat !== '' ? [flat] : [])];
  const min = candidates.reduce<string | null>(
    (acc, p) => (acc === null || Number(p) < Number(acc) ? p : acc),
    null,
  );
  if (min === null) return <span>¥0/{word}</span>;
  if (candidates.length < 2)
    return (
      <span>
        ¥{fmtPrice(min)}/{word}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {t('listFromPrice', { min: fmtPrice(min), unit: word })}
          </span>
        }
      />
      <TooltipContent side="top" className="flex-col items-stretch gap-1 px-3 py-2 text-left">
        <p className="font-medium">{t('tiersTitle')}</p>
        {model.billingConfig?.params?.selector ? (
          <p className="opacity-70">
            {t('listSelectorLine', { selector: model.billingConfig.params.selector })}
          </p>
        ) : null}
        {tiers.map((tr) => {
          const label = tierLabelFor(unit, tr.value);
          return (
            <div key={tr.value} className="flex justify-between gap-6">
              <span>{label === tr.value ? tr.value : `${label} · ${tr.value}`}</span>
              <span>
                ¥{fmtPrice(tr.price)}/{word}
              </span>
            </div>
          );
        })}
        {flat !== '' ? (
          <div className="flex justify-between gap-6 border-t border-background/20 pt-1 opacity-70">
            <span>{t('tierFlatHint')}</span>
            <span>
              ¥{fmtPrice(flat)}/{word}
            </span>
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
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
  const [dialog, setDialog] = useState<
    'bind' | 'edit' | 'test' | 'delist' | 'restore' | 'delete' | 'undelete' | null
  >(null);
  // 回收站行（deletedAt 非空）：只读——仅「恢复记录」，其余动作不可达
  const deleted = model.deletedAt != null;
  return (
    <TableRow className={deleted ? 'opacity-60' : undefined}>
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
          <UnitPriceCell model={model} locale={locale} />
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
        {deleted ? (
          <div className="flex flex-col">
            <StatusPill tone="danger" label={t('deleted')} />
            <span className="mt-0.5 text-[10px] text-muted-foreground">
              {fmtDateTime(model.deletedAt!)}
            </span>
          </div>
        ) : model.status === 0 ? (
          <StatusPill tone="success" label={tc('enabled')} />
        ) : (
          <StatusPill tone="neutral" label={t('delisted')} />
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtContext(model.contextLength)}</TableCell>
      <TableCell className="w-16 text-center">
        <RowActions label={tc('actions')}>
          {deleted ? (
            <DropdownMenuItem onClick={() => setDialog('undelete')}>
              <RotateCcwIcon className="size-4" /> {t('undelete')}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={() => setDialog('bind')}>
                <NetworkIcon /> {t('bindChannels')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog('edit')}>
                <PencilIcon /> {tc('edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog('test')}>
                <FlaskConicalIcon /> {t('test')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {model.status === 0 ? (
                <DropdownMenuItem onClick={() => setDialog('delist')}>
                  <ArrowDownIcon className="size-4" /> {t('delist')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setDialog('restore')}>
                  <RotateCcwIcon className="size-4" /> {t('restore')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => setDialog('delete')}>
                <Trash2Icon /> {t('delete')}
              </DropdownMenuItem>
            </>
          )}
        </RowActions>
        {/* 确认弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
        {deleted ? (
          <ConfirmAction
            open={dialog === 'undelete'}
            onOpenChange={(open) => !open && setDialog(null)}
            confirm={t('undeleteConfirm', { name: model.externalName })}
            action={async () =>
              (await import('@/server/models-actions')).undeleteModelAction(model.id)
            }
            success={t('undeleteSuccess')}
            tone="default"
          />
        ) : (
          <>
            {model.status === 0 ? (
              <ConfirmAction
                open={dialog === 'delist'}
                onOpenChange={(open) => !open && setDialog(null)}
                confirm={t('delistConfirm', { name: model.externalName })}
                action={async () =>
                  (await import('@/server/models-actions')).delistModelAction(model.id)
                }
                success={t('delistSuccess')}
                tone="default"
              />
            ) : (
              <ConfirmAction
                open={dialog === 'restore'}
                onOpenChange={(open) => !open && setDialog(null)}
                confirm={t('restoreConfirm', { name: model.externalName })}
                action={async () =>
                  (await import('@/server/models-actions')).restoreModelAction(model.id)
                }
                success={t('restoreSuccess')}
                tone="default"
              />
            )}
            <ConfirmAction
              open={dialog === 'delete'}
              onOpenChange={(open) => !open && setDialog(null)}
              confirm={t('deleteConfirm', { name: model.externalName })}
              action={async () =>
                (await import('@/server/models-actions')).deleteModelAction(model.id)
              }
              success={t('deleteSuccess')}
            />
            <BindChannelsDialog
              model={model}
              channels={channels}
              trigger={null}
              open={dialog === 'bind'}
              onOpenChange={(open) => !open && setDialog(null)}
            />
            <EditModelDialog
              model={model}
              trigger={null}
              open={dialog === 'edit'}
              onOpenChange={(open) => !open && setDialog(null)}
            />
            <TestModelDialog
              model={model}
              trigger={null}
              open={dialog === 'test'}
              onOpenChange={(open) => !open && setDialog(null)}
            />
          </>
        )}
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
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
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
    params?: {
      selector?: string;
      prices?: Record<string, string>;
      windows?: Array<{
        label?: string;
        start: string;
        end: string;
        inputPrice?: string;
        outputPrice?: string;
        cacheInputPrice?: string;
        cacheWritePrice?: string;
        unitPrice?: string;
      }>;
    };
  };
};

function EditModelDialog({
  model,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  model: AdminModelRow;
  trigger?: ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
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
        // 差价/时段配置显式管理：表单带 billingConfig 提交（variant 或 schedule），
        // 否则 null 清除（避免 DB 残留与界面不一致）——token 模式也可配分时段价
        ...(values.billingConfig == null
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
      setInternalOpen(false);
      onOpenChange?.(false);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={tc('edit')}>
                <PencilIcon />
                {tc('edit')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
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
  /** 差价/时段编辑器初始值（编辑回显——billingConfig 不走 RHF 字段） */
  initialBillingConfig?: {
    strategy?: string;
    params?: {
      selector?: string;
      prices?: Record<string, string>;
      windows?: Array<Record<string, string>>;
    };
  };
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const locale = useLocale() as 'en' | 'zh';
  // 计价方式优先：未选择时隐藏全部价格输入；token 显三价+缓存写价；单位模式（图片/视频/语音/按次）显单位单价+可选差价。
  // useWatch（而非 form.watch）确保 Controller 外的订阅重渲染稳定。
  const pricingUnit: string = useWatch({ control: form.control, name: 'pricingUnit' }) ?? '';
  const chosen = pricingUnit !== '';
  const unitMode = chosen && pricingUnit !== 'token';
  // 差价档位编辑器（variant 策略）：直接勾选预设档位（1K/2K/720p…）只填单价，参数值固定不可改；selector=取价参数名（下拉直选）。
  // 切换计价方式时档位按新单位重建（已填价格不跨单位保留），selector 重置为新单位默认值。
  const initialConfig = initialBillingConfig;
  const [selector, setSelector] = useState<string>(
    initialConfig?.params?.selector ??
      DEFAULT_SELECTOR[form.getValues('pricingUnit') as PricingUnit] ??
      'model',
  );
  const [tiers, setTiers] = useState<TierRow[]>(() =>
    buildTiers(form.getValues('pricingUnit') ?? '', initialConfig),
  );
  // 分时段编辑器（schedule 策略）：与参数差价互斥（billingConfig.strategy 单值）；
  // 时段价覆盖全部计价方式（token 三元组 / 单位单价），未覆盖轴回落基价列。
  const [scheduleOn, setScheduleOn] = useState(initialConfig?.strategy === 'schedule');
  const [windows, setWindows] = useState<WindowRow[]>(() => buildWindows(initialConfig));
  return (
    <form
      id={formId}
      onSubmit={form.handleSubmit((values: any) => {
        // 分时段（schedule）优先于参数差价（strategy 单值互斥）：启用即按窗口表提交
        if (scheduleOn) {
          if (windows.length === 0 || windows.some((w) => windowRowInvalid(w))) {
            form.setError('root', { type: 'manual', message: t('windowsFillError') });
            return;
          }
          onSubmit({
            ...values,
            billingConfig: {
              strategy: 'schedule',
              params: { windows: windows.map(toWindowPayload) },
            },
          });
          return;
        }
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
                    selector:
                      selector.trim() || DEFAULT_SELECTOR[pricingUnit as PricingUnit] || 'model',
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
        {/* 计价方式：卡片直选（决定下方出现哪些价格输入）；切换时差价档位按新单位重建、selector 重置为新单位默认值 */}
        <Controller
          control={form.control}
          name="pricingUnit"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel>{t('pricingMethod')}</FieldLabel>
              <div
                role="radiogroup"
                aria-label={t('pricingMethod')}
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              >
                {pricingUnitOptions(t).map((o) => {
                  const selected = field.value === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        if (selected) return;
                        field.onChange(o.value);
                        form.clearErrors('pricingUnit');
                        setTiers(buildTiers(o.value, undefined));
                        setSelector(DEFAULT_SELECTOR[o.value] ?? 'model');
                      }}
                      className={cn(
                        'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                        selected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-input hover:bg-muted/50',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <o.icon className="size-4 text-muted-foreground" />
                        {o.name}
                      </span>
                      <span className="text-xs text-muted-foreground">{o.desc}</span>
                    </button>
                  );
                })}
              </div>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
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
        {/* 分时段定价（schedule）：全部计价方式可用；启用时与参数差价互斥（strategy 单值） */}
        {chosen ? (
          <div className="space-y-3 rounded-md border p-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={scheduleOn}
                onCheckedChange={(v) => {
                  setScheduleOn(v === true);
                  form.clearErrors('root');
                }}
              />
              {t('scheduleTitle')}
            </label>
            <p className="text-xs text-muted-foreground">{t('scheduleHint')}</p>
            {scheduleOn ? (
              <div className="space-y-1.5">
                {windows.map((row, i) => {
                  const patch = (next: Partial<WindowRow>) =>
                    setWindows((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
                  return (
                    <div key={i} className="space-y-2 rounded-md border border-input p-2.5">
                      <div className="flex items-center gap-2">
                        <Input
                          value={row.label}
                          onChange={(e) => patch({ label: e.target.value })}
                          placeholder={t('windowLabelPlaceholder')}
                          className="h-8 w-32"
                        />
                        <Input
                          value={row.start}
                          onChange={(e) => patch({ start: e.target.value })}
                          placeholder="18:00"
                          className="h-8 w-24 font-mono"
                          inputMode="numeric"
                        />
                        <span className="text-xs text-muted-foreground">→</span>
                        <Input
                          value={row.end}
                          onChange={(e) => patch({ end: e.target.value })}
                          placeholder="07:00"
                          className="h-8 w-24 font-mono"
                          inputMode="numeric"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="ml-auto px-2 text-destructive hover:text-destructive"
                          onClick={() => setWindows((cur) => cur.filter((_, j) => j !== i))}
                        >
                          {tc('remove')}
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {unitMode ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={row.unitPrice}
                              onChange={(e) => patch({ unitPrice: e.target.value })}
                              placeholder={t('unitPricePlaceholder')}
                              className="h-8 w-36"
                              inputMode="decimal"
                            />
                            <span className="w-14 text-xs text-muted-foreground">
                              ¥/{unitWord(pricingUnit, locale)}
                            </span>
                          </div>
                        ) : (
                          <>
                            <Input
                              value={row.inputPrice}
                              onChange={(e) => patch({ inputPrice: e.target.value })}
                              placeholder={t('inputPrice')}
                              className="h-8 w-32"
                              inputMode="decimal"
                            />
                            <Input
                              value={row.outputPrice}
                              onChange={(e) => patch({ outputPrice: e.target.value })}
                              placeholder={t('outputPrice')}
                              className="h-8 w-32"
                              inputMode="decimal"
                            />
                            <Input
                              value={row.cacheInputPrice}
                              onChange={(e) => patch({ cacheInputPrice: e.target.value })}
                              placeholder={t('cachePrice')}
                              className="h-8 w-32"
                              inputMode="decimal"
                            />
                          </>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {t('windowPriceHint')}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setWindows((cur) => [...cur, { ...EMPTY_WINDOW_ROW }])}
                >
                  {t('addWindow')}
                </Button>
                {form.formState.errors.root ? (
                  <p className="text-sm text-destructive">
                    {(form.formState.errors.root as { message?: string }).message ??
                      t('windowsFillError')}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">{t('windowsHint')}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {/* 参数差价（variant）：仅单位计价；分时段启用时互斥隐藏 */}
        {unitMode && !scheduleOn ? (
          <div className="space-y-3 rounded-md border p-4">
            <div>
              <p className="text-sm font-medium">{t('tiersTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('tiersSubHint')}</p>
            </div>
            <div className="grid max-w-xs gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="m-selector">
                {t('selectorLabel')}
              </label>
              {/* 常用取价参数直选；存量 selector 不在候选内时追加为选项，编辑回显不丢值 */}
              <select
                id="m-selector"
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
              >
                {(() => {
                  const base = [...(SELECTOR_OPTIONS[pricingUnit as PricingUnit] ?? ['model'])];
                  if (selector && !base.includes(selector)) base.push(selector);
                  return base.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ));
                })()}
              </select>
            </div>
            {tiers.length > 0 ? (
              <div className="space-y-1.5">
                {tiers.map((tier, i) => {
                  const patch = (next: Partial<TierRow>) =>
                    setTiers((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
                  const rowOn = tier.custom || tier.on;
                  return (
                    <div
                      key={i}
                      className={cn(
                        'flex items-center gap-3 rounded-md border p-2.5',
                        rowOn ? 'border-primary/50 bg-primary/5' : 'border-input',
                      )}
                    >
                      {tier.custom ? (
                        <>
                          <span className="w-16 shrink-0 text-xs text-muted-foreground">
                            {t('customTier')}
                          </span>
                          <Input
                            value={tier.value}
                            onChange={(e) =>
                              patch({ value: e.target.value, label: e.target.value })
                            }
                            placeholder={t('paramValuePlaceholder')}
                            className="h-8 max-w-44"
                          />
                        </>
                      ) : (
                        <>
                          <label className="flex w-24 shrink-0 items-center gap-2 text-sm font-medium">
                            <Checkbox
                              checked={tier.on}
                              onCheckedChange={(v) => {
                                patch({ on: v === true });
                                form.clearErrors('root');
                              }}
                            />
                            {tier.label}
                          </label>
                          {/* 档位参数值固定不可改：勾选即按该值单独定价，杜绝手输错值 */}
                          <code
                            title={t('tierValueTitle')}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                          >
                            {tier.value}
                          </code>
                        </>
                      )}
                      {rowOn ? (
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          <Input
                            value={tier.price}
                            onChange={(e) => patch({ price: e.target.value })}
                            placeholder={t('unitPricePlaceholder')}
                            className="h-8 w-36"
                            inputMode="decimal"
                          />
                          <span className="w-14 text-xs text-muted-foreground">
                            ¥/{unitWord(pricingUnit, locale)}
                          </span>
                        </div>
                      ) : (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t('tierFlatHint')}
                        </span>
                      )}
                      {tier.custom ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="px-2 text-destructive hover:text-destructive"
                          onClick={() => setTiers((cur) => cur.filter((_, j) => j !== i))}
                        >
                          {tc('remove')}
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
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
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
  trigger?: ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('models');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
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
      setInternalOpen(false);
      onOpenChange?.(false);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
    // 每次打开回显当前已绑定渠道（取消后再打开也重置为最新绑定）
    if (next) setSelected(model.channelIds ?? []);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={t('bindChannels')}>
                <NetworkIcon />
                {t('bindChannels')}
              </Button>
            )
          }
        />
      ) : null}
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
export function TestModelDialog({
  model,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  model: AdminModelRow;
  trigger?: ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('models');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [results, setResults] = useState<ModelTestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startTest() {
    setResults(null);
    setError(null);
    startTransition(async () => {
      const { testModelAction } = await import('@/server/models-actions');
      const res = await testModelAction(model.id);
      if (res.error) setError(res.error);
      else setResults(res.results ?? []);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
    if (next) {
      if (controlledOpen === undefined) startTest();
    } else {
      setResults(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (controlledOpen) startTest();
    // 受控菜单从关闭切到打开时执行一次真实测试；model.id 变化时也必须刷新结果。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledOpen, model.id]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={t('testTitle')}>
                <FlaskConicalIcon />
                {t('test')}
              </Button>
            )
          }
        />
      ) : null}
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
