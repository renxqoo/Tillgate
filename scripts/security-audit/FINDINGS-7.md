# 第七轮收尾清偿 · 修复记录（FINDINGS-7）—— 直接修复项全部完成

> 日期：2026-08-15（第七轮）。范围：第六轮盘点中「工程收尾 / 验证债务 / 从未覆盖领域」
> 里可直接修复的全部事项。验收：`pnpm test --force` 14/14 包、typecheck/lint 17/17、
> **验证债务清偿**（脚本 20/21 时隔两轮改动后复跑全绿）、实弹脚本 19/22/23/24 全绿、
> `pnpm audit --prod` 零漏洞。**本轮改动未提交**（等待用户允许）。

## 7.1 验证债务清偿

- 脚本 **20**（临界值扣费七场景，含 S3 上游超发 10 次重试退避）复跑 **exit 0**；
- 脚本 **21**（真实模型对账：deepseek 20 并发 / MiniMax-M3 / 免费模型）复跑 **exit 0**
  （新账号 11025-11027，零充值）。
- 五、六轮的账本（bad_debt 删除 / auto-release 白名单删除）与管线（免费限额 / 脱敏 /
  fallback 限流维）改动确认无回归。

## 7.2 依赖漏洞（首次 pnpm audit）

- 生产依赖：**1 high**（nanoid<3.3.18，经 next>postcss 传递）→ `pnpm-workspace.yaml`
  `overrides: nanoid: 3.3.18` 精确钉版 → **`pnpm audit --prod` 零漏洞**。
- dev 依赖残留（接受并记录）：esbuild ≤0.24.2 / 0.25-0.27 两条 advisory，全部来自
  drizzle-kit 工具链（`@esbuild-kit/*`），只在本机 `db:generate` 时使用，不随任何产物
  发布、不监听端口（esbuild dev-server advisory 不适用于 build 场景）。
- 踩坑记档：pnpm 11 的 overrides 必须写在 `pnpm-workspace.yaml`（package.json 的
  `pnpm.overrides` 无效）；开放范围 `>=3.3.18` 会解析到 nanoid 6（postcss 声明 ^3，
  有破坏风险）——overrides 应钉精确版本。

## 7.3 login/logout CSRF 收口（C7，原挂账项）

用户面与管理面的公开认证组（/api/auth/login|logout、/api/admin/auth/*）挂上与受保护组
同款的 `csrfProtection`（受信 Origin / INTERNAL_API_TOKEN 双缺失头兼容规则）——
跨站表单不能再强制受害者「登入攻击者账号」或被登出。前提是第六轮已让 BFF 与审计脚本
具备令牌注入能力，浏览器合法登录带受信 Origin 不受影响。
测试：`auth-login-csrf.red.test.ts`（evil Origin 403 / 受信 Origin 200 / 无 Origin 走凭证校验）；
既有登录限流 4 用例在兼容规则下不回归。

## 7.4 前端入口补齐

- **org 待接受邀请列表 + 撤销**：GET /orgs/:id 对 owner 返回 pending 邀请（不含 token——
  链接只在邀请时下发一次）；前端 owner 视图新增「待接受邀请」区块与撤销按钮
  （server action → 新撤销路由）。与第五轮的待接受上限（min(剩余席位×2,20)）闭环。
- **admin 用户交易时间筛选**：`/api/admin/users/:id/transactions` 的 from/to（第五轮
  后端已支持）补上 UI——日期范围 GET 表单（纯服务端渲染，参数白名单 YYYY-MM-DD），
  带清除入口。
- 免费模型 429 无需前端改动（错误面向 SDK 调用方，响应体自描述）。

## 7.5 两个 Next.js 面板安全头（原「从未覆盖」项）

next.config（admin/client 同款）：`X-Frame-Options: DENY`、`X-Content-Type-Options:
nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`
（相机/麦克风/地理全禁）、保守 CSP（`default-src 'self'`；script/style 留
'unsafe-inline'——Next 水合必需；`frame-ancestors 'none'`、`base-uri/form-action 'self'`）。
API 面由 hona securityHeaders 覆盖（早已有），本次补齐浏览器面板。

## 7.6 分区漂移警示 + 部署检查清单

- `packages/db/src/schema/logs.ts` 顶部加警示：request_logs 实际是分区母表（迁移 0040），
  **不要对该表跑 db:generate**，变更必须手写迁移。
- 新增 `docs/deployment-checklist.md`：环境变量必配表（TRUSTED_PROXY_HOPS /
  INTERNAL_API_TOKEN / WORKER_HEALTH_TOKEN / 双 JWT 密钥规则…）、网络边界（8792/8793
  不对公网）、密钥轮换四步、PG 备份与恢复演练、监控告警项、容量公式、上线 5 分钟自检。

## 剩余挂账（更新后全量）

| 项 | 类别 |
|---|---|
| maker-checker 职责分离 | 产品设计（角色模型+审批流） |
| 管理员 2FA | 产品/架构决策 |
| 单会话吊销粒度（会话表/jti 清单） | 架构决策 |
| 免费额度阈值产品化 + 目录价漂移自动下线 | 产品策略（工程默认 500/天已生效） |
| 加密轮换 v3 世代（key 链） | 待第一次轮换实际发生再评估 |
| 备份/恢复演练执行、生产压测 | 运维执行项（清单已给） |
| 免费限额 UTC 日界 | 产品细节（如需东八区日界一行改） |
