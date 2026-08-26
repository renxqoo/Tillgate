'use client';

// 创建模型弹窗（编辑弹窗在 edit-model-dialog，共享表单体在 model-form）

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { CpuIcon, Loader2Icon, PlusCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import { useActionResult } from '@/components/action-toast';
import { ModelForm, type ModelFormValues, type WithBillingConfig } from './model-form';
import { PRICING_UNITS, FREE_MODEL_PRICES, refinePricing, type PricingUnit } from './model-pricing';

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
        // 免费模型：五价显式归零（价格输入已禁用免填）；其余只提交当前计价方式下的价格：
        // token 三价 / 单位单价（另一侧字段对 API 无意义，补 0 占位）
        ...(values.isFree
          ? FREE_MODEL_PRICES
          : tokenMode
            ? {
                inputPrice: values.inputPrice,
                outputPrice: values.outputPrice,
                cacheInputPrice: values.cacheInputPrice,
                ...(values.cacheWritePrice !== ''
                  ? { cacheWritePrice: values.cacheWritePrice }
                  : {}),
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
        <ModelForm
          form={form as unknown as UseFormReturn<ModelFormValues>}
          onSubmit={onSubmit}
          formId="model-form"
        />
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
