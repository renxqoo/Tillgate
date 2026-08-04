import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">AI Gateway 控制台</h1>
        <p className="mt-2 text-muted-foreground">
          多供应商 LLM API 中转站 · 用户面板与运营后台（脚手架阶段）
        </p>
      </div>

      <div className="grid w-full max-w-2xl gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>用户面板</CardTitle>
            <CardDescription>余额 / 套餐 / Key 管理 / 用量明细 / 充值</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/dashboard">进入面板</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>管理后台</CardTitle>
            <CardDescription>用户 / 渠道 / 模型 / 费率卡 / 充值码 / 报表</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin">进入后台</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        设计文档见仓库 docs/ 目录 · shadcn/ui 已就绪（Tailwind v4 + React 19 + Next 16）
      </p>
    </main>
  );
}
