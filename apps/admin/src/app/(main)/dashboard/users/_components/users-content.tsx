"use client";

import { useState, useTransition } from "react";
import Link from "next/link";

import {
  BanknoteIcon,
  EyeIcon,
  EyeOffIcon,
  GiftIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

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
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ai-gateway/ui/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";
import { Textarea } from "@ai-gateway/ui/components/ui/textarea";

import type { RateCardOption, UserRow } from "../types";

export function UsersContent({
  users,
  initialQuery: _initialQuery,
  rateCards,
}: {
  readonly users: ReadonlyArray<UserRow>;
  readonly initialQuery: string;
  readonly rateCards: ReadonlyArray<RateCardOption>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">ID</TableHead>
          <TableHead>账号</TableHead>
          <TableHead>显示名</TableHead>
          <TableHead>邮箱</TableHead>
          <TableHead className="w-20">状态</TableHead>
          <TableHead>费率卡</TableHead>
          <TableHead className="text-right">余额（元）</TableHead>
          <TableHead className="w-44">最近登录</TableHead>
          <TableHead className="w-40 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              无匹配用户
            </TableCell>
          </TableRow>
        ) : (
          users.map((u) => (
            <UserRowItem key={u.id} user={u} rateCards={rateCards} />
          ))
        )}
      </TableBody>
    </Table>
  );
}

function UserRowItem({
  user,
  rateCards,
}: {
  user: UserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const [pending, setPending] = useState(false);

  async function toggleStatus() {
    const newStatus = user.status === 0 ? 1 : 0;
    const action = newStatus === 1 ? "封禁" : "解封";
    const freezeReason =
      newStatus === 1
        ? (prompt(`请输入${action}原因（可选）`) ?? "")
        : "";
    if (newStatus === 1 && !confirm(`确定${action}用户 ${user.subject}？`)) return;
    setPending(true);
    const { setUserStatusAction } = await import("../actions");
    const res = await setUserStatusAction(user.id, {
      status: newStatus,
      freezeReason: newStatus === 1 ? freezeReason : "",
    });
    setPending(false);
    if (res.error) toast.error(`${action}失败`, { description: res.error });
    else toast.success(`已${action}`);
  }

  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        <Link href={`/dashboard/users/${user.id}`} className="hover:underline">
          #{user.id}
        </Link>
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/dashboard/users/${user.id}`} className="hover:underline">
          {user.subject}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{user.displayName ?? "—"}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{user.email ?? "—"}</TableCell>
      <TableCell>
        {user.status === 0 ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            正常
          </span>
        ) : (
          <span
            title={user.freezeReason ?? undefined}
            className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
          >
            已封禁
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{user.rateCardName ?? "—"}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">{user.balance}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("zh-CN") : "从未"}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <AdjustDialog user={user} />
          <GiftDialog user={user} />
          <PasswordDialog user={user} />
          <BindRateCardDialog user={user} rateCards={rateCards} />
          <Button
            size="sm"
            variant="ghost"
            title="详情"
            onClick={() => {
              window.location.href = `/dashboard/users/${user.id}`;
            }}
          >
            <EyeIcon />
          </Button>
          <Button
            size="sm"
            variant={user.status === 0 ? "destructive" : "outline"}
            disabled={pending}
            onClick={toggleStatus}
          >
            {pending ? (
              <Loader2Icon className="animate-spin" />
            ) : user.status === 0 ? (
              <ShieldOffIcon />
            ) : (
              <ShieldCheckIcon />
            )}
            {user.status === 0 ? "封禁" : "解封"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

const adjustSchema = z.object({
  amount: z.coerce.number().refine((v) => v !== 0, "金额必须非零"),
  remark: z.string().optional(),
});

function AdjustDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ amount: number; remark: string }>({
    resolver: zodResolver(adjustSchema) as never,
    defaultValues: { amount: 0, remark: "" },
  });

  function onSubmit(values: { amount: number; remark: string }) {
    startTransition(async () => {
      const { adjustBalanceAction } = await import("../actions");
      const res = await adjustBalanceAction(user.id, values);
      if (res.error) {
        toast.error("调账失败", { description: res.error });
        return;
      }
      toast.success("已调账");
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="调账">
          <ScaleIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> 调整余额 - {user.subject}
          </DialogTitle>
          <DialogDescription>
            正数增加余额，负数扣减。当前余额 {user.balance}
          </DialogDescription>
        </DialogHeader>
        <form id="adj-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="amount"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="adj-amount">金额（元，正/负）</FieldLabel>
                  <Input
                    id="adj-amount"
                    type="number"
                    step="0.01"
                    {...field}
                    value={field.value ?? 0}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="remark"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="adj-remark">备注</FieldLabel>
                  <Textarea id="adj-remark" rows={2} {...field} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="adj-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认调账
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const giftSchema = z.object({
  amount: z.coerce.number().positive("金额必须 > 0"),
  remark: z.string().optional(),
});

function GiftDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ amount: number; remark: string }>({
    resolver: zodResolver(giftSchema) as never,
    defaultValues: { amount: 0, remark: "" },
  });

  function onSubmit(values: { amount: number; remark: string }) {
    startTransition(async () => {
      const { giftUserAction } = await import("../actions");
      const res = await giftUserAction(user.id, values);
      if (res.error) {
        toast.error("赠送失败", { description: res.error });
        return;
      }
      toast.success("已赠送");
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="赠送">
          <GiftIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> 赠送余额 - {user.subject}
          </DialogTitle>
          <DialogDescription>赠送金额仅增加余额，通常不退款</DialogDescription>
        </DialogHeader>
        <form id="gift-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="amount"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="gift-amount">金额（元，&gt; 0）</FieldLabel>
                  <Input
                    id="gift-amount"
                    type="number"
                    step="0.01"
                    {...field}
                    value={field.value ?? 0}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="remark"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="gift-remark">备注</FieldLabel>
                  <Textarea id="gift-remark" rows={2} {...field} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="gift-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认赠送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const passwordSchema = z.object({
  password: z.string().min(6, "密码至少 6 位"),
});

function PasswordDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<{ password: string }>({
    resolver: zodResolver(passwordSchema) as never,
    defaultValues: { password: "" },
  });

  function onSubmit(values: { password: string }) {
    startTransition(async () => {
      const { setPasswordAction } = await import("../actions");
      const res = await setPasswordAction(user.id, values);
      if (res.error) {
        toast.error("设置失败", { description: res.error });
        return;
      }
      toast.success("已设置密码");
      form.reset();
      setShow(false);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setShow(false);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="设置密码">
          <KeyRoundIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon /> 设置密码 - {user.subject}
          </DialogTitle>
          <DialogDescription>为本地账号重置登录密码</DialogDescription>
        </DialogHeader>
        <form id="pw-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="password"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="pw">新密码</FieldLabel>
                  <div className="relative">
                    <Input
                      id="pw"
                      type={show ? "text" : "password"}
                      {...field}
                      className="pr-9"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="absolute right-1 top-1 size-7"
                      onClick={() => setShow((s) => !s)}
                      tabIndex={-1}
                    >
                      {show ? <EyeOffIcon /> : <EyeIcon />}
                    </Button>
                  </div>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="pw-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BindRateCardDialog({
  user,
  rateCards,
}: {
  user: UserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(user.rateCardId === null ? "none" : String(user.rateCardId));

  function onSubmit() {
    startTransition(async () => {
      const targetId = value === "none" ? null : Number(value);
      const { bindRateCardAction } = await import("../actions");
      const res = await bindRateCardAction(user.id, targetId);
      if (res.error) {
        toast.error("绑定失败", { description: res.error });
        return;
      }
      toast.success("已更新费率卡");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="绑定费率卡">
          <BanknoteIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> 绑定费率卡 - {user.subject}
          </DialogTitle>
          <DialogDescription>选择一张费率卡，或解绑</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择费率卡" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">（解绑）</SelectItem>
              {rateCards.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {r.name}（×{r.coefficient}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
