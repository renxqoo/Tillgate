"use client";

import { useState } from "react";

import { GiftIcon, Loader2Icon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";

import { redeemAction } from "../actions";

const schema = z.object({
  code: z.string().min(4, "请输入有效的充值码"),
});

const ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "充值码无效或已过期",
  code_already_used: "充值码已被使用",
  code_revoked: "充值码已被撤销",
  code_expired: "充值码已过期",
};

export function RedeemForm() {
  const [result, setResult] = useState<{ amount: string; balanceAfter: string } | null>(null);

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { code: "" },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <GiftIcon className="size-5 text-primary" />
          兑换充值码
        </CardTitle>
        <CardDescription>输入您的充值码为账户余额充值</CardDescription>
      </CardHeader>
      <CardContent>
        {result ? (
          <div className="rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              充值成功 +¥{result.amount}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              当前余额 ¥{result.balanceAfter}，<button
                className="text-foreground underline"
                onClick={() => { setResult(null); form.reset(); }}
              >再兑换一张</button>
            </p>
          </div>
        ) : (
          <form
            onSubmit={form.handleSubmit(async (values) => {
              const res = await redeemAction(values.code);
              if (res.error) {
                const msg = (res.code && ERROR_MESSAGES[res.code]) || res.error;
                toast.error("充值失败", { description: msg });
                form.setError("code", { message: msg });
                return;
              }
              setResult({ amount: res.amount!, balanceAfter: res.balanceAfter! });
              toast.success(`已入账 ¥${res.amount}`);
            })}
            className="space-y-3"
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="code"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="redeem-code">充值码</FieldLabel>
                    <Input
                      id="redeem-code"
                      autoComplete="off"
                      placeholder="请输入充值码"
                      className="font-mono"
                      {...field}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
            <Button type="submit" disabled={form.formState.isSubmitting} className="w-full">
              {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
              兑换
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
