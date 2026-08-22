# Changelog

本项目的全部显著变更记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 渠道死凭据防护改为「软防护 + 人工裁决」
- 删除「单次 401/403 即落库 status=4 永久退出路由」的硬杀路径（run-chat / generation submit）
- 自动防护由 Redis 软计数承担（连续 3 次阈值路由跳过 + 2h TTL 自愈），阈值翻转发 `channel_dead_credential` 事件
- 网关按 overflow-alert 同款接线投递 `channel_disabled` 告警（通知页零改动可见）
- 管理台渠道状态下拉扩为 启用/降级/禁用/凭据无效（PATCH /channels 本就接受 0-4）
- 换 Key 复位语义修正：仅自动态（熔断/凭据无效）且未显式指定 status 时归 0——手动禁用/降级的渠道不再因轮换密钥被复活
- repo 层 markDeadCredential 死方法移除

### Added

- **全栈中英文国际化（i18n）**：默认英文，支持中英文切换。
  - 前端：next-intl 4（无路由 cookie 模式，`NEXT_LOCALE`），语言解析链 cookie → 浏览器
    Accept-Language → 默认英文；两控制台顶栏新增语言切换器；`<html lang>`、页面标题与
    全部界面文案按语言 SSR 渲染。
  - 后端：错误码注册表全量双语（`zh` 字段），错误出口按请求 `Accept-Language` 协商——
    与注册表默认文案一致的静态文案出对应语言，调用点自定义/动态文案保持原文（英文行为零变化）；
    会话 401 文案统一（防账号枚举口径）并双语；登录验证码邮件按触发请求语言双语渲染。
  - BFF：`apiFetch`/`adminFetch` 注入与 UI 同源的 `Accept-Language`，toast 错误语言与界面一致。
  - 门禁：`bun run check:i18n`（AST 扫描零 CJK 字面量残留 + en/zh 目录键完备 + 共享 ui 段同源），
    已接入 CI。
- 用户面板「接口调用」指南页：端点速查表、curl/Python/JS 示例（真实 Base URL、GitHub 风格
  shiki 双主题代码框、一键复制）。
- 配置体系重构：`.env.example` 收敛为必填 6 键模板，其余键在 `config.ts` 带最优默认值；
  `PORT`/`BODY_LIMIT_BYTES` 按服务消歧（`GATEWAY_`/`CLIENT_`/`ADMIN_` 前缀）；新增
  `docs/configuration.md` 全键参考；网关护栏与实例标识键（`KEY_PREFIX`、`JWT_ISSUER` 等）env 化。

### Fixed

- 网关请求护栏与实例标识硬编码：body 上限、上传白名单/大小、结算信号重试、Key 前缀、
  JWT issuer/audience 全部可 env 覆盖（带安全默认值）。
- trace 接收端令牌闭环：健康探针（`/readyz` `/livez`）豁免令牌校验（生产 healthcheck 曾
  永久 401）；OTLP 推送端自动携带 `TRACE_RECEIVER_TOKEN`（启用令牌后 span 曾被静默 401 丢弃）。
- 营销配置（邀请奖励/佣金比例）测试期间被重置为基线——共享 dev 库单行表改快照/恢复模式。
- 管理台仪表盘：每日费用/请求量趋势图无数据——前端误用 `/v1/stats/usage`（按用户/模型/渠道
  维度聚合）且字段名不匹配；新增 `/v1/stats/trends` 按日聚合端点（北京时间日界）。
- 管理台仪表盘：今日请求成功率显示 10000.0%——后端已返回百分数，前端重复乘 100。
- 概览「今日」口径：日界由 UTC 零点改为北京时间零点。
- 用户面板仪表盘：「每日费用趋势」实为伪造——前端拿按模型聚合的近 30 天总额冒充
  「今日消耗」并造单点序列；改接 `/v1/usage/summary` 真按日数据（近 14 天），
  `summarizeByDay` 日界同步改为北京时间。

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
