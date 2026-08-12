"use client";

import { useState, useTransition } from "react";

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, MailIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@ai-gateway/ui/components/ui/input-group";

import { loginAction } from "@/lib/server-actions/auth";

const schema = z.object({
  email: z.string().email("请输入有效邮箱"),
  password: z.string().min(1, "请输入密码"),
});

type Values = z.infer<typeof schema>;

export function LoginForm() {
  const [pending, startTransition] = useTransition();
  const [showPwd, setShowPwd] = useState(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  function onSubmit(values: Values) {
    startTransition(async () => {
      const fd = new FormData();
      fd.append("email", values.email);
      fd.append("password", values.password);
      const res = await loginAction(fd);
      if (res?.error) toast.error("登录失败", { description: res.error });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>管理员登录</CardTitle>
        <CardDescription>仅限受邀管理员账号登录</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="admin-email">邮箱</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon><MailIcon /></InputGroupAddon>
                    <InputGroupInput id="admin-email" autoComplete="email" placeholder="admin@example.com" {...field} />
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
                  <FieldLabel htmlFor="admin-password">密码</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon><LockIcon /></InputGroupAddon>
                    <InputGroupInput
                      id="admin-password"
                      type={showPwd ? "text" : "password"}
                      autoComplete="current-password"
                      {...field}
                    />
                    <InputGroupAddon align="inline-end">
                      <button
                        type="button"
                        onClick={() => setShowPwd((s) => !s)}
                        aria-label={showPwd ? "隐藏" : "显示"}
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        {showPwd ? <EyeOffIcon /> : <EyeIcon />}
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
            不知道账号？请联系运维同学。
          </FieldDescription>
        </form>
      </CardContent>
    </Card>
  );
}
