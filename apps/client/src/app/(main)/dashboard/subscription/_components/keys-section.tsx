"use client";

import { useState, useTransition } from "react";

import { KeyRoundIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

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
import { Input } from "@ai-gateway/ui/components/ui/input";
import { formatPoints, POINTS_PER_YUAN } from "@ai-gateway/api-client/formatters";
import { CopyButton } from "@/components/shell/copy-button";

import type { SubKeyRow } from "../types";

/** 元 → 积分展示（去尾零）。 */
function fmtPoints(value: string | null): string | null {
  if (value === null) return null;
  return formatPoints(value).replace(/\.?0+$/, "");
}

/** 订阅页 Key 区块：个人=1 Key+刷新；企业=席位名额+建/删。 */
export function KeysSection({
  keys,
  seats,
}: {
  keys: ReadonlyArray<SubKeyRow>;
  seats: number;
}) {
  const active = keys.filter((k) => k.status === 0);
  const isTeam = seats > 1;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">API Key</div>
          <div className="text-xs text-muted-foreground">
            {isTeam ? `已用 ${active.length} / ${seats} 席位` : "个人套餐 · 1 个 Key"}
          </div>
        </div>
        {isTeam && active.length < seats ? <CreateKeyButton seats={seats} /> : null}
      </div>

      {active.length === 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <KeyRoundIcon className="size-4" />
          {isTeam ? "尚无 Key" : "尚未创建 Key"}
          {!isTeam ? <CreateKeyButton seats={seats} /> : null}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {active.map((k) => (
            <li key={k.id} className="flex items-center gap-2 rounded-md border p-2">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.keyPreview}</code>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{k.name}</span>
              {fmtPoints(k.dailySpendLimit) !== null ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  每日上限 {fmtPoints(k.dailySpendLimit)} 积分
                </span>
              ) : null}
              <div className="flex items-center gap-1">
                {!isTeam ? <RotateKeyButton id={k.id} /> : null}
                <DeleteKeyButton id={k.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RevealKey({ value }: { value: string }) {
  return (
    <div className="rounded-md bg-emerald-500/10 p-3 ring-1 ring-emerald-500/30">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
          明文 Key（请立即复制并安全保存）
        </p>
        <CopyButton text={value} />
      </div>
      <code className="block break-all font-mono text-sm">{value}</code>
    </div>
  );
}

function CreateKeyButton({ seats }: { seats: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dailySpend, setDailySpend] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    if (!name.trim()) {
      toast.error("请输入名称");
      return;
    }
    const points = Number(dailySpend);
    startTransition(async () => {
      const { createSubscriptionKeyAction } = await import("../actions");
      const res = await createSubscriptionKeyAction({
        name,
        // 前端输入积分，后端存元：元 = 积分 / 100
        dailySpendLimit: dailySpend.trim() === "" ? undefined : points / POINTS_PER_YUAN,
      });
      if (res.error || !res.key) {
        toast.error("创建失败", { description: res.error });
        return;
      }
      setRevealed(res.key.key);
      setName("");
      setDailySpend("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setRevealed(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <KeyRoundIcon />
          创建 Key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建新的 API Key</DialogTitle>
          <DialogDescription>明文 Key 仅在创建时显示一次，请妥善保存</DialogDescription>
        </DialogHeader>
        {revealed ? (
          <RevealKey value={revealed} />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">名称</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 production" />
            </div>
            {seats > 1 ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">每日花费上限（积分，留空=不限）</label>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  value={dailySpend}
                  onChange={(e) => setDailySpend(e.target.value)}
                  placeholder="不限"
                />
                <p className="text-xs text-muted-foreground/70">1 元 = {POINTS_PER_YUAN} 积分</p>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{revealed ? "完成" : "取消"}</Button>
          </DialogClose>
          {!revealed ? (
            <Button disabled={pending} onClick={create}>
              {pending && <Loader2Icon className="animate-spin" />}创建
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyButton({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function rotate() {
    startTransition(async () => {
      const { rotateSubscriptionKeyAction } = await import("../actions");
      const res = await rotateSubscriptionKeyAction(id);
      if (res.error || !res.key) {
        toast.error("刷新失败", { description: res.error });
        return;
      }
      setRevealed(res.key.key);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setRevealed(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="刷新（新建并吊销旧 Key）">
          <RefreshCwIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>刷新 Key</DialogTitle>
          <DialogDescription>将吊销旧 Key 并生成新 Key，旧 Key 立即失效</DialogDescription>
        </DialogHeader>
        {revealed ? (
          <RevealKey value={revealed} />
        ) : (
          <p className="text-sm text-muted-foreground">确定刷新此 Key？旧 Key 会立即失效。</p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{revealed ? "完成" : "取消"}</Button>
          </DialogClose>
          {!revealed ? (
            <Button disabled={pending} onClick={rotate}>
              {pending && <Loader2Icon className="animate-spin" />}确认刷新
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteKeyButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();

  function remove() {
    if (!confirm("确定删除此 Key？删除后立即失效。")) return;
    startTransition(async () => {
      const { revokeSubscriptionKeyAction } = await import("../actions");
      const res = await revokeSubscriptionKeyAction(id);
      if (res.error) toast.error("删除失败", { description: res.error });
      else toast.success("已删除");
    });
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive hover:text-destructive"
      disabled={pending}
      onClick={remove}
      title="删除"
    >
      {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
    </Button>
  );
}
