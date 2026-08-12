"use client";

import { useState, useTransition } from "react";

import {
  CpuIcon,
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Checkbox } from "@ai-gateway/ui/components/ui/checkbox";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";
import { Textarea } from "@ai-gateway/ui/components/ui/textarea";

import type { ChannelOption, ModelRow } from "../types";

// 内联格式化，避免引入 server-only 的 api-client
function fmtPrice(v: string | number | null | undefined): string {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return (Number.isFinite(n) ? n : 0).toFixed(4);
}

const createSchema = z.object({
  externalName: z.string().min(1),
  realModel: z.string().min(1),
  inputPrice: z.coerce.number().min(0),
  outputPrice: z.coerce.number().min(0),
  cacheInputPrice: z.coerce.number().min(0),
});

export function ModelsTable({
  models,
  channels,
}: {
  readonly models: ReadonlyArray<ModelRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>外部名称</TableHead>
          <TableHead>真实模型</TableHead>
          <TableHead className="text-right">输入 / 百万 token</TableHead>
          <TableHead className="text-right">输出 / 百万 token</TableHead>
          <TableHead className="text-right">缓存 / 百万 token</TableHead>
          <TableHead>兜底模型</TableHead>
          <TableHead className="w-44">状态</TableHead>
          <TableHead className="w-32 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
              暂无模型
            </TableCell>
          </TableRow>
        ) : (
          models.map((m) => (
            <ModelRowItem key={m.id} model={m} channels={channels} />
          ))
        )}
      </TableBody>
    </Table>
  );
}

function ModelRowItem({
  model,
  channels,
}: {
  model: ModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <TableRow>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{model.externalName}</code>
      </TableCell>
      <TableCell className="font-medium">{model.realModel}</TableCell>
      <TableCell className="text-right tabular-nums">¥{fmtPrice(model.inputPrice)}</TableCell>
      <TableCell className="text-right tabular-nums">¥{fmtPrice(model.outputPrice)}</TableCell>
      <TableCell className="text-right tabular-nums">¥{fmtPrice(model.cacheInputPrice)}</TableCell>
      <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
        {model.fallbackModels ?? "—"}
      </TableCell>
      <TableCell>
        {model.status === 0 ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            启用
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            禁用
          </span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <BindChannelsDialog model={model} channels={channels} />
          <EditModelDialog model={model} />
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={async () => {
              if (!confirm(`确定删除模型映射 ${model.externalName}？`)) return;
              setPending(true);
              const { deleteModelAction } = await import("../actions");
              const res = await deleteModelAction(model.id);
              setPending(false);
              if (res.error) toast.error(res.error);
              else toast.success("已删除");
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

export function CreateModelDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.infer<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: { externalName: "", realModel: "", inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createModelAction } = await import("../actions");
      const res = await createModelAction(values);
      if (res.error) {
        toast.error("创建失败", { description: res.error });
        return;
      }
      toast.success("已创建");
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircleIcon />
          新建模型映射
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CpuIcon /> 新建模型映射
          </DialogTitle>
          <DialogDescription>把外部模型名映射到上游真实模型</DialogDescription>
        </DialogHeader>
        <ModelForm form={form} onSubmit={onSubmit} formId="model-form" />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="model-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const editSchema = z.object({
  externalName: z.string().min(1),
  realModel: z.string().min(1),
  inputPrice: z.coerce.number().min(0),
  outputPrice: z.coerce.number().min(0),
  cacheInputPrice: z.coerce.number().min(0),
  fallbackModels: z.string().optional(),
  paramRules: z.string().optional(),
  rpmLimit: z.string().optional(),
  tpmLimit: z.string().optional(),
  status: z.coerce.number().int(),
});

function EditModelDialog({ model }: { model: ModelRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.infer<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      externalName: model.externalName,
      realModel: model.realModel,
      inputPrice: Number(model.inputPrice),
      outputPrice: Number(model.outputPrice),
      cacheInputPrice: Number(model.cacheInputPrice),
      fallbackModels: model.fallbackModels ?? "",
      paramRules: model.paramRules ?? "",
      rpmLimit: model.rpmLimit === null ? "" : String(model.rpmLimit),
      tpmLimit: model.tpmLimit === null ? "" : String(model.tpmLimit),
      status: model.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateModelAction } = await import("../actions");
      const res = await updateModelAction(model.id, {
        externalName: values.externalName,
        realModel: values.realModel,
        inputPrice: values.inputPrice,
        outputPrice: values.outputPrice,
        cacheInputPrice: values.cacheInputPrice,
        fallbackModels: values.fallbackModels?.trim() || undefined,
        paramRules: values.paramRules?.trim() || undefined,
        rpmLimit: values.rpmLimit === "" ? null : Number(values.rpmLimit),
        tpmLimit: values.tpmLimit === "" ? null : Number(values.tpmLimit),
        status: values.status,
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> 编辑模型 - {model.externalName}
          </DialogTitle>
        </DialogHeader>
        <ModelForm form={form} onSubmit={onSubmit} formId="model-edit-form" isEdit />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="model-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ModelForm({ form, onSubmit, formId, isEdit = false }: { form: any; onSubmit: (v: never) => void; formId: string; isEdit?: boolean }) {
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        <div className="grid grid-cols-2 gap-3">
          <Controller
            control={form.control}
            name="externalName"
            render={({ field, fieldState }: { field: { value: string }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-ext">外部名称</FieldLabel>
                <Input id="m-ext" placeholder="例如 gpt-4o-mini" {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="realModel"
            render={({ field, fieldState }: { field: { value: string }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-real">真实模型</FieldLabel>
                <Input id="m-real" placeholder="例如 gpt-4o-mini-2024-07-18" {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Controller
            control={form.control}
            name="inputPrice"
            render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-in">输入价</FieldLabel>
                <Input id="m-in" type="number" step="0.0001" {...field} value={field.value ?? 0} onChange={(e) => field.onChange(Number(e.target.value))} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="outputPrice"
            render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-out">输出价</FieldLabel>
                <Input id="m-out" type="number" step="0.0001" {...field} value={field.value ?? 0} onChange={(e) => field.onChange(Number(e.target.value))} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="cacheInputPrice"
            render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-cache">缓存价</FieldLabel>
                <Input id="m-cache" type="number" step="0.0001" {...field} value={field.value ?? 0} onChange={(e) => field.onChange(Number(e.target.value))} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">单位：元 / 百万 token</p>
        {isEdit && (
          <>
            <Controller
              control={form.control}
              name="fallbackModels"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="m-fb">兜底模型（逗号分隔）</FieldLabel>
                  <Input id="m-fb" {...field} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="paramRules"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="m-rules">参数规则（JSON）</FieldLabel>
                  <Textarea id="m-rules" rows={3} className="font-mono text-xs" {...field} />
                </Field>
              )}
            />
            <div className="grid grid-cols-3 gap-3">
              <Controller
                control={form.control}
                name="rpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-rpm">RPM（空=默认）</FieldLabel>
                    <Input id="m-rpm" type="number" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="tpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-tpm">TPM（空=默认）</FieldLabel>
                    <Input id="m-tpm" type="number" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="status"
                render={({ field, fieldState }: { field: { value: number; onChange: (v: number) => void }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="m-status">状态</FieldLabel>
                    <Input id="m-status" type="number" {...field} value={field.value ?? 0} onChange={(e) => field.onChange(Number(e.target.value))} />
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

function BindChannelsDialog({
  model,
  channels,
}: {
  model: ModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<number[]>(model.channelIds ?? []);

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function onSubmit() {
    startTransition(async () => {
      const { bindChannelsAction } = await import("../actions");
      const res = await bindChannelsAction(model.id, selected);
      if (res.error) {
        toast.error("绑定失败", { description: res.error });
        return;
      }
      toast.success(`已绑定 ${selected.length} 个渠道`);
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
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="绑定渠道">
          <NetworkIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> 绑定渠道 - {model.externalName}
          </DialogTitle>
          <DialogDescription>勾选为该模型提供服务的渠道（会全量覆盖原绑定）</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">暂无可用渠道</p>
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
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}确认绑定（{selected.length}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
