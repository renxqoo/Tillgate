"use client";

import { useState } from "react";

import { Loader2Icon, ShieldBanIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";

import type { RedeemCodeRow } from "../../types";

const STATUS_LABEL: Record<number, { label: string; tone: string }> = {
  0: { label: "未使用", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  1: { label: "已使用", tone: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
  2: { label: "已撤销", tone: "bg-muted text-muted-foreground" },
  3: { label: "已过期", tone: "bg-muted text-muted-foreground" },
};

function getStatusLabel(status: number): { label: string; tone: string } {
  return (
    STATUS_LABEL[status] ?? {
      label: "未知",
      tone: "bg-muted text-muted-foreground",
    }
  );
}

export function CodesTable({ codes }: { readonly codes: ReadonlyArray<RedeemCodeRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">ID</TableHead>
          <TableHead>兑换码（掩码）</TableHead>
          <TableHead className="w-24">状态</TableHead>
          <TableHead>使用人</TableHead>
          <TableHead className="w-40">使用时间</TableHead>
          <TableHead className="w-40">过期时间</TableHead>
          <TableHead className="w-24 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {codes.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              暂无兑换码
            </TableCell>
          </TableRow>
        ) : (
          codes.map((c) => <CodeRowItem key={c.id} code={c} />)
        )}
      </TableBody>
    </Table>
  );
}

function CodeRowItem({ code }: { code: RedeemCodeRow }) {
  const [pending, setPending] = useState(false);
  const meta = getStatusLabel(code.status);
  const revocable = code.status === 0;

  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">#{code.id}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{code.codeMasked}</code>
      </TableCell>
      <TableCell>
        <span className={"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium " + meta.tone}>
          {meta.label}
        </span>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{code.usedBy ?? "—"}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {code.usedAt ? new Date(code.usedAt).toLocaleString("zh-CN") : "—"}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {code.expiresAt ? new Date(code.expiresAt).toLocaleString("zh-CN") : "—"}
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || !revocable}
          onClick={async () => {
            if (!confirm(`确定撤销兑换码 #${code.id}？`)) return;
            setPending(true);
            const { revokeCodeAction } = await import("../../actions");
            const res = await revokeCodeAction(code.id);
            setPending(false);
            if (res.error) toast.error(res.error);
            else toast.success("已撤销");
          }}
          className="text-destructive hover:text-destructive"
          title={revocable ? "撤销" : "不可撤销"}
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <ShieldBanIcon />}
        </Button>
      </TableCell>
    </TableRow>
  );
}
