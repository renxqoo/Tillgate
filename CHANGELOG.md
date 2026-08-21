# Changelog

本项目的全部显著变更记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-08-21

首个公开版本。

### Added

- **OpenAI 兼容网关**：`/v1/chat/completions`（流式/非流式）、`/v1/embeddings`、多模态输入，
  另含 Gemini（`/v1beta`）与 Anthropic 原生协议入口；双凭证鉴权（静态 API Key / 网关签发 App JWT）。
- **多供应商传输层**（`packages/ai`）：OpenAI / DeepSeek / MiniMax / 通义千问 / Gemini / Anthropic
  等协议适配，SSE 中继、usage 归一、token 估算器、厂商参数怪癖档案、SSRF 硬门、熔断与换渠重试。
- **渠道路由**：模型映射 × 渠道管理（权重/预算/探活），死凭据准入判定。
- **钱包计费**：双分录账本内核（`packages/wallet`）、幂等三段式预扣授权、8 态结算状态机、
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
