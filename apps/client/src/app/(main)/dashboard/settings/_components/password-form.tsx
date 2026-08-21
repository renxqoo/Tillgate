"use client";

import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

interface FormValues {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** 修改密码表单（无外层容器；由页面卡片或弹窗承载） */
export function PasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const t = useTranslations("settings");
  const notify = useActionResult();

  const schema = z
    .object({
      oldPassword: z.string().min(1, t("oldPasswordRequired")),
      newPassword: z.string().min(8, t("newPasswordMin")).max(128, t("newPasswordMax")),
      confirmPassword: z.string().min(1, t("confirmNewRequired")),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      message: t("newPasswordMismatch"),
      path: ["confirmPassword"],
    });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { oldPassword: "", newPassword: "", confirmPassword: "" },
  });

  return (
    <form
      onSubmit={form.handleSubmit(async (values) => {
        const { changePasswordAction } = await import("../actions");
        const res = await changePasswordAction({
          oldPassword: values.oldPassword,
          newPassword: values.newPassword,
        });
        if (!notify(res, t("changeFailedRetry"), t("passwordUpdatedToast"))) return;
        form.reset();
        onSuccess?.();
      })}
      className="space-y-4"
    >
      <FieldGroup>
        <Controller
          control={form.control}
          name="oldPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="old-password">{t("oldPasswordLabel")}</FieldLabel>
              <Input id="old-password" type="password" autoComplete="current-password" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="newPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="new-password">{t("newPasswordLabel")}</FieldLabel>
              <Input id="new-password" type="password" autoComplete="new-password" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="confirm-password">{t("confirmPasswordLabel")}</FieldLabel>
              <Input id="confirm-password" type="password" autoComplete="new-password" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" disabled={form.formState.isSubmitting} className="w-full">
        {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
        <KeyRoundIcon className="size-4" />
        {t("saveNewPassword")}
      </Button>
    </form>
  );
}
