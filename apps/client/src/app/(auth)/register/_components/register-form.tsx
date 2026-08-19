"use client";

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

import { registerAction, registerVerifyAction } from "@/lib/server-actions/auth";
import { OAuthButtons, type OAuthOption } from "../../_components/oauth-buttons";
import { TurnstileWidget } from "../../_components/turnstile-widget";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

const schema = z
  .object({
    email: z.string().email("请输入有效邮箱"),
    password: z.string().min(8, "密码至少 10 位").max(128, "密码最多 1210 位"),
    confirmPassword: z.string().min(1, "请确认密码"),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "两次输入的密码不一致",
    path: ["confirmPassword"],
  });

type RegisterValues = z.infer<typeof schema>;

export function RegisterForm({
  oauthOptions = [],
  captchaSiteKey = null,
  affCode = null,
}: {
  oauthOptions?: OAuthOption[];
  /** 后端 GET /api/auth/captcha 下发；null = 未启用，不渲染 widget */
  captchaSiteKey?: string | null;
  /** 邀请归因 aff 码（?aff=，注册第二步透传） */
  affCode?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [showPassword, setShowPassword] = useState(false);
  // 注册两步：邮箱+密码 → 邮箱验证码 → 建号并自动登录
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // 人机验证：token 单次消费，提交被拒后递增 resetNonce 换新票
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetNonce, setCaptchaResetNonce] = useState(0);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", confirmPassword: "" },
  });

  function onSubmit(values: RegisterValues) {
    startTransition(async () => {
      const fd = new FormData();
      fd.append("email", values.email);
      fd.append("password", values.password);
      if (captchaSiteKey && captchaToken) fd.append("captchaToken", captchaToken);
      if (affCode) fd.append("aff", affCode);
      const res = await registerAction(fd);
      if (res?.challengeId) setChallenge(res.challengeId);
      else {
        // 人机验证被拒：token 已消费作废，强制换票后让用户重试
        if (res?.code === "CAPTCHA_REQUIRED" || res?.code === "CAPTCHA_INVALID") {
          setCaptchaToken(null);
          setCaptchaResetNonce((n) => n + 1);
        }
        notify(res ?? {}, "注册失败");
      }
    });
  }

  if (challenge) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>邮箱验证码</CardTitle>
          <CardDescription>验证码已发送到你注册的邮箱，5 分钟内有效</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const res = await registerVerifyAction(challenge, code, affCode);
                notify(res ?? {}, "验证失败");
                // 成功会 redirect，不会回到这里
              });
            }}
            className="space-y-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="register-code">6 位验证码</FieldLabel>
                <InputGroup>
                  <InputGroupAddon><ShieldCheckIcon /></InputGroupAddon>
                  <InputGroupInput
                    id="register-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    autoFocus
                  />
                </InputGroup>
                <FieldDescription>连续错 5 次验证码作废，需重新注册。</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={pending || code.length !== 6} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              验证并完成注册
            </Button>
            <button
              type="button"
              className="w-full cursor-pointer text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setChallenge(null);
                setCode("");
              }}
            >
              返回修改注册信息
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>注册账号</CardTitle>
        <CardDescription>使用邮箱注册，验证通过后自动登录</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="register-email">邮箱</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <MailIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="register-email"
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
                  <FieldLabel htmlFor="register-password">密码</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LockIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="register-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="至少 10 位"
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

            <Controller
              control={form.control}
              name="confirmPassword"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="register-confirm">确认密码</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LockIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="register-confirm"
                      type="password"
                      autoComplete="new-password"
                      {...field}
                    />
                  </InputGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>

          {captchaSiteKey && (
            <TurnstileWidget siteKey={captchaSiteKey} onToken={setCaptchaToken} resetNonce={captchaResetNonce} />
          )}

          <Button
            type="submit"
            disabled={pending || (!!captchaSiteKey && !captchaToken)}
            className="w-full"
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {!!captchaSiteKey && !captchaToken ? "请先完成人机验证" : "注册"}
          </Button>

          <FieldDescription className="text-center">
            已有账号？直接登录即可。
          </FieldDescription>
        </form>
        <div className="mt-4">
          <OAuthButtons options={oauthOptions} />
        </div>
      </CardContent>
    </Card>
  );
}
