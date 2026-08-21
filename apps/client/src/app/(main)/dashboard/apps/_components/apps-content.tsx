"use client";

import { useState } from "react";

import { Loader2Icon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
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

import { CopyButton } from "@ai-gateway/ui/components/shell/copy-button";
import type { AppCreated, AppRow } from "@ai-gateway/api-client/types";
import { fmtDateTime } from "@ai-gateway/api-client/formatters";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

const createSchema = z.object({
  name: z.string().min(1, "请输入名称").max(100),
  description: z.string().max(255).optional(),
});

export function AppsTable({ apps }: { readonly apps: ReadonlyArray<AppRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>client_id</TableHead>
          <TableHead>app_id</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead>最近轮换</TableHead>
          <TableHead className="w-40 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              暂无应用
            </TableCell>
          </TableRow>
        ) : (
          apps.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="font-medium">
                {a.name}
                {a.description ? (
                  <span className="block text-xs font-normal text-muted-foreground">{a.description}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.clientId}</code>
                  <CopyButton text={a.clientId} />
                </div>
              </TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{a.appId}</code>
              </TableCell>
              <TableCell>
                <StatusBadge status={a.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {fmtDateTime(a.createdAt)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {fmtDateTime(a.rotatedAt)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {a.status === 0 && <RotateSecretInline id={a.id} name={a.name} />}
                  {a.status === 0 && <DeleteInline id={a.id} name={a.name} />}
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
  return status === 0 ? (
    <StatusPill tone="success" label="启用" />
  ) : (
    <StatusPill tone="neutral" label="停用" />
  );
}

function DeleteInline({ id, name }: { id: number; name: string }) {
  return (
    <ConfirmAction
      confirm={`确定删除应用「${name}」？无法恢复。`}
      action={async () => (await import("../actions")).deleteAppAction(id)}
      errorTitle="删除失败"
      success="已删除"
    >
      {({ pending, onClick }) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onClick}
          className="text-destructive hover:text-destructive"
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          删除
        </Button>
      )}
    </ConfirmAction>
  );
}

function RotateSecretInline({ id, name }: { id: number; name: string }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setRevealed(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <RefreshCwIcon />
          轮换 Secret
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>轮换 client_secret</DialogTitle>
          <DialogDescription>
            应用「{name}」将生成新的 client_secret，旧 secret 立即失效（已签发的 JWT 不受影响）。
          </DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              新 client_secret（请立即复制并安全保存）
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background/80 p-2 font-mono text-xs">{revealed}</code>
              <CopyButton text={revealed} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            确认要轮换此应用的 client_secret 吗？此操作不可撤销。
          </p>
        )}

        <DialogFooter>
          {revealed ? (
            <DialogClose asChild>
              <Button variant="outline">完成</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">取消</Button>
              </DialogClose>
              <Button
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  const { rotateSecretAction } = await import("../actions");
                  const res = await rotateSecretAction(id);
                  setPending(false);
                  if (!notify(res, "轮换失败")) return;
                  setRevealed(res.clientSecret!);
                  toast.success("已轮换 secret");
                }}
              >
                {pending && <Loader2Icon className="animate-spin" />}
                确认轮换
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateAppDialog() {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<AppCreated | null>(null);

  const form = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", description: "" },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setCreated(null); form.reset(); } }}>
      <DialogTrigger asChild>
        <Button>
          <ShieldCheckIcon />
          创建应用
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建新应用</DialogTitle>
          <DialogDescription>
            client_id 与 client_secret 仅在创建时完整显示一次，请妥善保存。
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              应用已创建（请立即复制并安全保存以下凭据）
            </p>
            <CreatedField label="client_id" value={created.clientId} />
            <CreatedField label="app_id" value={created.appId} />
            <CreatedField label="client_secret" value={created.clientSecret} mono />
          </div>
        ) : (
          <form
            id="create-app-form"
            onSubmit={form.handleSubmit(async (values) => {
              const { createAppAction } = await import("../actions");
              const res = await createAppAction(values);
              if (!notify(res, "创建失败")) return;
              setCreated(res.app!);
              toast.success("已创建应用");
            })}
            className="space-y-4"
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="app-name">名称</FieldLabel>
                    <Input id="app-name" placeholder="例如 my-app" {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="description"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="app-description">描述（可选）</FieldLabel>
                    <Input id="app-description" {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {created ? (
            <DialogClose asChild>
              <Button variant="outline">完成</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">取消</Button>
              </DialogClose>
              <Button type="submit" form="create-app-form" disabled={form.formState.isSubmitting}>
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

function CreatedField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className={"flex-1 break-all rounded bg-background/80 p-2 text-xs " + (mono ? "font-mono" : "")}>
          {value}
        </code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}
