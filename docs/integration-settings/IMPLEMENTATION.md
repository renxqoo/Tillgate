# 第三方集成动态配置 —— 施工图（IMPLEMENTATION）

- 状态：**已实施**（2026-08-25 全 Phase 落地并四门全绿；验收核销见 DESIGN.md §9）
- 设计依据：[DESIGN.md](./DESIGN.md)（节号引用 D1-D11）
- 门禁：每步提交前四门全绿（`bun run typecheck && bun run lint && bun run test && bun run build`），
  覆盖率只补不降；提交信息英文 Conventional Commits，正文引用本文节号。

## 总览（提交切分与顺序）

| # | 提交 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 0 | `docs(integration-settings)` | 方案两件套 | — |
| 1 | `feat(db)` | 表 + 迁移 0086 + ACL 绑定种子 | 0 |
| 2 | `feat(control-plane)` | domain/ports/adapters/用例/facade/reader 工厂 + 导入脚本 | 1 |
| 3 | `feat(admin-api)` | 端点 + 契约 + openapi | 2 |
| 4 | `refactor(identity)` | oauth getter 契约变化 | 2 |
| 5 | `feat(client-api)` | oauth/smtp/captcha 动态化 + env 删除（该三组） | 4 |
| 6 | `feat(admin-api)`+`feat(worker)` | 2FA/告警邮件动态化 + env 删除（SMTP 组） | 2 |
| 7 | `feat(billing)`+`feat(client-api)` | 支付动态化 + 双读窗 + env 删除（EPAY/STRIPE 组） | 2 |
| 8 | `feat(admin)` | 设置卡 UI + Turnstile 联动警告 | 3 |
| 9 | `docs(chore)` | configuration.md / .env.example / e2e 收口 + 验收核销 | 全部 |

> 同分支内允许过渡态（如 Phase 5 时 SMTP env 仍在 admin-api 解析），**合并前
> 收口为单轨**（env 删除清单见 DESIGN §7.3，最后一步核销无残留）。

## Phase 1 — 存储与迁移（feat(db)）

- [x] `packages/db/src/schema/integration-settings.ts`：新表（DESIGN §3.1 列结构 +
  key 词表 CHECK）；`src/schema/index.ts` 注册导出。
- [x] `packages/db/migrations/0086_integration_settings.sql`：建表 + `endpoint_permissions`
  两条 INSERT（GET/PUT，`ON CONFLICT DO NOTHING`，照 0084 L124-125 形态）；
  `migrations/meta/_journal.json` 登记 idx/tag。
- [x] 契约测试：词表 CHECK 与 control-plane domain 词表逐项相等（后置到 Phase 2
  一并断言四方向相等：DB CHECK ↔ domain ↔ admin 契约 ↔ UI 词表）。

## Phase 2 — control-plane 能力面（feat(control-plane)）

结构（一动词一文件，铁律 5）：

```
src/domain/integrations/
  keys.ts          # 7 个 key 封闭词表 + 常量（TTL 60s、双读窗 96h）
  specs.ts         # 每 key 字段规格表（secret/required/rotatable/校验器）
  masking.ts       # maskSecret（尾 4；短值全遮）——形态对齐 notifications 域
  completeness.ts  # configured/effective 纯函数
  rotation.ts      # previous_secrets 窗口内有效性（时钟注入）
src/ports/integration-settings-store.ts
src/adapters/postgres/integration-settings-store.ts   # 行读写（密文原样）
src/application/integrations/
  list-integrations.ts     # 掩码视图（无行 → 词表全量补全 enabled=false）
  update-integration.ts    # 校验→加密→轮换入窗→upsert→同事务审计
  resolve-snapshot.ts      # 解密→completeness→快照形状归一（DESIGN §5 D4）
  create-reader.ts         # TTL 缓存 reader 工厂（纯依赖注入）
src/sections/settings-section.ts   # settings.integrations.{list,update}
src/control-plane.ts                # ControlPlane 类型 + settingsDeps 扩展
src/composition.ts                  # 导出 createIntegrationSettingsReader
src/errors.ts（或目录）             # 4 个错误码登记（zh 字段本地化）
scripts/import-integration-env.ts   # DESIGN §7.2 导入脚本
```

- [x] specs 驱动校验器：URL（http/https）、端口（1-65535）、payType ∈ billing
  `EPAY_PAY_TYPES`（control-plane 已依赖 billing——词表单一来源直接 import）。
- [x] update 用例：`runTx` 内 upsert + `emitAuditWithinTx`（action/标志位见
  DESIGN §4.4）；`enc:` 前缀拒绝（`integration_secret_encrypted`）。
- [x] reader：整体快照 + TTL（时钟注入可测）；读失败 fail-loud；本进程写后失效。
- [x] `__test__/`：词表封闭性、完整性矩阵（表驱动）、掩码/write-only、轮换窗口
  时钟矩阵、审计同事务回滚、导入脚本（完整/半组/幂等不覆盖）。store 测试沿用
  包内既有 DB 测试口径（以现有 `__test__` 装置为准，缺 DB 的环境跳过并在提交
  说明标注）。
- [x] boundary 测试：composition 新导出面白名单更新（仅 app 装配层引用）。

## Phase 3 — admin-api 端点（feat(admin-api)）

- [x] `src/http/contracts/settings.ts`：`integrationsUpdate`（由 domain specs 构造
  zod：字段白名单 + `string(min1) | null` + enabled）；`integrationKeyParam`。
- [x] `src/http/routes/settings.ts`：GET 列表 / PUT 更新（错误映射：404
  `integration_unknown`；400 校验族）。
- [x] openapi：按 `src/http/openapi/*` 既有机制登记两端点（若为自动生成则核验
  产物含新路径）。
- [x] `__test__/`：端点契约（掩码响应无明文/密文、PUT 三态、ACL 403/404 矩阵——
  沿用 rbac e2e 的 viewer/operator/super 三角）。

## Phase 4 — identity 契约（refactor(identity)）

- [x] `src/domain/config.ts`：`oauth` 类型改 `() => Readonly<Record<string,
  OAuthProviderCredentials>>`（同步快照 getter，DESIGN §5 D8）。
- [x] `src/identity.ts`：`buildIdentityContext` 不再构造期物化 provider 适配器；
  暴露按 getter 解析的内部入口。
- [x] `application/oauth-{authorize,callback,link}.ts`：每次调用经 getter 解析
  适配器；未配置 → `oauth_provider_unconfigured`（语义不变）。
- [x] 全部 `__test__/` 静态 record 改 getter；行为断言不变（不变量基线）。

## Phase 5 — client-api 动态化（feat(client-api)）

- [x] `src/adapters/integration-reader.ts`（薄封装：composition reader + 本地
  单例）或直接在 assembly 持有；`createIdentityStack` 注入 reader。
- [x] identity-stack 改造：
  - oauth getter = reader 快照（DB 凭据 + env `OAUTH_*_ENDPOINTS_JSON` 合并，
    DESIGN §5 D10）；
  - 新 `src/adapters/dynamic-login-mailer.ts`：实现 identity `Mailer`，按快照
    config 指纹缓存/重建 nodemailer transport；SMTP 失效抛 `undeliverable`
    等价错误；
  - captcha：按快照惰性构造 turnstile 适配器；
  - `emailCodeRequired`：改每请求求值（on/off/auto×SMTP effective）。
- [x] 路由：`/v1/auth/capabilities`、`/v1/oauth/providers` 每请求读快照；
  `auth-login/register/forgot` 的「邮件可用性」前置检查改快照（与原
  `mailer != null` 分支一一对应）。
- [x] config.ts 删除：`OAUTH_GITHUB_CLIENT_ID/SECRET`、`OAUTH_GOOGLE_CLIENT_ID/
  SECRET`、`OAUTH_FRONTEND_URL`、`OAUTH_API_BASE`、`SMTP_HOST/PORT/USER/PASS/FROM`、
  `CAPTCHA_SITE_KEY/SECRET_KEY/VERIFY_URL` 及对应 assertGroup/跨字段校验
  （**保留 ENDPOINTS_JSON / STATE_TTL / EMAIL_CODE_REQUIRED**）。
- [x] e2e `e2e/client-journey/harness.ts`：OAuth 凭据改 DB 种子（直连 store
  upsert + cipher），mock GitHub 端点覆盖仍走 env；`oauth.e2e.ts` 新增「admin
  停用 → providers 空」断言。
- [x] `__test__/`：快照→getter/providers/capabilities 映射（时钟注入 TTL）、
  mailer transport 重建指纹、auto 口径矩阵。

## Phase 6 — admin-api / worker 邮件动态化

- [x] admin-api `src/adapters/dynamic-admin-mailer.ts`（同 Phase 5 形态）；
  `/v1/me` `mailerConfigured` 动态；config.ts 删 SMTP 组。
- [x] worker `src/jobs/notify.ts`：每轮读快照，SMTP complete 才用 transport；
  config.ts 删 SMTP 组（`SMTP_*` 四 app 全清）。

## Phase 7 — 支付域动态化（feat(billing) + feat(client-api)）

- [x] billing `adapters/payments/providers.ts`：`createEpayProvider` 增可选
  `verifyKeys?: readonly string[]`（缺省 `[key]`，验签按序尝试）；stripe 同
  `webhookSecrets`。下单签名恒用新 key（DESIGN §5 D6）。
- [x] client-api `src/adapters/dynamic-payment-providers.ts`：
  - `createOrder` 前置 effective 检查（否则 `payment_unavailable`）；
  - `parseNotify` 用 complete 快照 + `[current, ...(窗口内 previous)]`；
  - routes：`GET /v1/payments/channels` 改读快照 effective 列表；
- [x] config.ts 删 `EPAY_*`/`STRIPE_*` 组及 assertGroup。
- [x] billing `__test__/`：双读窗矩阵（窗口内新旧均过/窗口外旧拒/时钟注入）；
  client-api 测试：停用渠道下单拒绝 + 回调验签归账成功（用 billing 测试装置
  组合）。

## Phase 8 — admin UI（feat(admin)，用户裁决：卡片同风格 + 右上按钮与标题对齐）

```
src/features/settings/integration-cards/
  index.tsx                      # 编排：词表驱动渲染 7 张卡
  integration-card.tsx           # 单卡哑件：icon+标题+状态徽章+右上「配置」按钮
  integration-form-dialog.tsx    # FormDialog 表单（spec 驱动字段；secret write-only
                                 #   留空=保持、显式清除提交 null）
  integration-format.ts          # 纯函数（状态徽章/掩码展示/表单值组装）
```

- [x] 卡片头形态：`CardHeader` 内 flex 行——左侧 `CardTitle`（icon + text-base，
  与现有卡一致），右侧 `Button size="sm"`（配置/启停）**与标题垂直对齐**
  （用户裁决）；Turnstile 卡关闭时若营销 `signup_gift_amount > 0` 显示联动警告
  （读既有 marketing action；警告不阻断，DESIGN §5 D11）。
- [x] `src/server/settings-actions.ts`：`getIntegrationSettingsAction` /
  `updateIntegrationAction` / `getMarketingSignupGiftAction`（get 失败吞
  error，update 抛错走 `useActionResult`——对齐现有形态）。
- [x] i18n：zh/en 词条（apps/admin 既有 locale 机制）；复用 `@tillgate/ui`
  FormDialog/Button/Card/NativeSelect（铁律 20）。
- [x] `.test.tsx`：卡编排渲染（词表封闭 ↔ UI）、write-only 表单行为、警告联动
  条件。

## Phase 9 — 收口

- [x] `.env.example`、`docs/configuration.md`（第三方一章重写为 DB 动态配置 +
  导入脚本用法 + 密钥契约不变说明）、`docs/deployment-checklist.md` 核对。
- [x] 导入脚本在本地 .env 实跑一次并核对（占位 OAuth "1"/"1" 与真实 SMTP 会被
  导入——本地环境预期行为）。
- [x] 全量四门 + 覆盖率数字如实报告（对照基线不降低）。
- [x] e2e：oauth 旅程（DB 种子版）+ 停用断言全绿；`bun run` 各 app 冒烟。
- [x] DESIGN §9 验收清单逐项勾选；两份文档状态推进「已实施 → 已核销」。

## 风险与回退

- 每 Phase 独立可回滚（分支内小步提交）；最终合并前单轨核销；
- 实现中发现 DESIGN 有误：先改 DESIGN 再改代码（同提交），禁止口头漂移；
- worker/admin-api/client-api 三处 SMTP 改造若出现行为分歧，以 DESIGN §5 D7
  语义表为准裁决。

## Phase 10 —— code review 修复（2026-08-25 第二轮，5 代理审查 + 红测驱动）

- [x] control-plane：双读窗非轮换写入保留（A-1）/ invalidate 代次竞态 + admin-api
      写路径接线（A-2/D-M4）/ 不可解密密文原样回写不二次加密 + 回显全遮（A-3/R5）/
      导入逐行原子 insertIfAbsent + 逐键审计（A-4/E-1）/ 空白串与 enc: 变体拒收
      （R3/R4）/ URL 内网字面量拒绝 + smtp host 形状校验（H1/H3 收窄）/
      解密失败 onError 观测（M3）/ secretsSet 口径（M8）/ 出网点变更审计高亮
      `outboundEndpointChanged`（H1/H2）；
- [x] billing：验签空序列构造期拒绝（C-1）；
- [x] identity：validateOauthCreds 收窄为凭据形状校验（词表拦截归 guard——C 死代码）；
- [x] client-api：captchaSiteKey 按 effective（B-1，真源 helper `captchaSiteKeyOf`）/
      回调路由 refresh 预刷消盲窗（B-2）/ stripe apiBase 透传（B-4/H3）/
      mailerOverride 的 auto 口径恢复 main 基线（B-3）/ boot 读失败 fail-loud（B-suspect2）/
      resetLinkBase 用 configured 位（B-风险2）；
- [x] 权限拆分：迁移 0087 新增 `settings:integrations` 码，PUT 端点改挂——
      出网点写入与 settings:update 分离（H1/H2 爆炸半径收窄）；
- [x] docs：deployment-checklist 动态配置口径 / openapi 403 / DESIGN D4/D6/D9 修订回写。

---

## 增量：设置页 UI 收敛（2026-08-25 用户裁决）

1. **SMTP 归位 2FA 卡**：删除独立「邮件服务 (SMTP)」集成卡——邮件通道是
   「邮箱验证码二次登录」的实现细节，不另立邮件服务配置面。SMTP 的配置/
   启停入口移至 2FA 卡：右上「配置」按钮（位置同其余集成卡的用户裁决）→
   复用 `IntegrationFormDialog`（新增 `includeEnabled` 开关，提交
   `{ enabled, config }` 同传——后端契约本就支持）。
2. **卡面不显示配置字段值**：`IntegrationCard` 删除 `<dl>` 字段平铺——所有
   集成卡与「邮箱验证码二次登录」「验证器 (TOTP)」卡同形态（标题 + 描述 +
   启停 + 状态行），配置值只存在于弹窗表单（secret 掩码回显在 placeholder）。
   `rotatedAt` 与 Turnstile 联动警告保留（状态面，非配置值）。
3. **数据加载上提**：integrations 列表 + 注册送礼联动源由 `SettingsContent`
   统一加载（单次请求），`IntegrationCards` 改受控组件；无
   `settings_integrations` 权限时集成区维持 loadFailed 卡、2FA 卡隐藏配置
   按钮（2FA 启停不受影响）。
4. 2FA 卡拆出 `email-two-factor-card.tsx`（settings-content 职责瘦身），
   原 `smtpHint` 静态文案改为按 SMTP 实际状态的三态提示
   （就绪 / 已配置未启用 / 未配置）。
