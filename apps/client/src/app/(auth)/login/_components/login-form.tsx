"use client";

import { useState, useTransition } from "react";

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, UserIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@ai-gateway/ui/components/ui/input-group";
import { toast } from "sonner";

import { loginAction } from "@/lib/server-actions/auth";

const loginSchema = z.object({
  username: z.string().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm({ next }: { next: string | null }) {
  const [pending, startTransition] = useTransition();
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  function onSubmit(values: LoginValues) {
    startTransition(async () => {
      const fd = new FormData();
      fd.append("username", values.username);
      fd.append("password", values.password);
      if (next) fd.append("next", next);
      const res = await loginAction(fd);
      if (res?.error) {
        toast("登录失败", { description: res.error });
      }
      // loginAction 成功会 redirect，不会回到这里
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>欢迎回来</CardTitle>
        <CardDescription>输入您的用户名和密码登录用户面板</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="username"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="login-username">用户名</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <UserIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="login-username"
                      autoComplete="username"
                      placeholder="your_name"
                      {...field}
                    />
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="password"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="login-password">密码</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LockIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      {...field}
                    />
                    <InputGroupAddon align="inline-end">
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </InputGroupAddon>
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>

          <Button type="submit" disabled={pending} className="w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            登录
          </Button>

          <FieldDescription className="text-center">
            没有账号？请联系管理员创建。
          </FieldDescription>
        </form>
      </CardContent>
    </Card>
  );
}
