"use client";

import { useState } from "react";

import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";

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

export function PasswordForm() {
  const [done, setDone] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { oldPassword: "", newPassword: "", confirmPassword: "" },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
          修改密码
        </CardTitle>
        <CardDescription>更新您的登录密码</CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              密码已更新
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              下次登录请使用新密码，
              <button
                type="button"
                className="text-foreground underline"
                onClick={() => {
                  setDone(false);
                  form.reset();
                }}
              >
                再改一次
              </button>
            </p>
          </div>
        ) : (
          <form
            onSubmit={form.handleSubmit(async (values) => {
              const { changePasswordAction } = await import("../actions");
              const res = await changePasswordAction({
                oldPassword: values.oldPassword,
                newPassword: values.newPassword,
              });
              if (res.error) {
                toast.error("修改失败", { description: res.error });
                return;
              }
              setDone(true);
              toast.success("密码已更新");
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
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
              保存新密码
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
