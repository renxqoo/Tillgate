'use client';

import {
  Button,
  ConfirmDialog,
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
  Textarea,
} from '@tillgate/ui';
import { FormDialog } from '@/components/form-dialog';
import { NumberField } from '@/components/number-field';
import { defineStatusMeta } from '@/components/status-pill';
import { StatusPill } from '@/components/status-pill';
import { useState } from 'react';

import {
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  RotateCcwIcon,
  Trash2Icon,
  UploadIcon,
  WifiIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { formatMoney, fmtDateTime } from '@/lib/formatters';

import { useActionResult } from '@/components/action-toast';
import { moneyText, numericText } from '@/lib/forms';

import type { AdminChannelRow, ProviderOption } from '@tillgate/api-client';

// 状态 tone 映射留模块级；label 是 channels 命名空间的 i18n key，渲染处用 t 解析
const STATUS_META = defineStatusMeta(
  {
    0: { label: 'statusEnabled', tone: 'success' },
    1: { label: 'statusDegraded', tone: 'warning' },
    2: { label: 'statusDisabled', tone: 'neutral' },
    3: { label: 'statusCooldown', tone: 'warning' },
    // 4 = 凭据无效（worker 连续 401/403 标记；换 Key 保存时复位为 0）
    4: { label: 'statusDead', tone: 'danger' },
  },
  // fallback 也走目录键——默认字面量 Unknown 会以 channels.Unknown 原样漏到 UI
  { label: 'statusUnknown', tone: 'neutral' },
);

export function ChannelsTable({
  channels,
  providers,
}: {
  readonly channels: ReadonlyArray<AdminChannelRow>;
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead>{t('provider')}</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead>{t('models')}</TableHead>
          <TableHead className="text-right">{t('weightPriority')}</TableHead>
          <TableHead className="text-right">{t('budget')}</TableHead>
          <TableHead>{tc('status')}</TableHead>
          <TableHead className="text-right">{t('failCount')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              {t('noChannels')}
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
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const meta = STATUS_META.get(channel.status);
  // 回收站行（deletedAt 非空）：只读——仅「恢复记录」，其余动作不可达
  const deleted = channel.deletedAt != null;

  async function runTest() {
    setTesting(true);
    const { testChannelAction } = await import('@/server/channels-actions');
    const res = await testChannelAction(channel.id);
    setTesting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(t('connected', { ms: res.durationMs ?? 0 }));
  }

  async function runDelete() {
    setDeleting(true);
    const { deleteChannelAction } = await import('@/server/channels-actions');
    const res = await deleteChannelAction(channel.id);
    setDeleting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(tc('deleted'));
  }

  async function runUndelete() {
    setRestoring(true);
    const { undeleteChannelAction } = await import('@/server/channels-actions');
    const res = await undeleteChannelAction(channel.id);
    setRestoring(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(t('undeleteSuccess'));
  }

  return (
    <TableRow className={deleted ? 'opacity-60' : undefined}>
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
        {deleted ? (
          <div className="flex flex-col">
            <StatusPill tone="danger" label={t('deleted')} />
            <span className="mt-0.5 text-[10px] text-muted-foreground">
              {fmtDateTime(channel.deletedAt!)}
            </span>
          </div>
        ) : (
          <StatusPill dot tone={meta.tone} label={t(meta.label)}>
            {channel.cooldownUntil ? (
              <span className="text-muted-foreground" title={channel.cooldownUntil}>
                {t('cooling')}
              </span>
            ) : null}
          </StatusPill>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {channel.failCount}
      </TableCell>
      <TableCell className="w-16 text-center">
        {/* 行操作走全站统一的 RowActions 菜单项范式（勿在菜单面板里放独立 Button 竖排） */}
        {deleted ? (
          <RowActions label={tc('actions')}>
            <DropdownMenuItem disabled={restoring} onClick={runUndelete}>
              {restoring ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-4" />
              )}
              {t('undelete')}
            </DropdownMenuItem>
          </RowActions>
        ) : (
          <>
            <RowActions label={tc('actions')}>
              <DropdownMenuItem disabled={testing} onClick={runTest}>
                {testing ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <WifiIcon className="size-4" />
                )}
                {t('test')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon className="size-4" />
                {tc('edit')}
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
            <EditChannelDialog
              channel={channel}
              providers={providers}
              open={editOpen}
              onOpenChange={setEditOpen}
            />
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={tc('delete')}
              description={t('deleteConfirm', { name: channel.name })}
              confirmLabel={tc('delete')}
              cancelLabel={tUi('cancel')}
              tone="destructive"
              onConfirm={runDelete}
              onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
            />
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

// 校验消息走目录：schema 在组件内用 t 构造
function buildCreateSchema(
  t: ReturnType<typeof useTranslations<'channels'>>,
  tc: ReturnType<typeof useTranslations<'common'>>,
) {
  return z.object({
    providerId: z.coerce.number().min(1, t('providerRequired')),
    name: z.string().min(1, t('nameRequired')),
    apiKey: z.string().min(1, t('apiKeyRequired')),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 1 && v <= 1000, t('weightRange')),
    priority: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 0, t('priorityNonNegative')),
  });
}

export function CreateChannelDialog({
  providers,
}: {
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const createSchema = buildCreateSchema(t, tc);

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
          {t('create')}
        </Button>
      }
      title={
        <>
          <NetworkIcon /> {t('create')}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('createDescription')}
      submitLabel={tc('create')}
      formId="channel-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { createChannelAction } = await import('@/server/channels-actions');
              const res = await createChannelAction({
                ...values,
                providerId: Number(values.providerId),
                weight: Number(values.weight),
                priority: Number(values.priority),
              });
              if (!notify(res, tc('createFailed'), t('channelCreated'))) return false;
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
  open,
  onOpenChange,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
  /** 受控 open：由行操作菜单项打开（FormDialog 受控模式，无 trigger） */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const notify = useActionResult();

  const editSchema = z.object({
    name: z.string().min(1, t('nameRequired')),
    apiKey: z.string().optional(),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 1 && v <= 1000, t('weightRange')),
    priority: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 0, t('priorityNonNegative')),
    status: z.coerce.number().int(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
    upstreamThreshold: z
      .union([z.literal(''), moneyText({ message: t('nonNegativeAmount') })])
      .optional(),
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
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          <PencilIcon /> {t('editTitle', { name: channel.name })}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('editDescription')}
      submitLabel={tc('save')}
      formId="channel-edit-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form as never}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { updateChannelAction } = await import('@/server/channels-actions');
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
                  values.upstreamThreshold === '' ? null : values.upstreamThreshold,
              });
              return notify(res, tc('saveFailed'), tc('saved'));
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
  const t = useTranslations('channels');
  const tc = useTranslations('common');
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
              <FormItem data-invalid={fieldState.invalid}>
                <FieldLabel>{t('provider')}</FieldLabel>
                <Select
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('selectProvider')} />
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
              </FormItem>
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
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-name">{t('channelName')}</FieldLabel>
              <Input id="ch-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
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
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-key">{isEdit ? t('apiKeyKeep') : t('apiKey')}</FieldLabel>
              <Input id="ch-key" type="password" {...field} placeholder={isEdit ? '••••••' : ''} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrlOverride"
          render={({ field }: { field: { value: string } }) => (
            <FormItem>
              <FieldLabel htmlFor="ch-url">{t('baseUrlOverride')}</FieldLabel>
              <Input id="ch-url" placeholder={t('overridePlaceholder')} {...field} />
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="models"
          render={({ field }: { field: { value: string } }) => (
            <FormItem>
              <FieldLabel htmlFor="ch-models">{t('modelsLabel')}</FieldLabel>
              <Input id="ch-models" placeholder={t('modelsPlaceholder')} {...field} />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            control={form.control}
            name="weight"
            label={t('weight')}
            id="ch-weight"
            step="1"
            min={1}
          />
          <NumberField
            control={form.control}
            name="priority"
            label={t('priority')}
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
                      <SelectItem value="0">{tc('enabled')}</SelectItem>
                      <SelectItem value="1">{t('statusDegraded')}</SelectItem>
                      <SelectItem value="2">{tc('disabled')}</SelectItem>
                      <SelectItem value="4">{t('statusDead')}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <Controller
                control={form.control}
                name="rpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="ch-rpm">{t('rpmLimit')}</FieldLabel>
                    <Input id="ch-rpm" type="number" {...field} placeholder={tc('default')} />
                  </FormItem>
                )}
              />
              <Controller
                control={form.control}
                name="tpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="ch-tpm">{t('tpmLimit')}</FieldLabel>
                    <Input id="ch-tpm" type="number" {...field} placeholder={tc('default')} />
                  </FormItem>
                )}
              />
            </div>
            <Controller
              control={form.control}
              name="upstreamThreshold"
              render={({ field }: { field: { value: string } }) => (
                <FormItem>
                  <FieldLabel htmlFor="ch-threshold">{t('circuitThreshold')}</FieldLabel>
                  <Input id="ch-threshold" type="number" step="0.01" {...field} placeholder="0" />
                </FormItem>
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
  const t = useTranslations('channels');
  const notify = useActionResult();
  const [text, setText] = useState('');

  return (
    <FormDialog
      trigger={
        <Button variant="outline">
          <UploadIcon />
          {t('import')}
        </Button>
      }
      title={
        <>
          <UploadIcon /> {t('importTitle')}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('importDescription')}
      submitLabel={t('importSubmit')}
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
          if (!Array.isArray(parsed)) throw new Error('JSON array required');
          channels = parsed;
        } catch {
          toast.error(t('invalidJson'));
          return false;
        }
        const { importChannelsAction } = await import('@/server/channels-actions');
        const res = await importChannelsAction(channels);
        if (!notify(res, t('importFailed'))) return false;
        toast.success(t('imported', { count: res.created ?? channels.length }));
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
