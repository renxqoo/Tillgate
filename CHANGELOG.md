# Changelog

本项目的全部显著变更记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed —— v2 monorepo 结构重构

- 仓库按 [docs/project-structure-refactoring.md](docs/project-structure-refactoring.md) 从 v1
  （ai-getway）重构为 **7 应用 + 14 能力包**：业务能力按真实边界聚合为
  `errors / runtime / db / http / identity / accounts / billing / ai / inference / control-plane /
  notifications / observability / api-client / ui`，包内统一 `domain / application / ports /
  adapters` 分层；应用（gateway / client-api / admin-api / worker / trace-receiver / client /
  admin）收敛为薄装配单元（配置 + HTTP 壳 + 接线）。
- `packages/wallet` + `ledger-core` + `money` 合并为 `packages/billing`——资金与计费唯一事实源
  （ADR-0003）；`packages/errors` 成为内部错误根契约（三性根类 + 错误目录 + 规范化记录，
  ADR-0001）；`packages/ai` 独立库化——零内部依赖的永久叶子包，`onEvent` 观察面与装配注入契约
  （ADR-0006 / ADR-0007）。
- 包边界由 `scripts/check-package-boundaries.ts` 在 CI 强制执行：package graph 无环、
  packages 不依赖 apps、跨包 import 只允许命中显式 `exports` 子路径、禁 `*/src` 深导入。
- 测试体系收敛：包内测试统一 `__test__/` 平铺，真实 PG/凭证用例以 `*.real.test.ts` 分门；
  跨进程系统测试集中根 `e2e/` 目录（mock / real / smoke / 子目录四个门）。

### Added

- 架构决策记录体系 `docs/adr/`（0001–0007，编号递增、只进不出）。
- 开源文档补齐：中英 README、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT、LICENSE、issue/PR 模板。
- 运维与导读文档：configuration / deployment-checklist / ha-deployment / observability /
  api-contract / tech-stack / billing-flow-deep-dive / gateway-pipeline 等（自 v1 同名文档适配）。
- GitHub Actions 主门禁 `ci.yml`（typecheck / lint / build / test 四门 + 覆盖率门禁），
  与镜像发布 `docker-publish.yml` 并行。

### 渠道死凭据防护改为「软防护 + 人工裁决」（随 v1 收口迁入）

- 自动防护由 Redis 软计数承担（连续 3 次阈值路由跳过 + 2h TTL 自愈），阈值翻转发
  `channel_dead_credential` 事件；网关投递 `channel_disabled` 告警。
- 管理台渠道状态下拉扩为 启用/降级/禁用/凭据无效；换 Key 复位仅作用于自动态
  （熔断/凭据无效）——手动禁用/降级的渠道不因轮换密钥被复活。

### Added —— v1 收口功能（随迁移进 v2）

- **全栈中英文国际化（i18n）**：前端 next-intl 4（无路由 cookie 模式，默认英文）；后端错误码
  注册表全量双语（`zh` 字段），错误出口按请求 `Accept-Language` 协商；BFF 注入同源语言头。
- 用户面板「接口调用」指南页：端点速查表、curl/Python/JS 示例、一键复制。
- 配置体系：`.env.example` 收敛为必填键模板，其余键在各 `config.ts`（zod schema）带最优默认值；
  全键参考见 [docs/configuration.md](docs/configuration.md)。

### Fixed —— v1 收口修复（随迁移进 v2）

- 网关请求护栏与实例标识硬编码：body 上限、上传白名单/大小、结算信号重试、Key 前缀、
  JWT issuer/audience 全部可 env 覆盖（带安全默认值）。
- trace 接收端令牌闭环：健康探针豁免令牌校验；OTLP 推送端自动携带 `TRACE_RECEIVER_TOKEN`。
- 管理台仪表盘：趋势图接 `/v1/stats/trends`（北京时间日界）；今日请求成功率重复乘 100 修正；
  概览「今日」口径日界改为北京时间零点。
- 用户面板仪表盘「每日费用趋势」改接 `/v1/usage/summary` 真按日数据（近 14 天）。

## [0.1.0] - 2026-08-21

首个公开版本。

### Added

- **OpenAI 兼容网关**：`/v1/chat/completions`（流式/非流式）、`/v1/embeddings`、多模态输入，
  另含 Gemini（`/v1beta`）与 Anthropic 原生协议入口；双凭证鉴权（静态 API Key / 网关签发 App JWT）。
- **多供应商传输层**（`packages/ai`）：OpenAI / DeepSeek / MiniMax / 通义千问 / Gemini / Anthropic
  等协议适配，SSE 中继、usage 归一、token 估算器、厂商参数怪癖档案、SSRF 硬门、熔断与换渠重试。
- **渠道路由**：模型映射 × 渠道管理（权重/预算/探活），死凭据准入判定。
- **钱包计费**：双分录账本内核、幂等三段式预扣授权、8 态结算状态机、
  资金来源瀑布（订阅额度 → PAYG 余额）、崩溃恢复与对账回收。
- **订阅体系**：套餐 / 费率卡 / 免费日限 / 升降级 / 充值码与邀请返利。
- **API Key 体系**：RPM/TPM 限额、按 Key 日限额、模型白名单、组织成员计费。
- **支付**：EPAY / Stripe 在线充值。
- **异步生成**：视频 / 音乐任务提交、轮询与回调结算。
- **可观测**：OTLP 链路追踪（接收端 + 拓扑视图）、双向首 token 延迟 TTFT（上游/客户端 P50+P95）、
  usage / request / audit 三类日志与运营统计。
- **韧性**：Redis Sentinel 支持；Redis 故障三档降级（限流 fail-open / 爆破 degraded / 免费日限
  fail-closed）；结算唤醒走 PG LISTEN/NOTIFY（无队列中间件依赖）。
- **双控制台**：运营后台（渠道/模型/费率/用户/支付/观测）与用户面板（Key/用量/订阅/充值），
  Next.js 16 + React 19 + Tailwind v4 + shadcn/ui。
- **部署**：单机生产 compose 与单机 HA 形态（`docker/compose.ha.yml`，见 docs/ha-deployment.md）。
- **工具链**：bun 1.4 全链（install/build/test/dev）+ Turborepo 缓存，GitHub Actions CI 四门门禁。

### Performance

- bun 运行时基准（同代码 A/B）：依赖安装 3.8×、构建 49×、测试 4.8×；网关吞吐约 2×
  （39k vs 22k req/s，p99.99 19ms）；饱和负载下平台内存 445MB 收敛（对照运行时不收敛）。
  详见 [docs/benchmark-2026-08-21-bun-vs-node.md](docs/benchmark-2026-08-21-bun-vs-node.md)。
