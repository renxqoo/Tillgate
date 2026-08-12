import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  fmtBalance,
  fmtDateTime,
  type AdminRateCardRow,
  type AdminUserRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RateCardDetailPage({ params }: PageProps) {
  const { id } = await params;
  const rcId = Number(id);
  if (!Number.isFinite(rcId) || rcId <= 0) notFound();

  let card: AdminRateCardRow | null = null;
  let error: string | null = null;
  try {
    // 后端没有单条 GET /:id，从列表里找
    const list = await adminFetch<ListResult<AdminRateCardRow>>("/api/admin/rate-cards");
    card = list.list.find((c) => c.id === rcId) ?? null;
    if (!card) notFound();
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  let users: AdminUserRow[] = [];
  try {
    const data = await adminFetch<ListResult<AdminUserRow>>(
      `/api/admin/rate-cards/${rcId}/users`,
    );
    users = data.list ?? [];
  } catch {
    // 失败不阻塞
  }

  if (!card) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/dashboard/rate-cards">
            <ArrowLeftIcon /> 返回费率卡
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{error ?? "费率卡不存在"}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/dashboard/rate-cards">
          <ArrowLeftIcon /> 返回费率卡
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            {card.name}{" "}
            <span className="text-base font-normal text-muted-foreground">×{card.coefficient}</span>
          </CardTitle>
          <CardDescription>
            {card.description ?? "无说明"} · 状态 {card.status === 0 ? "启用" : "禁用"} · 更新于{" "}
            {fmtDateTime(card.updatedAt)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            共绑定 {users.length} 个用户
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">ID</TableHead>
                <TableHead>账号</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead className="text-right">余额（元）</TableHead>
                <TableHead className="w-44">最近登录</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    暂无绑定用户
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">#{u.id}</TableCell>
                    <TableCell className="font-medium">{u.subject}</TableCell>
                    <TableCell className="text-muted-foreground">{u.displayName ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.email ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBalance(u.balance)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("zh-CN") : "从未"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
