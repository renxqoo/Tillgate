# 第三方集成动态配置（integration-settings）设计方案

- 状态：**草稿**（定稿后推进到「已实施」；实现推翻本设计时先改本文再改代码）
- 分级：**大级**（跨包 control-plane / identity / billing / db / 四个后端 app + admin 前端；资金域触碰；公共契约变化：identity 配置契约、admin API 新端点、能力端点语义；不可逆迁移：env 凭据删除）
- 分支：`feat/integration-settings`（worktree `../TokenLens-v2-intsettings`）
- 配套施工图：[IMPLEMENTATION.md](./IMPLEMENTATION.md)

## 0. 用户裁决记录（2026-08-25）

| 分叉 | 裁决 |
| --- | --- |
| 支付凭据（EPAY/Stripe）是否纳入 | **一并纳入**——接受大级方案重量与 webhook 轮换双读窗 |
| env → DB 迁移语义 | **一次性导入脚本 + 删除 env 键**（单一真相 = DB，无运行时 env 兜底） |
| Turnstile 人机验证 | **纳入并带加固**（方案 A：审计高亮 + 关闭时营销联动警告） |
| admin UI 形态 | 与 `/dashboard/settings` 现有卡片风格一致；**设置按钮放卡片右上方、与标题对齐** |

## 1. 背景与目标

第三方集成凭据（GitHub/Google OAuth、SMTP、易支付、Stripe、Turnstile）目前全部经
env 在**进程装配期一次性注入**并冻结：换 key、开关注册防刷、启停登录方式都要改
env 并重启全部相关进程。仓库已完成的同类迁移（channels 渠道凭据、notification
channels、marketing_settings）证明「DB 动态配置 + 加密落库 + 审计」是既定演进方向；
本设计把剩余的静态集成凭据收口到同一形态。

**目标**：

1. admin 管理端 `/dashboard/settings` 可视化配置全部第三方集成凭据，改后最迟
   60 秒全进程生效，无需重启；
2. 每个集成可独立**动态启用/停用**，前端能力面（登录按钮、注册防刷、充值渠道）
   随之实时显隐；
3. secret 加密落库（`enc:v1`）、回显脱敏、写入留同事务审计；
4. env 中对应键删除，单一真相 = DB（一次性导入脚本承接存量部署）。

**非目标（不处理，归属写明）**：

- AI 上游渠道凭据（`channels.api_key_enc`）——已是 DB 动态配置，不动；
- 告警通知渠道（`notification_channels`）——已是 DB 动态配置，不动（其 SMTP
  通道参数随本设计动态化）；
- 无凭据外部源（models.dev 快照、OpenRouter 目录、frankfurter 汇率、自托管
  OTel）——无 secret，维持 env；
- 部署拓扑与策略开关（`OAUTH_STATE_TTL_SECONDS`、`EMAIL_CODE_REQUIRED`、
  `CLIENT_CURRENCY`、`TOPUP_*`、`STRIPE` 默认 API 基址的缺省值）——见 §5 D10，
  逐项裁决后仅 OAuth 基地址入 DB；
- OAuth 端点覆盖（`OAUTH_*_ENDPOINTS_JSON`）——**刻意保留 env 专属**，见 §6；
- 邮件模板/品牌、汇率参数、计费时区——已有各自机制。

## 2. 现状基线（存量面盘点）

### 2.1 静态 env 凭据清单与消费矩阵

| 集成 | env 组 | 消费进程 | 装配点（冻结处） | 未配置时行为 |
| --- | --- | --- | --- | --- |
| GitHub OAuth | `OAUTH_GITHUB_CLIENT_ID/SECRET` | client-api | `apps/client-api/src/adapters/identity-stack.ts:55-71` | 按钮隐藏、路由 404 `client.oauth_unknown`、用例兜 `oauth_provider_unconfigured` |
| Google OAuth | `OAUTH_GOOGLE_CLIENT_ID/SECRET` | client-api | 同上 | 同上 |
| SMTP（三进程共用） | `SMTP_HOST/PORT/USER/PASS/FROM` | client-api、admin-api、worker | client：`identity-stack.ts:72-105`；admin：`apps/admin-api/src/assembly.ts:166-178`；worker：`apps/worker/src/assembly.ts:148-174` | 邮件 fail-closed；`EMAIL_CODE_REQUIRED=auto` 登录降级单密码；admin 2FA 不可开；worker email 渠道不可投递 |
| 易支付 | `EPAY_PID/KEY/GATEWAY_URL/NOTIFY_URL/RETURN_URL/PAY_TYPE` | client-api | `apps/client-api/src/assembly.ts:182-222` | 充值渠道不注册 |
| Stripe | `STRIPE_SECRET_KEY/WEBHOOK_SECRET/SUCCESS_URL/CANCEL_URL`（`STRIPE_API_BASE` 可选） | client-api | 同上 | 同上 |
| Turnstile | `CAPTCHA_SITE_KEY/SECRET_KEY/VERIFY_URL` | client-api | `identity-stack.ts:146-153`、`assembly.ts:302-307` | 注册无防刷 |

启动期成组校验（`assertGroup`，`apps/client-api/src/config.ts:183-189` 与各组调用
L217-246）：半配启动抛错——本设计把该约束**平移到写入时校验**（§5 D5）。

### 2.2 运行时动态性现状（存量不变量基线）

- `GET /v1/oauth/providers` 返回装配期 `Object.keys(oauthProviders)`（冻结值），
  前端按钮按其显隐——**端点语义天然支持动态，仅数据源冻结**；
- `GET /v1/auth/capabilities` 返回 `{ registerEnabled, captchaSiteKey,
  emailCodeRequired }`（装配期冻结）；
- `emailCodeRequired` auto 口径 = `mailer != null`（`identity-stack.ts:103`）；
- 支付 provider 数组装配期构建，`resolveProvider`：显式指定不命中 →
  `payment_unavailable`；未指定时唯一渠道直通、多渠道必须显式选
  （`packages/billing/src/application/payments/payments.ts:76-90`）；
- webhook 验签：epay `parseNotify`（`adapters/payments/providers.ts:58-62`）与
  stripe `verifyStripeSignature`（providers.ts:115-126）都在 provider 闭包持
  static secret 一步用掉——**轮换无兼容窗口**；
- 三进程 SMTP「三要素全-or-无」口径一致（各 config 组装 + 装配判空）。

### 2.3 复用的既有设施

| 设施 | 位置 |
| --- | --- |
| AES-256-GCM `enc:v1` 加密器（双 key 轮换窗支持） | `packages/runtime/src/crypto/cipher.ts:45-90` |
| settings section 三件套（用例/store/审计） | `packages/control-plane/src/sections/settings-section.ts` 等 |
| secret 掩码（留尾 4）+ 防 `enc:` 伪装提交 | `packages/notifications/src/domain/channel.ts:113-135` |
| ACL 端点绑定（数据化，fail-closed） | migration `0084_endpoint_permissions.sql`；`apps/admin-api/src/http/middleware/acl.ts` |
| `settings:read`/`settings:update` 权限码 | `packages/control-plane/src/domain/rbac.ts:74-75` |
| 同事务审计 `emitAuditWithinTx` | `packages/control-plane/src/application/audit.ts` |
| 消费侧直读 + 进程内 TTL 缓存先例 | `apps/client-api/src/adapters/pricing-read.ts:91-110`、`apps/gateway/src/adapters/billing-timezone.ts` |
| app 装配取件面（postgres store 直供） | `packages/control-plane/src/composition.ts`（client-api/worker 已依赖此子入口） |

## 3. 存储与数据契约

### 3.1 新表 `integration_settings`（migration 0086，手写 DDL-first）

```sql
CREATE TABLE integration_settings (
  key varchar(64) PRIMARY KEY
    CHECK (key IN ('oauth.base','oauth.github','oauth.google',
                   'smtp','captcha.turnstile','payment.epay','payment.stripe')),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}',
  previous_secrets jsonb,          -- 轮换双读窗：{field: enc:v1 密文}，仅 rotatable 字段进入
  rotated_at timestamptz,          -- 最近一次 rotatable secret 轮换时刻
  updated_by_admin_id bigint REFERENCES admins(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- `config`：jsonb，**secret 字段以 `enc:v1:<iv>:<tag>:<cipher>` 密文内嵌**
  （与 notification channel config 同形态）；非 secret 字段明文；
- 同一迁移附带 `endpoint_permissions` 两条绑定种子（§4.3）。

### 3.2 集成词表与字段规格（封闭词表，domain 单一来源）

| key | 字段（S = secret 加密落库；R = rotatable 进双读窗；必填写 ●） |
| --- | --- |
| `oauth.base` | `frontendUrl` ●（非 S）、`apiBase` ●（非 S） |
| `oauth.github` | `clientId` ●（非 S）、`clientSecret` ●（S） |
| `oauth.google` | `clientId` ●（非 S）、`clientSecret` ●（S） |
| `smtp` | `host` ●、`port`（缺省 465）、`user` ●、`pass` ●（S）、`from`（缺省 user） |
| `captcha.turnstile` | `siteKey` ●、`secretKey` ●（S）、`verifyUrl`（缺省官方端点） |
| `payment.epay` | `pid` ●、`key` ●（S，R）、`gatewayUrl` ●、`notifyUrl` ●、`returnUrl` ●、`payType`（缺省 alipay；词表 = billing `EPAY_PAY_TYPES` 单一来源） |
| `payment.stripe` | `secretKey` ●（S）、`webhookSecret` ●（S，R）、`successUrl` ●、`cancelUrl` ●、`apiBase`（缺省官方端点） |

- 字段规格（名称/是否 secret/是否必填/是否 rotatable/校验器）以**数据驱动的
  spec 表**住在 control-plane domain（`src/domain/integrations/`），驱动：
  写入校验、掩码回显、admin-api zod 契约构造、导入脚本分组——同一真相定义一次；
- `configured`（完整）= 全部必填字段非空；`effective`（生效）= `enabled &&
  configured`；
- **不变量（DB 层由用例保证，写入拒绝违反）**：`enabled = true` ⇒ `configured`。

### 3.3 基线导入（`oauth.base` 的缺省语义）

本地/存量部署无 `oauth.base` 行时，消费侧回退 `http://localhost:8081` /
`http://localhost:3000`（与现 env 缺省同口径）；导入脚本会把当前
`OAUTH_API_BASE/OAUTH_FRONTEND_URL` 显式落行，生产行为不变。

## 4. 外部契约

### 4.1 admin API（新增，`apps/admin-api/src/http/routes/settings.ts` 扩展）

**`GET /v1/settings/integrations`** → `settings:read`

```json
{ "integrations": [
  {
    "key": "oauth.github",
    "enabled": true,
    "configured": true,
    "config": { "clientId": "Ov23li...", "clientSecret": "****wxyz" },
    "secretsSet": ["clientSecret"],
    "rotatedAt": "2026-08-25T03:00:00Z",
    "updatedAt": "...", "updatedByAdminId": 3
  }
]
```

- secret 字段回显 `maskSecret` 形态（`****` + 尾 4，短值全遮）；未设置的 secret
  字段值为 `null`；**响应永不包含明文或密文**；
- 列表恒含全部 7 个词表 key（无行视为 `enabled=false, configured=false,
  config={}`）。

**`PUT /v1/settings/integrations/:key`** ← `settings:update`

- body：`{ enabled?: boolean, config?: Record<string, string | null> }`；
- config 字段语义（三类，写入时逐字段裁决）：
  - 缺席 = **保持现值**（write-only 语义，UI 表单留空即不提交）；
  - `null` = 清除该字段；
  - 字符串 = 设置新值（secret 字段加密落库；rotatable 字段变更时旧值移入
    `previous_secrets` 并刷新 `rotated_at`，见 §5 D6）；
- 契约校验（zod 由 domain spec 驱动构造）：字段名必须在词表内、字符串非空、
  `enc:` 前缀拒绝（`integration_secret_encrypted`——防伪装密文回灌）、URL/port/
  payType 形状校验（`integration_field_invalid`）；
- 用例校验：`enabled=true` 但必填缺失 → `integration_config_incomplete`；
  未知 key → `integration_unknown`（404）；
- 写入与**同事务审计**（§4.4）原子提交。

### 4.2 用户侧能力端点（语义动态化，形状不变）

| 端点 | 新语义 |
| --- | --- |
| `GET /v1/oauth/providers` | 返回当前 reader 快照中 effective 的 provider 键集 |
| `GET /v1/auth/capabilities` | `captchaSiteKey` = captcha effective 的 siteKey（否则 null）；`emailCodeRequired`：`on`→true、`off`→false、`auto`→SMTP effective；`registerEnabled` 不变 |
| `GET /v1/payments/channels` | 返回 effective 的支付渠道 |
| `POST /v1/payments/orders` 等 | 向**非 effective** 渠道下单 → 既有 `payment_unavailable`（不变） |
| epay 回调 / stripe webhook | **不因渠道停用而拒绝**：验签归账继续（§5 D6），密钥轮换走双读窗 |

### 4.3 ACL 绑定种子（同迁移 0086）

```sql
('GET',  '/v1/settings/integrations',       settings:read),
('PUT',  '/v1/settings/integrations/:key',  settings:update),
```

未绑定即 fail-closed 403（ADR-0009）；`:key` 路径参数匹配已由 acl 中间件支持。

### 4.4 审计事件

- action：`settings.integrations.update`；targetType `integration_setting`；
  targetId = key；
- detail：`{ enabledFrom, enabledTo, changedFields: string[], rotatedFields:
  string[] }`；
- **Turnstile 加固（用户裁决 A）**：`captcha.turnstile` 的停用（enabled true→false）
  额外携带 `securityControlDisabled: true` 标志位，供审计页过滤与告警；
- 通道：`emitAuditWithinTx`——凭据属安全类变更，审计与业务同事务（区别于
  billing-timezone 的 best-effort 通道）。

### 4.5 错误码（control-plane errors 目录登记，message 英文 + zh 本地化字段）

| 码 | 场景 |
| --- | --- |
| `integration_unknown` | PUT 的 key 不在词表 |
| `integration_config_incomplete` | enabled=true 但必填缺失 |
| `integration_field_invalid` | 字段形状校验失败（URL/端口/payType/空串） |
| `integration_secret_encrypted` | 提交 `enc:` 前缀伪装密文 |

## 5. 关键设计裁决

### D1 能力落点：control-plane settings 域扩展，不建新包

集成动态配置本质是「运营系统设置」，与 billing-timezone 同域；control-plane 已被
全部消费进程依赖（client-api/worker 经 `composition` 子入口取 postgres store），
新包无真实边界（铁律 10/11）。分层：

- domain `src/domain/integrations/`：词表 + 字段 spec + 完整性/掩码/双读窗纯函数；
- application `src/application/integrations/`：`list`（掩码视图）、`update`
  （校验+加密+轮换入窗+审计）、`resolve-snapshot`（解密+有效性计算）；
- ports/adapters：`IntegrationSettingsStore` port + postgres 适配器；
- facade：`controlPlane.settings.integrations.{list, update}`；
- `composition` 子入口导出 `createIntegrationSettingsReader` 工厂（§5 D4）。

### D2 存储形态：专表 + jsonb 内嵌密文

不复用 `system_configs` KV：secret 混入通用 KV 会让掩码/校验/审计退化成
stringly 约定；专表与 `marketing_settings`/`notification_channels` 先例一致，
`enabled`/`previous_secrets`/`rotated_at` 有明确列语义。

### D3 加密与跨进程密钥契约：与渠道 Key 同一部署契约

admin-api（写入方）以 `ENCRYPTION_KEY` 加密；client-api 以 `ENCRYPTION_KEY`
解密；worker 以其必填 `CHANNEL_API_KEY_ENCRYPTION` 解密——**与渠道 Key 的跨进程
契约完全一致**（`docs/configuration.md`：worker 必配专用键、gateway 专用键优先/
回退根键、admin/client 用根键；部署须保持两键同值，本地 .env 实测相等）。不新增
任何 env 键。

### D4 消费侧：reader 工厂 + 进程内 TTL 缓存（60s，一致性预算）

- `createIntegrationSettingsReader({ db, cipher, ttlMs? })` → `{ resolve():
  Promise<IntegrationSnapshot> }`，导出自 `composition`（仅 app 装配层引用，白名单
  由既有 boundary 测试管辖）；
- 快照为**整体快照**（7 个 key 一次读全）：`{ oauth: { base, github, google },
  smtp, captcha, payments: { epay: {…, verifyKeys}, stripe: {…, verifyKeys} } }`，
  全部解密、按 effective/complete 语义归一；
- 缓存预算：TTL 60s（domain 常量单一来源；与网关 billing-timezone 缓存同量级）；
  过期后下一次 resolve 重读；**读失败 fail-loud**（与 pricing-read 时区读同口径：
  DB 故障时登录/充值路径本就不可用，不静默降级到旧凭据）；
- 一致性预算：写后本进程立即可见（admin-api 写路径用例完成即失效本地缓存——
  仅对同进程读者有意义），跨进程最迟 60s 收敛。对各消费面的余量验证：
  OAuth state TTL 600s ≫ 60s（轮换期间在途 state 过期自然终止，用户重试即新凭据）；
  SMTP/验证码在途码 Redis TTL 10min ≫ 60s；Stripe webhook 重试期 3 天 ≪ 双读窗
  96h（§5 D6）；
- 热路径预算：登录/注册/找回/充值均非网关推理热路径，每 TTL 一次全表读（≤7 行）
  可忽略；推理热路径（gateway）不消费本表。

### D5 enabled ⇔ 完整性不变量；启停语义

- `enabled=true` 拒绝必填缺失（写入时校验）；`enabled=false` 保留 config——
  重新启用无需重录凭据（这是与「删配置」的区别，UI 不提供整行删除）；
- 关闭一个集成的语义 = 功能面立即（≤60s）下线，**不是**凭据清除。

### D6 支付域（铁律 6：先读懂再动手——本节即对 billing payment 面的语义对齐）

两个独立机制，不可混同：

1. **停用不停验签（资金安全不变量）**：`payment.*` 行 `enabled=false` 时，
   新下单被拒（`payment_unavailable`，既有错误路径），但**回调验签与归账继续**——
   在途订单的付款通知不得因运营停用渠道而丢失。实现：client-api 装配的动态
   provider 包装层（§5 D7）对「下单可用面」检查 effective、对「回调验签面」只检查
   config 完整；
2. **轮换双读窗（仅 rotatable 字段）**：`payment.epay.key` 与
   `payment.stripe.webhookSecret` 变更时，旧值移入 `previous_secrets` 并记录
   `rotated_at`；验签次序 = 先新后旧，旧值仅在窗口内参与。窗口
   `PAYMENT_SECRET_ROTATION_WINDOW_MS = 96h`（domain 常量；Stripe 官方重试期
   3 天 + 余量；epay 同窗）。**退出条件 = 时间到期**（reader 过期后自然丢弃，
   无需人工清理；窗口外旧签名事件由 billing 对账哨兵兜底——既有机制）。
   billing 包的 provider 工厂扩展可选参数 `verifyKeys?: readonly string[]`
   （epay）/`webhookSecrets?: readonly string[]`（stripe），缺省单键——向后
   兼容的参数扩展，非双轨；
3. epay `key` 同时用于**下单签名**（新 key）与**回调验签**（新+旧窗口内）——
   双读窗只作用于验签侧。

### D7 消费侧动态化的装配改造（不引入双轨）

各进程把「装配期冻结」改为「reader 快照按需解析」，包装层住 app adapter：

| 进程 | 改造 |
| --- | --- |
| client-api | identity-stack：`oauthProviders` map、mailer、captcha、`emailCodeRequired` 改由 reader 快照派生（§5 D8）；payments：动态 provider 包装层（下单检查 effective / 验签检查 complete + 双读窗）；capabilities 端点每请求读快照 |
| admin-api | 2FA 邮件 mailer 改动态包装（发送时按快照取 transport，config 指纹变化即重建 nodemailer transport）；`/v1/me` 的 `mailerConfigured` 同步动态 |
| worker | notify job 每轮投递前读快照：SMTP complete 才建/复用 transport，否则 email 渠道 fail-closed（现有语义） |

### D8 identity 包契约变化（单一形态，无双轨）

`IdentityConfigInput.oauth` 从静态 `Record<string, OAuthProviderCredentials>` 改为
**同步快照 getter**：`() => Readonly<Record<string, OAuthProviderCredentials>>`。
`buildIdentityContext` 不再在构造期物化 provider 适配器；`oauth-authorize` /
`oauth-callback` / `oauth-link` 用例每次调用 getter 解析当前适配器（内存 map 读取，
零开销）。唯一调用方是 client-api（admin-api 不配置 oauth）+ identity 测试。
端点覆盖（env `OAUTH_*_ENDPOINTS_JSON`）在 client-api 侧与 DB 凭据合并后传入
getter——identity 契约不感知来源。

mailer 不改 identity 契约：client-api 注入**动态 Mailer 包装**（实现 identity
`Mailer` port，内部按快照取当前 transport / SMTP 失效时抛与现 `undeliverable`
等价的错误）；「邮件可用性」判定（路由层的 `emailCodeRequired`/发送前置检查）改为
每请求读 reader 快照——与今天 `mailer != null` 的分支语义逐一对应。

### D9 部署拓扑裁决：OAuth 基地址入 DB，其余拓扑留 env

`OAUTH_FRONTEND_URL/OAUTH_API_BASE` 若留 env，则「admin 里配好 GitHub 凭据但仍需
改 env 才能开登录」违背本设计目标——两值并入 `oauth.base` 行（导入脚本承接、
无行时本地缺省回退 §3.3；它们决定 redirect allowlist，非 secret）。epay/stripe 的
`notifyUrl/returnUrl/successUrl/cancelUrl` 是集成配置字段，随各自集成行入 DB。

### D10 端点覆盖不上管理端（安全收窄）

`OAUTH_GITHUB_ENDPOINTS_JSON/OAUTH_GOOGLE_ENDPOINTS_JSON` 是 e2e mock 与私有化
部署的逃生门。若入 admin 面，管理端失陷即可把 OAuth code 静默转发到攻击者
token 端点——**保持 env 专属**，DB 凭据与 env 端点覆盖在 client-api 侧合并。

### D11 Turnstile 加固（用户裁决 A 的两条落地）

1. 审计高亮：停用事件带 `securityControlDisabled: true`（§4.4）；
2. UI 联动警告：设置卡关闭 `captcha.turnstile` 时，若营销注册送礼
   `signup_gift_amount > 0`（读既有 marketing 设置），展示「注册送礼开启时关闭
   防刷存在批量注册套现风险」警告文案——**警告不阻断**（不硬耦合营销域）。
   组合风险分析：OAuth/SMTP/支付的停用损失的是可用性；captcha 是唯一「停用即
   移除安全防线」的项，且与注册送礼构成刷号套现路径，故独此一项加警告。

## 6. 安全分析

| 威胁 | 对策 |
| --- | --- |
| DB 泄漏（备份/拖库） | secret 字段 `enc:v1` 密文（AES-256-GCM），根密钥在 env——与 `channels.api_key_enc` 同信任模型，DB 单独泄漏不泄凭据 |
| admin 账号被盗 | ACL（`settings:update`）+ 同事务审计（谁改了什么、何时，掩码值进 detail）+ secret 回显永不还原（write-only）+ Turnstile 联动警告；攻击面不高于现有渠道 Key 管理（同级权限已可管理真金白银的上游凭据） |
| 前端/接口泄漏 | GET 响应只含掩码；`enc:` 伪装密文提交拒绝（防回灌已知密文探测） |
| 轮换期间的在途资金流 | 双读窗 96h + 停用不停验签（§5 D6）；窗口外由对账哨兵兜底 |
| 配置错误传播 | 写入时成组校验（enabled ⇒ 完整）、URL/端口/词表形状校验；60s 内全进程收敛 |
| 降级攻击（关 captcha 刷注册） | 审计标志位 + 营销联动警告（§5 D11）；关闭本身仍允许（运营正当需求），风险显式留痕 |

## 7. 迁移方案（铁律 8：单一形态，无运行时兼容层）

1. **顺序**：部署新代码（读 DB，无行 = 全部集成停用，但 `oauth.base` 缺省回退
   保持本地行为）→ 跑导入脚本 → admin UI 核对 → 删除 env 键。旧代码不读新表、
   新代码不读旧 env——**无运行时双轨**，切换点 = 部署 + 导入脚本完成；
2. **导入脚本**（`packages/control-plane/scripts/import-integration-env.ts`，
   `bun --env-file` 运行）：按词表逐集成读 env 组；完整组 → insert-if-absent
   落行（`enabled=true`，不覆盖已有行——幂等且不冲掉 admin 已改值）；非空不完整
   组 → 跳过并警告（对齐现 `assertGroup` 语义）；输出导入/跳过清单。半配拒绝
   而非部分导入，与现启动行为一致；
3. **env 删除清单**（四个 config + `.env.example` + `docs/configuration.md` 同步）：
   `OAUTH_GITHUB_CLIENT_ID/SECRET`、`OAUTH_GOOGLE_CLIENT_ID/SECRET`、
   `OAUTH_FRONTEND_URL`、`OAUTH_API_BASE`、`SMTP_HOST/PORT/USER/PASS/FROM`、
   `CAPTCHA_SITE_KEY/SECRET_KEY/VERIFY_URL`、`EPAY_PID/KEY/GATEWAY_URL/NOTIFY_URL/
   RETURN_URL/PAY_TYPE`、`STRIPE_SECRET_KEY/WEBHOOK_SECRET/SUCCESS_URL/CANCEL_URL/
   API_BASE`；**保留** `OAUTH_*_ENDPOINTS_JSON`、`OAUTH_STATE_TTL_SECONDS`、
   `EMAIL_CODE_REQUIRED`；
4. **回滚路径**：功能回滚 = 回退代码分支（DB 表留存无害——新代码独占读写）；
   恢复 env 凭据运行旧代码即原行为。`previous_secrets` 无需清理动作（窗口自愈）；
5. **观测**：admin 审计页 `settings.integrations.update` 事件即变更审计面；
   导入脚本输出即迁移台账。

## 8. 测试口径（存量不变量基线与新规格分列）

**存量不变量基线（回归，不许漂移）**：

- OAuth 旅程行为：providers 列表驱动按钮显隐、未配置 provider 404/
  `oauth_provider_unconfigured`、state 双提交校验、回调换 token 建号（e2e mock
  GitHub 既有旅程整体平移到 DB 种子后必须全绿）；
- SMTP fail-closed 族：邮件不可发送时的 `undeliverable`、auto 口径登录降级、
  admin 2FA 不可开、worker email 渠道不投递；
- 支付面：`resolveProvider` 语义（显式不命中 `payment_unavailable`、唯一渠道
  直通）、金额核对、markPaid→credit 单事务（billing 既有测试不动）；
- 错误码/事件时序：审计与业务同事务（写审计失败回滚业务）。

**新规格**：

- 词表封闭性：DB CHECK、domain 词表、admin 契约、UI 卡片四者逐项相等
  （表驱动断言）；
- 完整性矩阵：每集成 × {全空/半配/垃圾形状/全配} × enabled {true/false} 的
  写入接受/拒绝与 effective 计算（表驱动）；
- 掩码与 write-only：GET 响应不含明文/密文（契约测试）；PUT 缺席保持 / null
  清除 / 值设置三态；`enc:` 伪装拒绝；
- 轮换双读窗：窗口内新旧 key 验签均通过、窗口外旧 key 拒绝（时钟注入表驱动）；
  停用渠道下单拒绝但回调归账成功；
- 动态生效：capabilities/providers 端点在配置变更后 TTL 窗口内反映新值（时钟
  注入）；
- 审计：Turnstile 停用带 `securityControlDisabled` 标志；detail 含 enabled 迁移
  与字段清单；
- 导入脚本：完整组导入、半组跳过、幂等不覆盖；
- e2e 旅程：DB 种子 GitHub 凭据 + mock 上游 → 登录成功 → admin API 停用 →
  providers 列表为空（复用 `e2e/client-journey` 装置扩展）。

## 9. 验收清单

- [ ] 7 个集成全部可在 `/dashboard/settings` 卡片配置/启停，风格与现有卡片一致，
      设置按钮位于卡片右上方与标题对齐（用户裁决）；
- [ ] secret 全链路（DB/GET 响应/审计 detail/日志）无明文无密文泄漏；
- [ ] env 删除清单落地，四 config 无残留解析；`.env.example` 与
      `docs/configuration.md` 同步；
- [ ] 导入脚本幂等可重跑，存量部署清单核对通过；
- [ ] 双读窗与停用不停验签按 §5 D6 验证（含 e2e）；
- [ ] Turnstile 加固两条落地（审计标志 + UI 联动警告）；
- [ ] 四门全绿 + 覆盖率不低于现基线 + e2e 旅程全绿；
- [ ] 行为对照：§2.2 存量不变量基线逐项核销。
