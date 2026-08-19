# AI Gateway

多供应商 LLM API 中转站：统一 OpenAI 兼容入口，双凭证鉴权（静态 Key / 网关签发 JWT），官方价 × 费率卡定价，缓存 token 计价，预扣模式计费（DB 权威账本）。

## 文档（设计已定稿）

| 文档                                         | 内容                          |
| -------------------------------------------- | ----------------------------- |
| [AGENT.md](AGENT.md)                         | **工作规则**（AI 协作铁律、分层/资金域规范） |
| [CHANGELOG.md](CHANGELOG.md)                 | **修复与演进日志**（审计历史、施工留痕） |
| [docs/requirements.md](docs/requirements.md) | 业务逻辑与需求（最终评审版）  |
| [docs/data-model.md](docs/data-model.md)     | 数据模型（含 billing_requests）  |
| [docs/billing-flow-deep-dive.md](docs/billing-flow-deep-dive.md) | **v2 扣款全流程**（预扣/实扣公式、刷费用五向量防线） |
| [docs/api-contract.md](docs/api-contract.md) | API 契约（对外 + 管理端）     |
| [docs/tech-stack.md](docs/tech-stack.md)     | 技术选型 / 观测 / 运维 / 安全 |
| [docs/architecture.md](docs/architecture.md) | 架构与流程图                  |
| [docs/ai-package.md](docs/ai-package.md)     | packages/ai 传输层包设计      |

## 仓库结构

```
apps/
  gateway/         # 对外代理（Hono）：/v1/* + /oauth/token + 预扣（组件化管线）
  worker/          # BullMQ 消费编排（结算/对账领域逻辑在 packages/ledger）
  admin-api/       # 管理端 REST（仅内网）
  client-api/      # 用户面 REST（仅内网）
  client/          # 端用户面板（Next.js，端口 3001）—— 见 apps/client/README.md
  admin/           # 运营后台（Next.js，端口 3002）—— 见 apps/admin/README.md
packages/
  core/            # 共享基础设施：环境变量校验 + 日志 + OTel + 对称加密
  wallet/          # 资金钱包内核（唯一资金事实源：复式账本 + 两阶段冻结 + tx 注入 +
  #                 allowCredit 现金口径）+ metering 计费公式（元 + decimal 全精度，永不 round）
  ledger/          # 账本领域（单包六域 + platform）：rating 计价 / subscription 套餐与额度 /
  #                 channel-budget 渠道运营资金 / billing 计费状态机（钱包之上） /
  #                 settlement worker 编排 / migration 开账迁移 —— 见 docs/plan-ledger-rewrite.md
  ledger-core/     # 通用幂等操作内核（operationId + canonical 指纹 + 回执重放）
  db/              # Drizzle schema + migrations + seed 脚本
  ai/              # 上游 LLM 传输层（自研，见 docs/ai-package.md）
  ui/              # 共享 shadcn 原语 + 主题 + 字体注册（前端用）
  api-client/      # 共享 REST 调用封装（apiFetch / ApiError / formatters，前端用）
  identity/        # 会话/JWT/鉴权（admin-api/client-api 共用，双身份物理隔离）
  identity-core/   # 身份内核（会话锚点 + 验证码挑战）
docker/            # compose.yml（生产）+ compose.dev.yml + nginx
docs/              # 设计文档
```

TypeScript 配置收敛在根目录：`tsconfig.base.json`（后端）+ `tsconfig.next.json`（前端/React）。

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
pnpm dev:gateway   # 对外代理（端口 8787）
pnpm dev:worker    # 计量结算消费者
pnpm dev:client    # 端用户面板（端口 3001）
pnpm dev:admin     # 运营后台（端口 3002）
pnpm dev:admin-api # 管理端 REST（8790，仅内网）
pnpm dev:client-api# 用户面 REST（8791，仅内网）
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

### 企业计费状态机迁移（billing_requests）

迁移 0011 会删除旧 `billing_holds`，不提供双轨兼容。发布前必须停流量，并确认：
`SELECT count(*) FROM billing_holds WHERE status='held'` 返回 0。随后运行迁移，先启动 worker，
再启动 gateway。新流程为足额授权 → 上游 lease → durable receipt → DB drain 结算；BullMQ 只做唤醒。

## 验证

```bash
pnpm typecheck    # 全仓类型检查
pnpm test         # vitest
pnpm build        # 各包构建
```

## 前端

两个独立 Next.js 部署，详见各自 README：

- **用户面板** [`apps/client`](apps/client/README.md)：API Key / 充值码 / 用量 / 账单流水（端口 3001）
- **运营后台** [`apps/admin`](apps/admin/README.md)：用户 / 渠道 / 模型映射 / 费率卡 / 充值码批次 / 统计（端口 3002）

技术栈：Next.js 16.3 + React 19 + Tailwind v4 + shadcn `radix-nova` style + React Hook Form + Zod + TanStack Table 风格的原生 `<Table>` + Sonner + Lucide。视觉/组件跟 [`next-shadcn-admin-dashboard`](https://github.com/ArhamKhan09/studio-admin) 模板同款。
