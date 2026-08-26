'use client';

// 编辑模型弹窗（受控 open，由模型行操作打开）：编辑 schema / 默认值 / 提交载荷构造同居本文件

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useState, useTransition, type ReactElement } from 'react';

import { Loader2Icon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import type { AdminModelRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { numericText } from '@/lib/forms';
import { ModelForm, type WithBillingConfig } from './model-form';
import { PRICING_UNITS, refinePricing, type PricingUnit } from './model-pricing';

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

/** 编辑表单值类型（zod schema 输入侧） */
type EditFormValues = z.input<ReturnType<typeof buildEditSchema>>;

/** 编辑表单默认值：DB 行 → 字符串形态（空值归一为 ''，JSON 策略美化回显） */
function buildEditDefaultValues(model: AdminModelRow) {
  return {
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
  };
}

/** 编辑提交载荷：表单字符串值 → API 载荷（价格按计价方式分流、空值归 null/undefined、billingConfig 显式清除） */
function toEditPayload(values: WithBillingConfig<EditFormValues>) {
  const tokenMode = values.pricingUnit === 'token';
  return {
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
  };
}

export function EditModelDialog({
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
  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: buildEditDefaultValues(model),
  });

  function onSubmit(values: WithBillingConfig<EditFormValues>) {
    startTransition(async () => {
      const { updateModelAction } = await import('@/server/models-actions');
      const res = await updateModelAction(model.id, toEditPayload(values));
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
