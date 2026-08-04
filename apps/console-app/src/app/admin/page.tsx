import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 管理后台（骨架）
 * TODO(console): 用户 / 渠道 / 模型 / 费率卡 / 充值码 / 报表（对接 admin-api，仅内网）
 */
export default function AdminPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>管理后台</CardTitle>
          <CardDescription>运营管理功能（实现中）</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          路由与数据接入为下一阶段任务（admin-api 仅内网可达）
        </CardContent>
      </Card>
    </main>
  );
}
