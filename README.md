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
  gateway/     # 对外代理（Hono）：/v1/* + /oauth/token + 预扣
  worker/      # BullMQ 消费者：计量结算 / 对账 / 清理
  admin-api/   # 管理端 REST（仅内网）
  console/     # Next.js 控制台（用户面板 + 管理后台）
packages/
  ai/          # 上游 LLM 传输层（自研，见 docs/ai-package.md）
  db/          # Drizzle schema + migrations
  config/      # 环境变量 zod 校验
  logger/      # pino 封装
  otel/        # OTel SDK 初始化
docker/        # compose.yml（生产）+ compose.dev.yml + nginx
docs/          # 设计文档
```

## 快速开始

```bash
pnpm install              # 安装依赖
cp .env.example .env      # 配置环境变量
pnpm db:generate          # 生成 drizzle 迁移（首次）
pnpm db:migrate           # 执行迁移
pnpm dev                  # 启动所有服务（Turborepo 编排，turbo dev）
```

任务编排使用 **Turborepo**（turbo.json）：`pnpm build` / `typecheck` / `test` / `lint` 均走 turbo 缓存（第二次执行 FULL TURBO）；`pnpm dev` 并行启动四端（gateway/worker/admin-api/console）。

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
