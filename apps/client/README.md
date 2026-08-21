# `@ai-gateway/client`

**端用户面板**：API Key / 应用 / 充值码 / 用量 / 账单流水

| 项 | 值 |
|---|---|
| 端口（dev） | `3001` |
| 端口（docker prod） | `3001` |
| 框架 | Next.js 16.3 (App Router) + Turbopack |
| 包管理 | bun 1.4（workspaces + bun.lock） |
| 鉴权 | admin-api HttpOnly Cookie `ag_session` |
| 数据源 | `admin-api` （Hono，默认 8790） |

## 启动

```bash
# 仅启动 client
bun dev:client

# 全栈
bun dev
```

打开 <http://localhost:3001> 即可。

## 路由

| 路径 | 说明 | 是否需要登录 |
|---|---|---|
| `/` | Landing（含"用户面板"+"管理后台"两个入口） | 否 |
| `/login` | 登录页 | 否 |
| `/dashboard` | 仪表盘（余额、费率卡、RPM/TPM、快速入口） | 是 |
| `/dashboard/keys` | API Key 列表 + 创建 + 吊销 | 是 |
| `/dashboard/apps` | OAuth 应用列表 + 创建 | 是 |
| `/dashboard/redeem` | 兑换充值码 + 最近流水 | 是 |
| `/dashboard/usage` | 每次请求的详细记录（含分页） | 是 |
| `/dashboard/transactions` | 完整账单流水（含分页） | 是 |

## 关键文件

```
src/
├── app/
│   ├── layout.tsx                                ← PreferencesStoreProvider + Toaster + ThemeBoot
│   ├── page.tsx                                  ← Landing
│   ├── (auth)/login/{page,form}                  ← 登录页
│   └── (main)/layout.tsx                         ← async RSC 守卫 → AppShell
│       └── dashboard/
│           ├── page.tsx                          ← 仪表盘
│           ├── keys/                             ← keys + actions + 创建对话框
│           ├── apps/                             ← apps + actions
│           ├── redeem/                           ← 兑换 + 最近流水
│           ├── usage/                            ← usage 表 + 分页
│           └── transactions/                     ← 完整流水
├── components/shell/
│   ├── sidebar/{app-sidebar,nav-main,nav-user,support-card}.tsx
│   ├── header/{account-switcher,layout-controls,theme-switcher}.tsx
│   └── copy-button.tsx
└── lib/
    ├── server/get-user.ts                        ← requireMe + userFromMe
    └── server-actions/auth.ts                    ← loginAction / logoutAction
```

## 共享依赖（来自 `packages/`）

- **`@ai-gateway/ui`** — 60 个 shadcn 原语 + 主题系统 + 字体注册
- **`@ai-gateway/api-client`** — `apiFetch` / `ApiError` / `getMe` / formatters

通过 `apps/client/tsconfig.json` 的 `paths` 别名直接引用源码，无需构建。

## 部署

`Dockerfile` 已配好：`output: 'standalone'`，镜像内启动 `node apps/client/server.js`。

```yaml
# docker/compose.yml（已注册）
console-client:
  build:
    context: ..
    dockerfile: apps/client/Dockerfile
  environment:
    CLIENT_API_BASE: http://client-api:8791
  depends_on:
    - client-api
```

生产端口在 `apps/client/package.json` 的 dev/start 脚本固定为 `3001`。
