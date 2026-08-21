"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { EyeIcon, EyeOffIcon, Loader2Icon, LockIcon, MailIcon, ShieldCheckIcon } from "lucide-react";
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

import { loginAction, verifyLoginCodeAction } from "@/lib/server-actions/auth";
import { OAuthButtons, type OAuthOption } from "../../_components/oauth-buttons";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

const loginSchema = z.object({
  email: z.string().email("请输入有效邮箱"),
  password: z.string().min(1, "请输入密码"),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm({ next, oauthOptions = [] }: { next: string | null; oauthOptions?: OAuthOption[] }) {
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [showPassword, setShowPassword] = useState(false);
  // 强制邮箱验证码两步登录：第一步通过后进入验证码步
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  function onSubmit(values: LoginValues) {
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
          <CardDescription>验证码已发送到你的邮箱，5 分钟内有效</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const res = await verifyLoginCodeAction(challenge, code, next);
                notify(res ?? {}, "验证失败");
                // 成功会 redirect，不会回到这里
              });
            }}
            className="space-y-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-code">6 位验证码</FieldLabel>
                <InputGroup>
                  <InputGroupAddon><ShieldCheckIcon /></InputGroupAddon>
                  <InputGroupInput
                    id="login-code"
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
              className="w-full cursor-pointer text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setChallenge(null);
                setCode("");
              }}
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
        <CardTitle>欢迎回来</CardTitle>
        <CardDescription>输入您的邮箱和密码登录用户面板</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="login-email">邮箱</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <MailIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="login-email"
                      autoComplete="email"
                      placeholder="you@example.com"
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
            没有账号？
            <Link href="/register" className="ml-1 text-foreground underline-offset-2 hover:underline">
              立即注册
            </Link>
          </FieldDescription>
        </form>
        <div className="mt-4">
          <OAuthButtons options={oauthOptions} />
        </div>
      </CardContent>
    </Card>
  );
}
