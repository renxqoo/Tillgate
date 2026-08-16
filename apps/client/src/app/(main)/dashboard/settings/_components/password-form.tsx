"use client";

import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

const schema = z
  .object({
    oldPassword: z.string().min(1, "请输入当前密码"),
    newPassword: z.string().min(8, "新密码至少 8 位").max(128, "新密码最多 128 位"),
    confirmPassword: z.string().min(1, "请确认新密码"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "两次输入的新密码不一致",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

/** 修改密码表单（无外层容器；由页面卡片或弹窗承载） */
export function PasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const notify = useActionResult();
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
        if (!notify(res, "修改失败", "密码已更新")) return;
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
              <FieldLabel htmlFor="old-password">当前密码</FieldLabel>
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
              <FieldLabel htmlFor="new-password">新密码</FieldLabel>
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
              <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
              <Input id="confirm-password" type="password" autoComplete="new-password" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" disabled={form.formState.isSubmitting} className="w-full">
        {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
        <KeyRoundIcon className="size-4" />
        保存新密码
      </Button>
    </form>
  );
}
