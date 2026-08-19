"use client";

import { useState } from "react";

import { KeyRoundIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { fmtDateTime, formatMoney } from "@ai-gateway/api-client/formatters";
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
import { NumberField } from "@ai-gateway/ui/components/ui/number-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";
import { CopyButton } from "@ai-gateway/ui/components/shell/copy-button";

import type { KeyRow } from "@ai-gateway/api-client/types";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

const createSchema = z.object({
  name: z.string().min(1, "请输入名称").max(100),
  remark: z.string().max(200).optional(),
  subscriptionId: z.number().int().positive().nullable(),
});

const editSchema = z.object({
  name: z.string().min(1, "请输入名称").max(100),
  remark: z.string().max(200).optional(),
  rpmLimit: z.string().optional(),
  tpmLimit: z.string().optional(),
  dailySpendLimit: z.string().optional(),
});

/** RPM/TPM：留空=不限；填值须正整数。 */
function parsePositiveInt(raw: string | undefined, field: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${field} 须为正整数`);
  }
  return n;
}

/** 每日花费上限：留空=不限；填值须 >= 0。 */
function parseDailySpend(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("每日花费上限须为 >= 0 的金额");
  }
  return n;
}

function fmtLimit(v: number | null): string {
  return v === null ? "不限" : v.toLocaleString();
}

function fmtMoney(v: string | null): string {
  return v === null ? "不限" : formatMoney(v);
}

export function KeysTable({
  keys,
  subscriptionLabels,
}: {
  readonly keys: ReadonlyArray<KeyRow>;
  readonly subscriptionLabels: ReadonlyMap<number, string>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          <TableHead className="text-right">每日花费上限</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead>最近使用</TableHead>
          <TableHead className="w-32 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableRow>
            <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
              暂无 Key
            </TableCell>
          </TableRow>
        ) : (
          keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="font-medium">{k.name}</TableCell>
              <TableCell>
                <SourceBadge
                  label={k.subscriptionId != null ? (subscriptionLabels.get(k.subscriptionId) ?? "套餐") : "余额"}
                />
              </TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.keyPreview}</code>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{k.remark || "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtLimit(k.rpmLimit)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtLimit(k.tpmLimit)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(k.dailySpendLimit)}</TableCell>
              <TableCell>
                <StatusBadge status={k.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {fmtDateTime(k.createdAt)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {fmtDateTime(k.lastUsedAt)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {k.status === 0 && <EditKeyInline key={k.id} keyRow={k} />}
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
      <StatusPill tone="success" label="正常" />
    );
  }
  return (
    <StatusPill tone="danger" label="已吊销" />
  );
}

function SourceBadge({ label }: { label: string }) {
  const isBalance = label === "余额";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isBalance
          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : "bg-violet-500/15 text-violet-700 dark:text-violet-300"
      }`}
    >
      {label}
    </span>
  );
}

function RevokeInline({ id }: { id: number }) {
  return (
    <ConfirmAction
      confirm="确定吊销此 Key？吊销后无法恢复。"
      action={async () => (await import("../actions")).revokeKeyAction(id)}
      errorTitle="吊销失败"
      success="已吊销"
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
          吊销
        </Button>
      )}
    </ConfirmAction>
  );
}

function EditKeyInline({ keyRow }: { keyRow: KeyRow }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const form = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: keyRow.name,
      remark: keyRow.remark ?? "",
      rpmLimit: keyRow.rpmLimit === null ? "" : String(keyRow.rpmLimit),
      tpmLimit: keyRow.tpmLimit === null ? "" : String(keyRow.tpmLimit),
      dailySpendLimit: keyRow.dailySpendLimit === null ? "" : String(keyRow.dailySpendLimit),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o)
          form.reset({
            name: keyRow.name,
            remark: keyRow.remark ?? "",
            rpmLimit: keyRow.rpmLimit === null ? "" : String(keyRow.rpmLimit),
            tpmLimit: keyRow.tpmLimit === null ? "" : String(keyRow.tpmLimit),
            dailySpendLimit:
              keyRow.dailySpendLimit === null ? "" : String(keyRow.dailySpendLimit),
          });
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <PencilIcon />
          编辑
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑 Key</DialogTitle>
          <DialogDescription>
            修改名称、备注或限流（RPM / TPM / 每日花费上限，留空 = 不限）。
          </DialogDescription>
        </DialogHeader>
        <form
          id="edit-key-form"
          onSubmit={form.handleSubmit(async (values) => {
            let rpmLimit: number | null;
            let tpmLimit: number | null;
            let dailySpendLimit: number | null;
            try {
              rpmLimit = parsePositiveInt(values.rpmLimit, "RPM");
              tpmLimit = parsePositiveInt(values.tpmLimit, "TPM");
              dailySpendLimit = parseDailySpend(values.dailySpendLimit);
            } catch (e) {
              toast.error((e as Error).message);
              return;
            }
            const { updateKeyAction } = await import("../actions");
            const res = await updateKeyAction(keyRow.id, {
              name: values.name,
              remark: values.remark,
              rpmLimit,
              tpmLimit,
              dailySpendLimit,
            });
            if (!notify(res, "更新失败", "已更新")) return;
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
            <NumberField
              control={form.control}
              name="rpmLimit"
              label="RPM（每分钟请求数，留空=不限）"
              id="edit-key-rpm"
              min={1}
              step="1"
              placeholder="不限"
            />
            <NumberField
              control={form.control}
              name="tpmLimit"
              label="TPM（每分钟 Token 数，留空=不限）"
              id="edit-key-tpm"
              min={1}
              step="1"
              placeholder="不限"
            />
            <NumberField
              control={form.control}
              name="dailySpendLimit"
              label="每日花费上限（元，留空=不限）"
              id="edit-key-dailyspend"
              min={0}
              step="0.01"
              placeholder="不限"
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

export function CreateKeyDialog({
  subscriptions,
}: {
  readonly subscriptions: ReadonlyArray<{ id: number; label: string }>;
}) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const form = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", remark: "", subscriptionId: null },
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
              if (!notify(res, "创建失败")) return;
              setRevealedKey(res.key!.plaintext);
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
                name="subscriptionId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="key-source">计费来源</FieldLabel>
                    <select
                      id="key-source"
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(e.target.value === "" ? null : Number(e.target.value))
                      }
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">余额（扣余额）</option>
                      {subscriptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}（扣套餐额度）
                        </option>
                      ))}
                    </select>
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
