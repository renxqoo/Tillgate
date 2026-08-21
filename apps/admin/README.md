# `@ai-gateway/admin`

**运营后台**：用户 / 渠道 / 模型映射 / 费率卡 / 充值码批次 / 统计

| 项 | 值 |
|---|---|
| 端口（dev） | `3002` |
| 端口（docker prod） | `3002` |
| 框架 | Next.js 16.3 (App Router) + Turbopack |
| 鉴权 | admin-api HttpOnly Cookie + `role === 1` 守卫 |
| 数据源 | `admin-api` （Hono，默认 8790），端点全在 `/api/admin/*` |

## 启动

```bash
bun dev:admin
# 打开 http://localhost:3002
```

## 路由

| 路径 | 说明 | 是否需要 admin |
|---|---|---|
| `/` | Landing（含"登录后台"+"用户面板"两个入口） | 否 |
| `/login` | 登录页（仅限 admin） | 否 |
| `/dashboard` | 仪表盘（4 KPI + 渠道健康） | 是 |
| `/dashboard/users` | 用户列表 + 搜索 + 封禁/解封 | 是 |
| `/dashboard/channels` | 渠道列表 + 新建 + 测试连通性 + 删除 | 是 |
| `/dashboard/models` | 模型映射列表 + 新建 + 删除 | 是 |
| `/dashboard/rate-cards` | 费率卡列表 + 新建 + 删除 | 是 |
| `/dashboard/redeem-batches` | 充值码批次列表 + 生成 + 一次性复制 | 是 |

## 角色门（hard gate）

`(main)/layout.tsx` 用 `requireAdmin()` 守卫：

```ts
const me = await getMe();
if (!me) redirect('/login');            // 未登录 → /login
if (me.role !== 1)                      // 非 admin → 跳回 client 用户面板
  redirect('http://localhost:3001/dashboard');
```

未授权访问任何 `/dashboard/*` 都会跳走。

## 关键文件

```
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                                  ← Landing
│   ├── (auth)/login/{page,form}                  ← 仅 admin
│   └── (main)/layout.tsx                         ← async RSC requireAdmin + AppShell
│       └── dashboard/
│           ├── page.tsx                          ← 4 KPI + 渠道健康
│           ├── users/{page,actions,_components/users-content}
│           ├── channels/{page,actions,_components/channels-content}
│           ├── models/{page,actions,_components/models-content}
│           ├── rate-cards/{page,actions,_components/rate-cards-content}
│           └── redeem-batches/{page,actions,_components/redeem-batches-content}
├── components/shell/{sidebar,header}/
├── lib/
│   ├── server/get-user.ts                        ← requireAdmin
│   └── server-actions/auth.ts                    ← loginAction / logoutAction
```

每个业务页面都是 `page.tsx` (server) + `_components/...-content.tsx` (client) + `actions.ts` (server actions) 三件套。Dialogs/Forms 用 React Hook Form + Zod；mutation 用 Server Action + `revalidatePath`；反馈用 sonner `toast`。

## 数据契约

所有 admin 路由在 `admin-api/src/routes/` 下，schema 在每个文件顶部，与 `apps/admin/src/app/(main)/dashboard/*/actions.ts` 中的 `*Row` 类型一一对应。

例如 `/api/admin/stats/overview`：

```ts
interface StatsOverview {
  todayRequests: number;
  todayCost: string;          // DB numeric（元）
  todayInputTokens: number;
  todayOutputTokens: number;
  channelHealth: Array<{ id: number; name: string; healthy: boolean; lastError?: string }>;
}
```

## 部署

同 client，Dockerfile 镜像启动 `node apps/admin/server.js`。
