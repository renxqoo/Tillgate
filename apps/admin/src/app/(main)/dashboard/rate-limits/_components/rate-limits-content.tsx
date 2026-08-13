"use client";

import { useState, useTransition } from "react";
import { GaugeIcon, PencilIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ai-gateway/ui/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@ai-gateway/ui/components/ui/tabs";

import { updateRateLimitAction } from "../actions";
import type { RateLimitItem, RateLimitKind } from "../types";

function fmtLimit(v: number | null): string {
  return v === null ? "不限" : v.toLocaleString();
}

function RateLimitTable({
  items,
  kind,
  onEdit,
}: {
  items: RateLimitItem[];
  kind: RateLimitKind;
  onEdit: (kind: RateLimitKind, item: RateLimitItem) => void;
}) {
  if (items.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">暂无数据</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          <TableHead className="text-center">状态</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((it) => (
          <TableRow key={`${kind}-${it.id}`}>
            <TableCell>
              <div className="font-medium">{it.label}</div>
              {it.sublabel ? (
                <div className="font-mono text-xs text-muted-foreground">{it.sublabel}</div>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmtLimit(it.rpmLimit)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtLimit(it.tpmLimit)}</TableCell>
            <TableCell className="text-center">
              {it.status === 0 ? (
                <span className="text-xs text-emerald-600">正常</span>
              ) : (
                <span className="text-xs text-destructive">停用</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm" onClick={() => onEdit(kind, it)}>
                <PencilIcon className="size-3.5" />
                编辑
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RateLimitsClient({
  users,
  models,
  channels,
  keys,
}: {
  users: RateLimitItem[];
  models: RateLimitItem[];
  channels: RateLimitItem[];
  keys: RateLimitItem[];
}) {
  const [editing, setEditing] = useState<{ kind: RateLimitKind; item: RateLimitItem } | null>(null);
  const [rpm, setRpm] = useState<string>("");
  const [tpm, setTpm] = useState<string>("");
  const [pending, startTransition] = useTransition();

  const openEdit = (kind: RateLimitKind, item: RateLimitItem) => {
    setEditing({ kind, item });
    setRpm(item.rpmLimit === null ? "" : String(item.rpmLimit));
    setTpm(item.tpmLimit === null ? "" : String(item.tpmLimit));
  };

  const save = () => {
    if (!editing) return;
    const rpmVal = rpm.trim() === "" ? null : Number(rpm);
    const tpmVal = tpm.trim() === "" ? null : Number(tpm);
    if (rpmVal !== null && (!Number.isFinite(rpmVal) || rpmVal <= 0 || !Number.isInteger(rpmVal))) {
      toast.error("RPM 须为正整数");
      return;
    }
    if (tpmVal !== null && (!Number.isFinite(tpmVal) || tpmVal <= 0 || !Number.isInteger(tpmVal))) {
      toast.error("TPM 须为正整数");
      return;
    }
    startTransition(async () => {
      const res = await updateRateLimitAction(editing.kind, editing.item.id, rpmVal, tpmVal);
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success("已保存，立即生效");
        setEditing(null);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="user">
        <TabsList>
          <TabsTrigger value="user">用户 ({users.length})</TabsTrigger>
          <TabsTrigger value="model">模型 ({models.length})</TabsTrigger>
          <TabsTrigger value="channel">渠道 ({channels.length})</TabsTrigger>
          <TabsTrigger value="key">Key ({keys.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="user">
          <RateLimitTable items={users} kind="user" onEdit={openEdit} />
        </TabsContent>
        <TabsContent value="model">
          <RateLimitTable items={models} kind="model" onEdit={openEdit} />
        </TabsContent>
        <TabsContent value="channel">
          <RateLimitTable items={channels} kind="channel" onEdit={openEdit} />
        </TabsContent>
        <TabsContent value="key">
          <RateLimitTable items={keys} kind="key" onEdit={openEdit} />
        </TabsContent>
      </Tabs>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GaugeIcon className="size-4" />
              编辑限流
            </DialogTitle>
            <DialogDescription>
              {editing ? `${editing.item.label}（留空 = 不限流，继承上层）` : ""}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>RPM（每分钟请求数）</FieldLabel>
              <Input
                type="number"
                min={1}
                placeholder="不限"
                value={rpm}
                onChange={(e) => setRpm(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>TPM（每分钟 Token 数）</FieldLabel>
              <Input
                type="number"
                min={1}
                placeholder="不限"
                value={tpm}
                onChange={(e) => setTpm(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={pending}>
              取消
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
