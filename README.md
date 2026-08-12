# AI Gateway

多供应商 LLM API 中转站（对外售卖）：统一 OpenAI 兼容入口，双凭证鉴权（静态 Key / 网关签发 JWT），官方价 × 费率卡定价，缓存 token 计价，预扣模式计费，套餐与余额并存。

## 文档（设计已定稿）

| 文档                                         | 内容                          |
| -------------------------------------------- | ----------------------------- |
| [docs/requirements.md](docs/requirements.md) | 业务逻辑与需求（最终评审版）  |
| [docs/data-model.md](docs/data-model.md)     | 数据模型（15+2 张表）         |
| [docs/api-contract.md](docs/api-contract.md) | API 契约（对外 + 管理端）     |
| [docs/tech-stack.md](docs/tech-stack.md)     | 技术选型 / 观测 / 运维 / 安全 |
| [docs/architecture.md](docs/architecture.md) | 架构与流程图（8 张 mermaid）  |
| [docs/ai-package.md](docs/ai-package.md)     | packages/ai 传输层包设计      |

## 仓库结构

```
apps/
  gateway/         # 对外代理（Hono）：/v1/* + /oauth/token + 预扣
  worker/          # BullMQ 消费者：计量结算 / 对账 / 清理
  admin-api/       # 管理端 REST（仅内网）
  client/          # ★ v2 端用户面板（Next.js，端口 3001）—— 见 apps/client/README.md
  admin/           # ★ v2 运营后台（Next.js，端口 3002，role=1 才能进）—— 见 apps/admin/README.md
  console-app-v1/  # ⚠ 已废弃（DEPRECATED）—— 老 console，保留作回滚兜底
packages/
  ui/              # ★ v2 共享 shadcn 原语（60 个）+ 主题 + 字体注册
  api-client/      # ★ v2 共享 admin-api 调用封装（apiFetch / ApiError / formatters）
  tsconfig/        # ★ v2 共享 tsconfig（base + next）
  ai/              # 上游 LLM 传输层（自研，见 docs/ai-package.md）
  money/           # 金额计算（整数厘，防浮点/舍入错误，见 docs/data-model.md §2）
  db/              # Drizzle schema + migrations
  config/          # 环境变量 zod 校验
  logger/          # pino 封装
  otel/            # OTel SDK 初始化
docker/            # compose.yml（生产）+ compose.dev.yml + nginx
docs/              # 设计文档
```

## 快速开始

```bash
pnpm install              # 安装依赖
cp .env.example .env      # 配置环境变量
pnpm db:generate          # 生成 drizzle 迁移（首次）
pnpm db:migrate           # 执行迁移
pnpm dev                  # 启动所有服务（Turborepo 编排，turbo dev）
```

任务编排使用 **Turborepo**（turbo.json）：`pnpm build` / `typecheck` / `test` / `lint` 均走 turbo 缓存（第二次执行 FULL TURBO）；`pnpm dev` 并行启动所有 app。

按需启动单独服务：

```bash
pnpm dev:v1      # 旧的 console-app（已废弃；仅作回滚兜底）
pnpm dev:client  # ★ v2 端用户面板（端口 3001）
pnpm dev:admin   # ★ v2 运营后台（端口 3002）
```

本地开发（仅依赖 Redis + PostgreSQL）：

```bash
docker compose -f docker/compose.dev.yml up -d   # 起 redis + postgres
pnpm dev
```

生产部署：

```bash
pnpm build
docker compose -f docker/compose.yml up -d       # 主服务
docker compose -f docker/compose.yml --profile obs up -d   # 加观测栈
```

## 验证

```bash
pnpm typecheck    # 全仓类型检查
pnpm test         # vitest
pnpm build        # 各包构建
```

## 前端

v2 前端拆成两个独立 Next.js 部署，详见各自 README：

- **用户面板** [`apps/client`](apps/client/README.md)：API Key / 充值码 / 用量 / 账单流水（端口 3001）
- **运营后台** [`apps/admin`](apps/admin/README.md)：用户 / 渠道 / 模型映射 / 费率卡 / 充值码批次 / 统计（端口 3002）

技术栈：Next.js 16.3 + React 19 + Tailwind v4 + shadcn `radix-nova` style + React Hook Form + Zod + TanStack Table 风格的原生 `<Table>` + Sonner + Lucide。视觉/组件跟 [`next-shadcn-admin-dashboard`](https://github.com/ArhamKhan09/studio-admin) 模板同款。

v1 在 [`apps/console-app-v1`](apps/console-app-v1/README.md) 已 DEPRECATED，只是为回滚兜底保留。
