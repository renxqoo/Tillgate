"use client";

import { useState, useTransition } from "react";

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, MailIcon, ShieldCheckIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@ai-gateway/ui/components/ui/input-group";

import { loginAction, verifyLoginAction } from "@/lib/server-actions/auth";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

const schema = z.object({
  email: z.string().email("请输入有效邮箱"),
  password: z.string().min(1, "请输入密码"),
});

type Values = z.infer<typeof schema>;

export function LoginForm() {
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [showPwd, setShowPwd] = useState(false);
  // 邮箱验证码二次登录：第一步通过后进入验证码步
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");

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
      if (res?.challengeId) setChallenge(res.challengeId);
      else notify(res ?? {}, "登录失败");
    });
  }

  if (challenge) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>邮箱验证码</CardTitle>
          <CardDescription>验证码已发送到你的管理员邮箱，5 分钟内有效</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const res = await verifyLoginAction(challenge, code);
                notify(res ?? {}, "验证失败");
              });
            }}
            className="space-y-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="admin-2fa-code">6 位验证码</FieldLabel>
                <InputGroup>
                  <InputGroupAddon><ShieldCheckIcon /></InputGroupAddon>
                  <InputGroupInput
                    id="admin-2fa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    autoFocus
                  />
                </InputGroup>
                <FieldDescription>连续错 5 次验证码作废，需重新登录。</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={pending || code.length !== 6} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              验证并登录
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => { setChallenge(null); setCode(""); }}
            >
              返回重新登录
            </button>
          </form>
        </CardContent>
      </Card>
    );
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
