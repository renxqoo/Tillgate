"use client";

import { useState, useTransition } from "react";

import {
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
  UploadIcon,
  WifiIcon,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ai-gateway/ui/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ai-gateway/ui/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";
import { Textarea } from "@ai-gateway/ui/components/ui/textarea";

import type { ChannelRow, ProviderOption } from "../types";

const STATUS_META: Record<number, { label: string; tone: string; dot: string }> = {
  0: { label: "启用", tone: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  1: { label: "降级", tone: "text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  2: { label: "禁用", tone: "text-muted-foreground", dot: "bg-muted-foreground" },
  3: { label: "冷却", tone: "text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
};

function getStatusMeta(status: number): { label: string; tone: string; dot: string } {
  return STATUS_META[status] ?? STATUS_META[2] ?? {
    label: "未知",
    tone: "text-muted-foreground",
    dot: "bg-muted-foreground",
  };
}

export function ChannelsTable({
  channels,
  providers,
}: {
  readonly channels: ReadonlyArray<ChannelRow>;
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
          <TableHead>状态</TableHead>
          <TableHead className="text-right">失败次数</TableHead>
          <TableHead className="w-52 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
              暂无渠道
            </TableCell>
          </TableRow>
        ) : (
          channels.map((c) => (
            <ChannelRowItem key={c.id} channel={c} providers={providers} />
          ))
        )}
      </TableBody>
    </Table>
  );
}

function ChannelRowItem({
  channel,
  providers,
}: {
  channel: ChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const meta = getStatusMeta(channel.status);

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
          ? channel.boundModels.map((m) => m.externalName).join(", ")
          : "—"}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {channel.weight} / {channel.priority}
      </TableCell>
      <TableCell>
        <span className={"inline-flex items-center gap-1 text-xs font-medium " + meta.tone}>
          <span className={"size-1.5 rounded-full " + meta.dot} />
          {meta.label}
          {channel.cooldownUntil ? (
            <span className="text-muted-foreground" title={channel.cooldownUntil}>
              （冷却中）
            </span>
          ) : null}
        </span>
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
              const { testChannelAction } = await import("../actions");
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
          <Button
            size="sm"
            variant="ghost"
            disabled={deleting}
            onClick={async () => {
              if (!confirm(`确定删除渠道 ${channel.name}？`)) return;
              setDeleting(true);
              const { deleteChannelAction } = await import("../actions");
              const res = await deleteChannelAction(channel.id);
              setDeleting(false);
              if (res.error) toast.error(res.error);
              else toast.success("已删除");
            }}
            className="text-destructive hover:text-destructive"
          >
            {deleting ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

const createSchema = z.object({
  providerId: z.coerce.number().min(1, "请选择供应商"),
  name: z.string().min(1, "请输入名称"),
  apiKey: z.string().min(1, "请输入 API Key"),
  baseUrlOverride: z.string().optional(),
  models: z.string().optional(),
  weight: z.coerce.number().min(1).max(1000).default(100),
  priority: z.coerce.number().int().min(0).default(0),
});

export function CreateChannelDialog({
  providers,
}: {
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  type FormValues = z.infer<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      providerId: providers[0]?.id ?? 0,
      name: "",
      apiKey: "",
      baseUrlOverride: "",
      models: "",
      weight: 100,
      priority: 0,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createChannelAction } = await import("../actions");
      const res = await createChannelAction(values);
      if (res.error) {
        toast.error("创建失败", { description: res.error });
        return;
      }
      toast.success("已创建渠道");
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircleIcon />
          新建渠道
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> 新建渠道
          </DialogTitle>
          <DialogDescription>添加一条 LLM 供应商渠道</DialogDescription>
        </DialogHeader>
        <ChannelForm form={form} onSubmit={onSubmit} formId="channel-form" providers={providers} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="channel-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditChannelDialog({
  channel,
  providers,
}: {
  channel: ChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const editSchema = z.object({
    name: z.string().min(1, "请输入名称"),
    apiKey: z.string().optional(),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: z.coerce.number().min(1).max(1000),
    priority: z.coerce.number().int().min(0),
    status: z.coerce.number().int(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
  });
  type FormValues = z.infer<typeof editSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: channel.name,
      apiKey: "",
      baseUrlOverride: channel.baseUrlOverride ?? "",
      models: channel.models ?? "",
      weight: channel.weight,
      priority: channel.priority,
      status: channel.status,
      rpmLimit: channel.rpmLimit === null ? "" : String(channel.rpmLimit),
      tpmLimit: channel.tpmLimit === null ? "" : String(channel.tpmLimit),
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateChannelAction } = await import("../actions");
      const res = await updateChannelAction(channel.id, {
        name: values.name,
        apiKey: values.apiKey?.trim() || undefined,
        baseUrlOverride: values.baseUrlOverride?.trim() || undefined,
        models: values.models?.trim() || undefined,
        weight: values.weight,
        priority: values.priority,
        status: values.status,
        rpmLimit: values.rpmLimit === "" ? null : Number(values.rpmLimit),
        tpmLimit: values.tpmLimit === "" ? null : Number(values.tpmLimit),
      });
      if (res.error) {
        toast.error("保存失败", { description: res.error });
        return;
      }
      toast.success("已保存");
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
            <PencilIcon /> 编辑渠道 - {channel.name}
          </DialogTitle>
          <DialogDescription>留空 API Key 表示不修改</DialogDescription>
        </DialogHeader>
        <ChannelForm
          form={form as never}
          onSubmit={onSubmit as never}
          formId="channel-edit-form"
          providers={providers}
          isEdit
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="channel-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
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
          render={({ field, fieldState }: { field: { value: string }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
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
          render={({ field, fieldState }: { field: { value: string }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-key">API Key{isEdit ? "（留空不修改）" : ""}</FieldLabel>
              <Input id="ch-key" type="password" {...field} placeholder={isEdit ? "••••••" : ""} />
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
          <Controller
            control={form.control}
            name="weight"
            render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="ch-weight">权重（1-1000）</FieldLabel>
                <Input
                  id="ch-weight"
                  type="number"
                  {...field}
                  value={field.value ?? 100}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="priority"
            render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="ch-priority">优先级（数字越大越优先）</FieldLabel>
                <Input
                  id="ch-priority"
                  type="number"
                  {...field}
                  value={field.value ?? 0}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
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
                  <Select value={String(field.value ?? 0)} onValueChange={(v) => field.onChange(Number(v))}>
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
          </>
        )}
      </FieldGroup>
    </form>
  );
}

// ── 批量导入 ────────────────────────────────────────────────────────────────
export function ImportChannelsDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");

  function onSubmit() {
    startTransition(async () => {
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
        if (!Array.isArray(parsed)) throw new Error("需要 JSON 数组");
        channels = parsed;
      } catch {
        toast.error("请输入合法的 JSON 数组");
        return;
      }
      const { importChannelsAction } = await import("../actions");
      const res = await importChannelsAction(channels);
      if (res.error) {
        toast.error("导入失败", { description: res.error });
        return;
      }
      toast.success(`已导入 ${res.created ?? channels.length} 条`);
      setText("");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <UploadIcon />
          批量导入
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadIcon /> 批量导入渠道
          </DialogTitle>
          <DialogDescription>
            粘贴 JSON 数组，每项含 provider（供应商名）、name、apiKey、可选 models / weight / priority
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="font-mono text-xs"
          placeholder={'[\n  {"provider":"OpenAI","name":"openai-main","apiKey":"sk-xxx","models":"gpt-4o"}\n]'}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
