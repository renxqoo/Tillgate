"use client";

import { Loader2Icon, ShieldBanIcon } from "lucide-react";
import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";

import type { RedeemCodeRow } from "@ai-gateway/api-client/types";
import { fmtDateTime } from "@ai-gateway/api-client/formatters";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill, defineStatusMeta } from "@ai-gateway/ui/components/status-pill";

const STATUS_LABEL = defineStatusMeta({
  0: { label: "未使用", tone: "success" },
  1: { label: "已使用", tone: "info" },
  2: { label: "已撤销", tone: "neutral" },
  3: { label: "已过期", tone: "neutral" },
});

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
  const meta = STATUS_LABEL.get(code.status);
  const revocable = code.status === 0;

  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">#{code.id}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{code.codeMasked}</code>
      </TableCell>
      <TableCell>
        <StatusPill tone={meta.tone} label={meta.label} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{code.usedBy ?? "—"}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {fmtDateTime(code.usedAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {fmtDateTime(code.expiresAt)}
      </TableCell>
      <TableCell className="text-right">
        <ConfirmAction
          confirm={`确定撤销兑换码 #${code.id}？`}
          action={async () => (await import("../../actions")).revokeCodeAction(code.id)}
          success="已撤销"
        >
          {({ pending, onClick }) => (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || !revocable}
              onClick={onClick}
              className="text-destructive hover:text-destructive"
              title={revocable ? "撤销" : "不可撤销"}
            >
              {pending ? <Loader2Icon className="animate-spin" /> : <ShieldBanIcon />}
            </Button>
          )}
        </ConfirmAction>
      </TableCell>
    </TableRow>
  );
}
