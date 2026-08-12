"use client";

import { useState } from "react";

import { KeyRoundIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";
import { CopyButton } from "@/components/shell/copy-button";

import type { KeyRow } from "../types";

const createSchema = z.object({
  name: z.string().min(1, "请输入名称").max(100),
  remark: z.string().max(200).optional(),
});

const editSchema = z.object({
  name: z.string().min(1, "请输入名称").max(100),
  remark: z.string().max(200).optional(),
});

export function KeysTable({ keys }: { readonly keys: ReadonlyArray<KeyRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>备注</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead>最近使用</TableHead>
          <TableHead className="w-32 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              暂无 Key
            </TableCell>
          </TableRow>
        ) : (
          keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="font-medium">{k.name}</TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.keyPreview}</code>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{k.remark || "—"}</TableCell>
              <TableCell>
                <StatusBadge status={k.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(k.createdAt).toLocaleString("zh-CN")}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("zh-CN") : "—"}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {k.status === 0 && <EditKeyInline id={k.id} name={k.name} remark={k.remark} />}
                  {k.status === 0 && <RevokeInline id={k.id} />}
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function StatusBadge({ status }: { status: number }) {
  if (status === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        正常
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
      已吊销
    </span>
  );
}

function RevokeInline({ id }: { id: number }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={async () => {
        if (!confirm("确定吊销此 Key？吊销后无法恢复。")) return;
        setPending(true);
        const { revokeKeyAction } = await import("../actions");
        const res = await revokeKeyAction(id);
        setPending(false);
        if (res.error) toast.error("吊销失败", { description: res.error });
        else toast.success("已吊销");
      }}
      className="text-destructive hover:text-destructive"
    >
      {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
      吊销
    </Button>
  );
}

function EditKeyInline({
  id,
  name,
  remark,
}: {
  id: number;
  name: string;
  remark: string | null;
}) {
  const [open, setOpen] = useState(false);
  const form = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    defaultValues: { name, remark: remark ?? "" },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) form.reset({ name, remark: remark ?? "" }); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <PencilIcon />
          编辑
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑 Key</DialogTitle>
          <DialogDescription>修改名称或备注（不可更改 Key 本身）。</DialogDescription>
        </DialogHeader>
        <form
          id="edit-key-form"
          onSubmit={form.handleSubmit(async (values) => {
            const { updateKeyAction } = await import("../actions");
            const res = await updateKeyAction(id, {
              name: values.name,
              remark: values.remark,
            });
            if (res.error) {
              toast.error("更新失败", { description: res.error });
              return;
            }
            toast.success("已更新");
            setOpen(false);
          })}
          className="space-y-4"
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-key-name">名称</FieldLabel>
                  <Input id="edit-key-name" {...field} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="remark"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-key-remark">备注（可选）</FieldLabel>
                  <Input id="edit-key-remark" {...field} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="edit-key-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateKeyDialog() {
  const [open, setOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const form = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", remark: "" },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setRevealedKey(null); form.reset(); } }}>
      <DialogTrigger asChild>
        <Button>
          <KeyRoundIcon />
          创建 Key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建新的 API Key</DialogTitle>
          <DialogDescription>
            明文 Key 仅在创建时显示一次，请妥善保存。
          </DialogDescription>
        </DialogHeader>

        {revealedKey ? (
          <div className="rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                明文 Key（请立即复制并安全保存）
              </p>
              <CopyButton text={revealedKey} />
            </div>
            <code className="block break-all font-mono text-sm">{revealedKey}</code>
          </div>
        ) : (
          <form
            id="create-key-form"
            onSubmit={form.handleSubmit(async (values) => {
              const { createKeyAction } = await import("../actions");
              const res = await createKeyAction(values);
              if (res.error) {
                toast.error("创建失败", { description: res.error });
                return;
              }
              setRevealedKey(res.key!.key);
              toast.success("已创建 Key");
            })}
            className="space-y-4"
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="key-name">名称</FieldLabel>
                    <Input id="key-name" placeholder="例如 production" {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="remark"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="key-remark">备注（可选）</FieldLabel>
                    <Input id="key-remark" placeholder="例如 admin/team/..." {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {revealedKey ? (
            <DialogClose asChild>
              <Button variant="outline">完成</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">取消</Button>
              </DialogClose>
              <Button type="submit" form="create-key-form" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
                创建
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
