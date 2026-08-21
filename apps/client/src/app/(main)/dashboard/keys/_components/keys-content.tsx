"use client";

import { useState } from "react";

import { KeyRoundIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
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

interface CreateKeyValues {
  name: string;
  remark?: string;
  subscriptionId: number | null;
}

interface EditKeyValues {
  name: string;
  remark?: string;
  rpmLimit?: string;
  tpmLimit?: string;
  dailySpendLimit?: string;
}

/** RPM/TPM：留空=不限；填值须正整数。 */
function parsePositiveInt(raw: string | undefined, invalidMessage: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(invalidMessage);
  }
  return n;
}

/** 每日花费上限：留空=不限；填值须 >= 0。 */
function parseDailySpend(raw: string | undefined, invalidMessage: string): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(invalidMessage);
  }
  return value;
}

export function KeysTable({
  keys,
  subscriptionLabels,
}: {
  readonly keys: ReadonlyArray<KeyRow>;
  readonly subscriptionLabels: ReadonlyMap<number, string>;
}) {
  const t = useTranslations("keys");
  const tCommon = useTranslations("common");

  const fmtLimit = (v: number | null): string =>
    v === null ? tCommon("unlimited") : v.toLocaleString("en-US");
  const fmtMoney = (v: string | null): string =>
    v === null ? tCommon("unlimited") : formatMoney(v);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tCommon("name")}</TableHead>
          <TableHead>{t("colType")}</TableHead>
          <TableHead>{t("colKey")}</TableHead>
          <TableHead>{t("colRemark")}</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          <TableHead className="text-right">{t("colDailyLimit")}</TableHead>
          <TableHead>{tCommon("status")}</TableHead>
          <TableHead>{tCommon("createdAt")}</TableHead>
          <TableHead>{t("colLastUsed")}</TableHead>
          <TableHead className="w-32 text-right">{tCommon("actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableRow>
            <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
              {t("noKeys")}
            </TableCell>
          </TableRow>
        ) : (
          keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="font-medium">{k.name}</TableCell>
              <TableCell>
                <SourceBadge
                  label={
                    k.subscriptionId != null
                      ? subscriptionLabels.get(k.subscriptionId) ?? t("planFallback")
                      : t("sourceBalance")
                  }
                  balanceLabel={t("sourceBalance")}
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
  const t = useTranslations("keys");
  if (status === 0) {
    return (
      <StatusPill tone="success" label={t("statusActive")} />
    );
  }
  return (
    <StatusPill tone="danger" label={t("statusRevoked")} />
  );
}

function SourceBadge({ label, balanceLabel }: { label: string; balanceLabel: string }) {
  const isBalance = label === balanceLabel;
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
  const t = useTranslations("keys");
  return (
    <ConfirmAction
      confirm={t("revokeConfirm")}
      action={async () => (await import("../actions")).revokeKeyAction(id)}
      errorTitle={t("revokeFailed")}
      success={t("revokedToast")}
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
          {t("revoke")}
        </Button>
      )}
    </ConfirmAction>
  );
}

function EditKeyInline({ keyRow }: { keyRow: KeyRow }) {
  const t = useTranslations("keys");
  const tCommon = useTranslations("common");
  const tUi = useTranslations("ui");
  const notify = useActionResult();
  const [open, setOpen] = useState(false);

  const editSchema = z.object({
    name: z.string().min(1, t("nameRequired")).max(100),
    remark: z.string().max(200).optional(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
    dailySpendLimit: z.string().optional(),
  });

  const form = useForm<EditKeyValues>({
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
          {tCommon("edit")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          <DialogDescription>{t("editDesc")}</DialogDescription>
        </DialogHeader>
        <form
          id="edit-key-form"
          onSubmit={form.handleSubmit(async (values) => {
            let rpmLimit: number | null;
            let tpmLimit: number | null;
            let dailySpendLimit: string | null;
            try {
              rpmLimit = parsePositiveInt(values.rpmLimit, t("positiveIntError", { field: "RPM" }));
              tpmLimit = parsePositiveInt(values.tpmLimit, t("positiveIntError", { field: "TPM" }));
              dailySpendLimit = parseDailySpend(values.dailySpendLimit, t("dailySpendError"));
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
            if (!notify(res, tCommon("updateFailed"), t("updatedToast"))) return;
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
                  <FieldLabel htmlFor="edit-key-name">{tCommon("name")}</FieldLabel>
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
                  <FieldLabel htmlFor="edit-key-remark">{t("remarkOptional")}</FieldLabel>
                  <Input id="edit-key-remark" {...field} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <NumberField
              control={form.control}
              name="rpmLimit"
              label={t("rpmLabel")}
              id="edit-key-rpm"
              min={1}
              step="1"
              placeholder={tCommon("unlimited")}
            />
            <NumberField
              control={form.control}
              name="tpmLimit"
              label={t("tpmLabel")}
              id="edit-key-tpm"
              min={1}
              step="1"
              placeholder={tCommon("unlimited")}
            />
            <NumberField
              control={form.control}
              name="dailySpendLimit"
              label={t("dailyLimitLabel")}
              id="edit-key-dailyspend"
              min={0}
              step="0.01"
              placeholder={tCommon("unlimited")}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tUi("cancel")}</Button>
          </DialogClose>
          <Button type="submit" form="edit-key-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
            {tCommon("save")}
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
  const t = useTranslations("keys");
  const tCommon = useTranslations("common");
  const tUi = useTranslations("ui");
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const createSchema = z.object({
    name: z.string().min(1, t("nameRequired")).max(100),
    remark: z.string().max(200).optional(),
    subscriptionId: z.number().int().positive().nullable(),
  });

  const form = useForm<CreateKeyValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", remark: "", subscriptionId: null },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setRevealedKey(null); form.reset(); } }}>
      <DialogTrigger asChild>
        <Button>
          <KeyRoundIcon />
          {t("createKey")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>
            {t("createDesc")}
          </DialogDescription>
        </DialogHeader>

        {revealedKey ? (
          <div className="rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {t("plaintextNotice")}
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
              if (!notify(res, tCommon("createFailed"))) return;
              setRevealedKey(res.key!.plaintext);
              toast.success(t("createdToast"));
            })}
            className="space-y-4"
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="key-name">{tCommon("name")}</FieldLabel>
                    <Input id="key-name" placeholder={t("namePlaceholder")} {...field} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="subscriptionId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="key-source">{t("billingSource")}</FieldLabel>
                    <select
                      id="key-source"
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(e.target.value === "" ? null : Number(e.target.value))
                      }
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">{t("balanceOption")}</option>
                      {subscriptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {t("planOption", { label: s.label })}
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
                    <FieldLabel htmlFor="key-remark">{t("remarkOptional")}</FieldLabel>
                    <Input id="key-remark" placeholder={t("remarkPlaceholder")} {...field} />
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
              <Button variant="outline">{tCommon("done")}</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">{tUi("cancel")}</Button>
              </DialogClose>
              <Button type="submit" form="create-key-form" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
                {tCommon("create")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
