# 管理端邮箱 2FA 开关「邮箱码自证」设计方案（admin-email-2fa）

- 状态：**定稿**（2026-08-25 用户裁决 D2=A + D3 默认裁决；实现推翻本设计时先改本文再改代码）
- 级别：**中级**（跨 admin-api / identity 模板 / admin 前端；公共契约变形：`POST /v1/me/two-factor` 请求体换代 + 新端点）
- 分支：`feat/rbac-config-discussion`（承接 settings 域拆卡工作，commit 独立可评审）
- 配套施工图：[IMPLEMENTATION.md](./IMPLEMENTATION.md)

## 0. 用户裁决记录（2026-08-25）

| 分叉 | 裁决 |
| --- | --- |
| 开启流程方向 | **用户裁决 D2=A：邮箱码自证开启**——点开启 → 发码到本人邮箱 → 输码生效；取消本端点的 TOTP 前置与 TOTP step-up |
| 关闭确认方式 | **默认裁决 D3（否决窗口）**：同样邮箱码确认（对称自洽——开关哪个因子就证明控制哪个因子；取消 TOTP 前置后不存在「没绑 TOTP 关不掉」死角） |
| TOTP step-up 的存废 | 仅取消 `/v1/me/two-factor` 一处；`PUT /v1/settings/integrations/:key`（凭据写入）的 step-up 不动（ADR-0011 不受影响） |

## 1. 背景与目标

现状：开启/关闭邮箱 2FA 要求先绑 TOTP 并输 TOTP 码（ADR-0011 step-up），且 SMTP
未生效时报错发生在点击之后（`smtp_not_configured`）。痛点：① 开邮箱 2FA 强制
先有另一种验证器，语义是「开 A 必须先有 B」；② 通道不可用的反馈滞后；③
（已随拆卡解决）SMTP 配置入口与个人开关混卡。

目标：本人邮箱收到的验证码即开启/关闭的确认凭证——能收到码 = 通道可用
（SMTP 前置天然内化，不存在「开了却收不到登录码」的锁死）+ 邮箱可达
（偷会话的攻击者无法开启，除非能收受害者的邮件）。

## 2. 契约

### 2.1 新增：`POST /v1/me/two-factor/code`（SELF 前缀，需会话，无权限码）

- 请求：空 body；
- 响应 `200 {challengeId: string(uuid)}`；
- 行为：`identity.challenges.begin({kind:'admin_two_factor_code',
  target:{userId: 当前 adminId}, payload:{adminId},
  delivery:{ip, locale}, mailerPurpose:'two_factor_toggle'})`——
  目标寻址走 `findDeliveryIdentifier`（admin email）；60s 冷却、同 kind 同目标
  唯一活挑战、TTL 5min、maxAttempts 5 全部复用挑战层内建；
- 错误（经 error-face 翻译，见 §2.3）：SMTP 未生效（发送路径 fail-closed）、
  冷却中（带 retryAfterMs）、投递失败（挑战已作废可立即重发）。

### 2.2 变形：`POST /v1/me/two-factor`（SELF，需会话）

- 请求体换代（**单轨切换，无兼容双收**——管理面自用契约，前后端同仓同发）：
  `{enabled: boolean, challengeId: string(uuid), code: /^\d{6}$/}`；
- 行为：`identity.challenges.verify({challengeId, code, expect:{userId: adminId}})`
  ——**expect 主体绑定**（跨主体 challengeId 按 `challenge_invalid` 拒，比登录
  verify 更严）→ 通过则 `setTwoFactorEnabled` → 审计（见 §2.4）；
- 响应 `200 {twoFactorEnabled: boolean}`（回显生效值）；
- 移除：`requireTotpStepup` 与 `mailerConfigured()` 前置（通道校验前移到发码步）。

### 2.3 错误码（control-plane/admin 错误目录登记，message 英文 + zh 字段）

| 码 | 场景 | HTTP |
| --- | --- | --- |
| `admin.smtp_not_configured`（沿用） | 发码时 SMTP 未生效（undeliverable 翻译） | 503 |
| `admin.delivery_failed` | 邮件投递失败（挑战已作废） | 503 |
| `admin.challenge_cooldown` | 60s 冷却内重发 | 429（retryAfterMs） |
| `admin.code_invalid` | 错码未耗尽（带 remainingAttempts） | 400 |
| `admin.challenge_invalid` | 不存在/过期/耗尽/已消费/主体不符 | 400 |

### 2.4 副作用与事件时序（终态最后、一次性事件恰好一次）

发码：`challenge.begin` 审计（identity 层内建）→ 邮件投递（事务提交后）。
开关：验证码单次消费（CAS）→ `admins.two_factor_enabled` 落库 →
**成功审计恰好一次**（`settings.two_factor`，detail `{enabledFrom, enabledTo}`，
postAudit 后置旁路通道——与 stepup 失败审计同语义；现状成功路径零审计属
顺手修复的安全缺口）。

## 3. 问题域

- 处理：本人经邮箱码开启/关闭邮箱 2FA；发码；成功审计补齐。
- 不处理：登录第二因素流程（`admin_login_code` 既有链路不动）；TOTP
  绑定/确认/解绑（不动）；集成凭据写入的 TOTP step-up（不动）；C 端用户
  验证码（client-api 既有）；SMTP 配置本身（独立集成卡，已落地）。

## 4. 并发/一致性预算

- 复用挑战层硬约束：TTL 5min / 冷却 60s / maxAttempts 5 / 同 kind 同目标
  唯一活挑战（部分唯一索引）；verify 单条 CAS（attempts+1 与 consumed 原子）。
- 开关落库单行 UPDATE（幂等重放被 challenge 单次消费拦截）。
- 发码在请求路径同步直发（与登录码同语义，nodemailer 超时受适配器现有约束）。

## 5. 拆分与依赖方向

- **identity（最小触点）**：`MailerPort.sendLoginCode` opts 增可选
  `purpose?: 'login' | 'two_factor_toggle'`（缺省 `login`——client-api 实现
  零改动）；`renderLoginCodeEmail` 模板标题/引导句按 purpose 分支（zh/en）。
  挑战机制零改动（kind 词表由装配注入）。
- **admin-api**：装配 `challengeKinds` 增 `admin_two_factor_code`；routes/me.ts
  新增发码端点 + 改造开关端点；contracts 变形；error-face 翻译；openapi 重生成。
- **admin 前端**：2FA 卡交互改造（点击 → 发码 → 邮箱码确认弹窗 → 提交）；
  server actions（新增 `requestTwoFactorCodeAction`，`setTwoFactorAction` 变形）；
  i18n。TOTP 未绑定不再是按钮置灰条件（D2 取消前置）。
- 依赖方向不变：admin-api → identity / control-plane；admin → api-client。

## 6. 实施顺序（每阶段独立提交、四门全绿）

1. identity purpose 参数 + 模板分支 + 模板测试（纯加法，缺省行为不变）；
2. admin-api 契约/路由/装配/错误面 + openapi/dto 重生成 + 路由测试；
3. admin 前端交互 + i18n + 组件测试 + 全量四门。

无过渡态（单轨切换，前后端同一次发布内收口）。

## 7. 测试口径

- 契约：请求体形状（uuid/6 位码/enabled 布尔）；错误码表驱动（§2.3 全表）；
- 边界：冷却窗口内重发、错码 5 次耗尽、过期码、跨主体 challengeId（expect 拒）、
  已消费码重放、SMTP 未生效发码即拒、开关双方向、成功审计行存在；
- 前端：无 TOTP 按钮可点（不再置灰）、发码→输码→确认链路、错误 toast 文案；
- e2e：核对既有 admin 旅程是否触及 `/v1/me/two-factor`，触及则同步更新。

## 8. 验收清单

- [ ] 开启：发码 → 收码 → 输码生效；无需 TOTP；
- [ ] 关闭：同链路对称（D3 默认裁决）；
- [ ] SMTP 未生效：发码即 503，不再等点击开关；
- [ ] 跨主体 challengeId 拒；错码计数与耗尽语义正确；
- [ ] 成功开关有审计行（detail 含 from/to）；
- [ ] `PUT /v1/settings/integrations/:key` 的 step-up 不受影响；
- [ ] 邮件文案按用途区分（登录码 vs 开关确认码）；
- [ ] 四门全绿 + 覆盖率不低于现基线，数字如实报告。
