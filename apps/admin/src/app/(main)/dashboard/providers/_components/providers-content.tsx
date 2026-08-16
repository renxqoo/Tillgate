"use client";

import { useState, useTransition } from "react";

import {
  Loader2Icon,
  PencilIcon,
  PlusCircleIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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

import type { AdminProviderRow } from "@ai-gateway/api-client/types";
import { fmtDateTime } from "@ai-gateway/api-client/formatters";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

const schema = z.object({
  name: z.string().min(1, "请输入名称"),
  baseUrl: z.string().url("请输入合法的 URL"),
  protocol: z.string().min(1),
  status: z.coerce.number().int(),
});
type FormValues = z.infer<typeof schema>;

export function ProvidersTable({ providers, protocols }: { readonly providers: ReadonlyArray<AdminProviderRow>; readonly protocols: ReadonlyArray<string> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead className="w-32">协议</TableHead>
          <TableHead className="w-24">状态</TableHead>
          <TableHead className="w-44">更新时间</TableHead>
          <TableHead className="w-24 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              暂无供应商
            </TableCell>
          </TableRow>
        ) : (
          providers.map((p) => <ProviderRowItem key={p.id} provider={p} protocols={protocols} />)
        )}
      </TableBody>
    </Table>
  );
}

function ProviderRowItem({ provider, protocols }: { provider: AdminProviderRow; readonly protocols: ReadonlyArray<string> }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{provider.name}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{provider.baseUrl}</code>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{provider.protocol}</TableCell>
      <TableCell>
        {provider.status === 0 ? (
          <StatusPill tone="success" label="启用" />
        ) : (
          <StatusPill tone="neutral" label="禁用" />
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {provider.updatedAt
          ? fmtDateTime(provider.updatedAt)
          : fmtDateTime(provider.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <EditProviderDialog provider={provider} protocols={protocols} />
          <ConfirmAction
            confirm={`确定删除供应商 ${provider.name}？关联渠道将不可用。`}
            action={async () => (await import("../actions")).deleteProviderAction(provider.id)}
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

export function CreateProviderDialog({ protocols }: { readonly protocols: ReadonlyArray<string> }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: "", baseUrl: "", protocol: protocols[0] ?? "openai-compatible", status: 0 },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createProviderAction } = await import("../actions");
      const res = await createProviderAction(values);
      if (!notify(res, "创建失败", "已创建")) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircleIcon />
          新建供应商
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon /> 新建供应商
          </DialogTitle>
          <DialogDescription>定义一个 LLM 供应商入口</DialogDescription>
        </DialogHeader>
        <ProviderForm form={form} onSubmit={onSubmit} formId="provider-form" protocols={protocols} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="provider-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProviderDialog({ provider, protocols }: { provider: AdminProviderRow; readonly protocols: ReadonlyArray<string> }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      status: provider.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateProviderAction } = await import("../actions");
      const res = await updateProviderAction(provider.id, values);
      if (!notify(res, "保存失败", "已保存")) return;
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
            <PencilIcon /> 编辑供应商 - {provider.name}
          </DialogTitle>
        </DialogHeader>
        <ProviderForm form={form} onSubmit={onSubmit} formId="provider-edit-form" protocols={protocols} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="provider-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ProviderForm({ form, onSubmit, formId, protocols }: { form: any; onSubmit: (v: FormValues) => void; formId: string; protocols: ReadonlyArray<string> }) {
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }: { field: { value: string }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="p-name">名称</FieldLabel>
              <Input id="p-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrl"
          render={({ field, fieldState }: { field: { value: string }; fieldState: { invalid?: boolean; error?: { message?: string } } }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="p-url">Base URL</FieldLabel>
              <Input id="p-url" placeholder="https://api.openai.com/v1" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="protocol"
          render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
            <Field>
              <FieldLabel>协议</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {protocols.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="status"
          render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
            <Field>
              <FieldLabel>状态</FieldLabel>
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">启用</SelectItem>
                  <SelectItem value="1">禁用</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
      </FieldGroup>
    </form>
  );
}
