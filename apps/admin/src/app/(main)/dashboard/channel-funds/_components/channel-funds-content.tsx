"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BanknoteIcon,
  ImageIcon,
  Loader2Icon,
  ScaleIcon,
} from "lucide-react";
import { toast } from "sonner";

import { formatMoney } from "@ai-gateway/api-client/formatters";
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
import { Field, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
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

import type { ChannelFundRow, ChannelOption } from "../types";

function fmtSigned(v: string): string {
  const n = Number(v);
  return (n > 0 ? "+" : "") + formatMoney(v);
}

export function ChannelFundsClient({
  rows,
  channels,
  total,
  initialChannelId,
  initialType,
}: {
  readonly rows: ReadonlyArray<ChannelFundRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
  readonly total: number;
  readonly initialChannelId?: number;
  readonly initialType?: "recharge" | "adjust";
}) {
  const [channelFilter, setChannelFilter] = useState<string>(
    initialChannelId ? String(initialChannelId) : "all",
  );
  const [typeFilter, setTypeFilter] = useState<string>(initialType ?? "all");
  const router = useRouter();

  function applyFilter(nextChannel: string, nextType: string) {
    setChannelFilter(nextChannel);
    setTypeFilter(nextType);
    const qs = new URLSearchParams();
    if (nextChannel !== "all") qs.set("channelId", nextChannel);
    if (nextType !== "all") qs.set("type", nextType);
    router.push(`/dashboard/channel-funds${qs.toString() ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={channelFilter} onValueChange={(v) => applyFilter(v, typeFilter)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="全部渠道" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部渠道</SelectItem>
              {channels.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => applyFilter(channelFilter, v)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="recharge">入货</SelectItem>
              <SelectItem value="adjust">调账</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <RechargeDialog channels={channels} />
          <AdjustDialog channels={channels} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">共 {total} 条流水</p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">ID</TableHead>
            <TableHead className="w-40">时间</TableHead>
            <TableHead>渠道</TableHead>
            <TableHead className="w-20">类型</TableHead>
            <TableHead className="text-right">金额</TableHead>
            <TableHead className="text-right">变动后额度</TableHead>
            <TableHead>订单号</TableHead>
            <TableHead>凭证</TableHead>
            <TableHead>操作人</TableHead>
            <TableHead>备注</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                暂无流水
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  #{r.id}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className="font-medium">{r.channelName}</TableCell>
                <TableCell>
                  <span
                    className={
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium " +
                      (r.type === "recharge"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-300")
                    }
                  >
                    {r.type === "recharge" ? "入货" : "调账"}
                  </span>
                </TableCell>
                <TableCell
                  className={
                    "text-right font-medium tabular-nums " +
                    (Number(r.amount) >= 0 ? "text-emerald-600" : "text-destructive")
                  }
                >
                  {fmtSigned(r.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(r.balanceAfter)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.orderNo ?? "—"}</TableCell>
                <TableCell>
                  {r.voucher ? (
                    <a href={`/api/admin/vouchers/${r.voucher}`} target="_blank" rel="noreferrer">
                      <ImageIcon className="size-4 text-muted-foreground hover:text-foreground" />
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.adminDisplayName ?? r.adminEmail ?? "—"}
                </TableCell>
                <TableCell className="max-w-xs text-xs text-muted-foreground">
                  {r.remark ?? "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ChannelSelect({
  value,
  onChange,
  channels,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  channels: ReadonlyArray<ChannelOption>;
  id: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>渠道</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="选择渠道" />
        </SelectTrigger>
        <SelectContent>
          {channels.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function RechargeDialog({ channels }: { channels: ReadonlyArray<ChannelOption> }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [channelId, setChannelId] = useState("");
  const [amount, setAmount] = useState("");
  const [orderNo, setOrderNo] = useState("");
  const [remark, setRemark] = useState("");
  const [voucher, setVoucher] = useState<string | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("凭证截图不能超过 2MB");
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => setVoucher(reader.result as string));
    reader.readAsDataURL(file);
  }

  function reset() {
    setChannelId("");
    setAmount("");
    setOrderNo("");
    setRemark("");
    setVoucher(null);
  }

  function submit() {
    const amt = Number(amount);
    if (!channelId) return toast.error("请选择渠道");
    if (!Number.isFinite(amt) || amt <= 0) return toast.error("入货金额须 > 0");
    startTransition(async () => {
      const { rechargeChannelAction } = await import("../actions");
      const res = await rechargeChannelAction({
        channelId: Number(channelId),
        amount: amt,
        orderNo,
        remark,
        voucherDataUrl: voucher ?? undefined,
      });
      if (res.error) {
        toast.error("入货失败", { description: res.error });
        return;
      }
      toast.success("已入货");
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <BanknoteIcon /> 入货
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BanknoteIcon /> 渠道入货
          </DialogTitle>
          <DialogDescription>往上游供应商账户充值进货额度，可附支付订单号与凭证截图。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <ChannelSelect value={channelId} onChange={setChannelId} channels={channels} id="cf-channel" />
          <Field>
            <FieldLabel htmlFor="cf-amount">入货金额（元，&gt; 0）</FieldLabel>
            <Input
              id="cf-amount"
              type="number"
              step="0.01"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="cf-order">支付订单号（可选）</FieldLabel>
            <Input
              id="cf-order"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              placeholder="供应商订单号 / 流水号"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="cf-voucher">支付凭证截图（可选，≤2MB）</FieldLabel>
            <Input id="cf-voucher" type="file" accept="image/*" onChange={onFile} />
            {voucher ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={voucher} alt="凭证预览" className="mt-2 max-h-32 rounded border" />
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="cf-remark">备注（可选）</FieldLabel>
            <Input
              id="cf-remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="例如：8月上游充值"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认入货
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ channels }: { channels: ReadonlyArray<ChannelOption> }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [channelId, setChannelId] = useState("");
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState("");

  function reset() {
    setChannelId("");
    setAmount("");
    setRemark("");
  }

  function submit() {
    const amt = Number(amount);
    if (!channelId) return toast.error("请选择渠道");
    if (!Number.isFinite(amt) || amt === 0) return toast.error("调账金额不能为 0");
    startTransition(async () => {
      const { adjustChannelAction } = await import("../actions");
      const res = await adjustChannelAction({
        channelId: Number(channelId),
        amount: amt,
        remark,
      });
      if (res.error) {
        toast.error("调账失败", { description: res.error });
        return;
      }
      toast.success("已调账");
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <ScaleIcon /> 调账
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> 渠道调账
          </DialogTitle>
          <DialogDescription>修正进货额度（正=补入，负=扣减），扣减不能把额度调成负。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <ChannelSelect value={channelId} onChange={setChannelId} channels={channels} id="cf-adj-channel" />
          <Field>
            <FieldLabel htmlFor="cf-adj-amount">调账金额（元，可正负）</FieldLabel>
            <Input
              id="cf-adj-amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例如 -10.5 或 5"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="cf-adj-remark">备注（可选）</FieldLabel>
            <Input
              id="cf-adj-remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="调账原因"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认调账
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
