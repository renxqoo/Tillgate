'use client';

import { useState } from 'react';

import {
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
  UploadIcon,
  WifiIcon,
} from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { formatMoney } from '@ai-gateway/api-client/formatters';

import { useActionResult } from '@ai-gateway/ui/components/action-toast';
import { ConfirmAction } from '@ai-gateway/ui/components/confirm-action';
import { FormDialog } from '@ai-gateway/ui/components/form-dialog';
import { defineStatusMeta, StatusPill } from '@ai-gateway/ui/components/status-pill';
import { Button } from '@ai-gateway/ui/components/ui/button';
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
import { Textarea } from '@ai-gateway/ui/components/ui/textarea';
import { numericText } from '@ai-gateway/ui/lib/forms';

import type { AdminChannelRow, ProviderOption } from '@ai-gateway/api-client/types';

const STATUS_META = defineStatusMeta({
  0: { label: '启用', tone: 'success' },
  1: { label: '降级', tone: 'warning' },
  2: { label: '禁用', tone: 'neutral' },
  3: { label: '冷却', tone: 'warning' },
});

export function ChannelsTable({
  channels,
  providers,
}: {
  readonly channels: ReadonlyArray<AdminChannelRow>;
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>供应商</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead>模型</TableHead>
          <TableHead className="text-right">权重 / 优先级</TableHead>
          <TableHead className="text-right">额度</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">失败次数</TableHead>
          <TableHead className="w-64 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              暂无渠道
            </TableCell>
          </TableRow>
        ) : (
          channels.map((c) => <ChannelRowItem key={c.id} channel={c} providers={providers} />)
        )}
      </TableBody>
    </Table>
  );
}

function ChannelRowItem({
  channel,
  providers,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const [testing, setTesting] = useState(false);
  const meta = STATUS_META.get(channel.status);

  return (
    <TableRow>
      <TableCell className="font-medium">{channel.name}</TableCell>
      <TableCell className="text-muted-foreground">{channel.providerName}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {channel.baseUrlOverride ?? channel.providerBaseUrl}
        </code>
      </TableCell>
      <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
        {channel.boundModels && channel.boundModels.length > 0
          ? channel.boundModels.map((m) => m.externalName).join(', ')
          : '—'}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {channel.weight} / {channel.priority}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-medium">{formatMoney(channel.upstreamBudget)}</span>
      </TableCell>
      <TableCell>
        <StatusPill dot tone={meta.tone} label={meta.label}>
          {channel.cooldownUntil ? (
            <span className="text-muted-foreground" title={channel.cooldownUntil}>
              （冷却中）
            </span>
          ) : null}
        </StatusPill>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {channel.failCount}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              const { testChannelAction } = await import('../actions');
              const res = await testChannelAction(channel.id);
              setTesting(false);
              if (res.error) toast.error(String(res.error));
              else toast.success(`连通 ${res.durationMs ?? 0}ms`);
            }}
          >
            {testing ? <Loader2Icon className="animate-spin" /> : <WifiIcon />}
            测试
          </Button>
          <EditChannelDialog channel={channel} providers={providers} />
          <ConfirmAction
            confirm={`确定删除渠道 ${channel.name}？`}
            action={async () => (await import('../actions')).deleteChannelAction(channel.id)}
            success="已删除"
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

const createSchema = z.object({
  providerId: z.coerce.number().min(1, '请选择供应商'),
  name: z.string().min(1, '请输入名称'),
  apiKey: z.string().min(1, '请输入 API Key'),
  baseUrlOverride: z.string().optional(),
  models: z.string().optional(),
  weight: numericText({ message: '请输入整数' })
    .refine((v) => Number.isInteger(v), '请输入整数')
    .refine((v) => v >= 1 && v <= 1000, '权重范围 1-1000'),
  priority: numericText({ message: '请输入整数' })
    .refine((v) => Number.isInteger(v), '请输入整数')
    .refine((v) => v >= 0, '优先级不能为负'),
});

export function CreateChannelDialog({
  providers,
}: {
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const notify = useActionResult();

  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      providerId: providers[0]?.id ?? 0,
      name: '',
      apiKey: '',
      baseUrlOverride: '',
      models: '',
      weight: '100',
      priority: '0',
    },
  });

  return (
    <FormDialog
      trigger={
        <Button>
          <PlusCircleIcon />
          新建渠道
        </Button>
      }
      title={
        <>
          <NetworkIcon /> 新建渠道
        </>
      }
      titleClassName="flex items-center gap-2"
      description="添加一条 LLM 供应商渠道"
      submitLabel="创建"
      formId="channel-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { createChannelAction } = await import('../actions');
              const res = await createChannelAction({
                ...values,
                providerId: Number(values.providerId),
                weight: Number(values.weight),
                priority: Number(values.priority),
              });
              if (!notify(res, '创建失败', '已创建渠道')) return false;
              form.reset();
              return true;
            })
          }
          formId="channel-form"
          providers={providers}
        />
      )}
    </FormDialog>
  );
}

function EditChannelDialog({
  channel,
  providers,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const notify = useActionResult();

  const editSchema = z.object({
    name: z.string().min(1, '请输入名称'),
    apiKey: z.string().optional(),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: '请输入整数' })
      .refine((v) => Number.isInteger(v), '请输入整数')
      .refine((v) => v >= 1 && v <= 1000, '权重范围 1-1000'),
    priority: numericText({ message: '请输入整数' })
      .refine((v) => Number.isInteger(v), '请输入整数')
      .refine((v) => v >= 0, '优先级不能为负'),
    status: z.coerce.number().int(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
    upstreamThreshold: z.string().optional(),
  });
  type FormValues = z.input<typeof editSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: channel.name,
      apiKey: '',
      baseUrlOverride: channel.baseUrlOverride ?? '',
      models: channel.models ?? '',
      weight: String(channel.weight),
      priority: String(channel.priority),
      status: channel.status,
      rpmLimit: channel.rpmLimit === null ? '' : String(channel.rpmLimit),
      tpmLimit: channel.tpmLimit === null ? '' : String(channel.tpmLimit),
      upstreamThreshold:
        channel.upstreamThreshold === null ? '' : String(channel.upstreamThreshold),
    },
  });

  return (
    <FormDialog
      trigger={
        <Button size="sm" variant="ghost" title="编辑">
          <PencilIcon />
        </Button>
      }
      title={
        <>
          <PencilIcon /> 编辑渠道 - {channel.name}
        </>
      }
      titleClassName="flex items-center gap-2"
      description="留空 API Key 表示不修改"
      submitLabel="保存"
      formId="channel-edit-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form as never}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { updateChannelAction } = await import('../actions');
              const res = await updateChannelAction(channel.id, {
                name: values.name,
                apiKey: values.apiKey?.trim() || undefined,
                baseUrlOverride: values.baseUrlOverride?.trim() || undefined,
                models: values.models?.trim() || undefined,
                weight: Number(values.weight),
                priority: Number(values.priority),
                status: Number(values.status),
                rpmLimit: values.rpmLimit === '' ? null : Number(values.rpmLimit),
                tpmLimit: values.tpmLimit === '' ? null : Number(values.tpmLimit),
                upstreamThreshold:
                  values.upstreamThreshold === '' ? null : Number(values.upstreamThreshold),
              });
              return notify(res, '保存失败', '已保存');
            })
          }
          formId="channel-edit-form"
          providers={providers}
          isEdit
        />
      )}
    </FormDialog>
  );
}

// 复用表单字段（创建 / 编辑）
function ChannelForm<T extends Record<string, unknown>>({
  form,
  onSubmit,
  formId,
  providers,
  isEdit = false,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: any;
  onSubmit: (values: T) => void;
  formId: string;
  providers: ReadonlyArray<ProviderOption>;
  isEdit?: boolean;
}) {
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        {!isEdit && (
          <Controller
            control={form.control}
            name="providerId"
            render={({
              field,
              fieldState,
            }: {
              field: { value: number; onChange: (v: number) => void };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel>供应商</FieldLabel>
                <Select
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        )}
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
              <FieldLabel htmlFor="ch-name">渠道名称</FieldLabel>
              <Input id="ch-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="apiKey"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-key">API Key{isEdit ? '（留空不修改）' : ''}</FieldLabel>
              <Input id="ch-key" type="password" {...field} placeholder={isEdit ? '••••••' : ''} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrlOverride"
          render={({ field }: { field: { value: string } }) => (
            <Field>
              <FieldLabel htmlFor="ch-url">Base URL 覆盖（可选）</FieldLabel>
              <Input id="ch-url" placeholder="覆盖供应商默认地址" {...field} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="models"
          render={({ field }: { field: { value: string } }) => (
            <Field>
              <FieldLabel htmlFor="ch-models">模型列表（可选）</FieldLabel>
              <Input id="ch-models" placeholder="例如 gpt-4o,claude-3-5-sonnet" {...field} />
            </Field>
          )}
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            control={form.control}
            name="weight"
            label="权重（1-1000）"
            id="ch-weight"
            step="1"
            min={1}
          />
          <NumberField
            control={form.control}
            name="priority"
            label="优先级（数字越大越优先）"
            id="ch-priority"
            step="1"
            min={0}
          />
        </div>
        {isEdit && (
          <>
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
                      <SelectItem value="0">启用</SelectItem>
                      <SelectItem value="2">禁用</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <Controller
                control={form.control}
                name="rpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="ch-rpm">RPM 限额（空=默认）</FieldLabel>
                    <Input id="ch-rpm" type="number" {...field} placeholder="默认" />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="tpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="ch-tpm">TPM 限额（空=默认）</FieldLabel>
                    <Input id="ch-tpm" type="number" {...field} placeholder="默认" />
                  </Field>
                )}
              />
            </div>
            <Controller
              control={form.control}
              name="upstreamThreshold"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="ch-threshold">
                    熔断阈值（元，剩余 ≤ 此值自动熔断；空=0 即耗尽才熔断）
                  </FieldLabel>
                  <Input id="ch-threshold" type="number" step="0.01" {...field} placeholder="0" />
                </Field>
              )}
            />
          </>
        )}
      </FieldGroup>
    </form>
  );
}

// ── 批量导入 ────────────────────────────────────────────────────────────────
export function ImportChannelsDialog() {
  const notify = useActionResult();
  const [text, setText] = useState('');

  return (
    <FormDialog
      trigger={
        <Button variant="outline">
          <UploadIcon />
          批量导入
        </Button>
      }
      title={
        <>
          <UploadIcon /> 批量导入渠道
        </>
      }
      titleClassName="flex items-center gap-2"
      description="粘贴 JSON 数组，每项含 provider（供应商名）、name、apiKey、可选 models / weight / priority"
      submitLabel="导入"
      onSubmitClick={async () => {
        let channels: Array<{
          provider: string;
          name: string;
          apiKey: string;
          models?: string;
          weight?: number;
          priority?: number;
        }> = [];
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error('需要 JSON 数组');
          channels = parsed;
        } catch {
          toast.error('请输入合法的 JSON 数组');
          return false;
        }
        const { importChannelsAction } = await import('../actions');
        const res = await importChannelsAction(channels);
        if (!notify(res, '导入失败')) return false;
        toast.success(`已导入 ${res.created ?? channels.length} 条`);
        setText('');
        return true;
      }}
    >
      <Textarea
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="font-mono text-xs"
        placeholder={
          '[\n  {"provider":"OpenAI","name":"openai-main","apiKey":"sk-xxx","models":"gpt-4o"}\n]'
        }
      />
    </FormDialog>
  );
}
