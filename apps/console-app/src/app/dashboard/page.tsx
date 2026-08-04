import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 用户面板（骨架）
 * TODO(console): 登录（OIDC/本地）→ 余额与套餐剩余额度 → Key 管理 → 用量明细 → 充值
 */
export default function DashboardPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>用户面板</CardTitle>
          <CardDescription>余额 / 套餐 / Key / 用量（实现中）</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          登录与数据接入为下一阶段任务（对接 admin-api /api/*）
        </CardContent>
      </Card>
    </main>
  );
}
