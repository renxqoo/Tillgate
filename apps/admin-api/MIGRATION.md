# @tokenlens/admin-api 迁移行为规格

> 状态：已核销（2026-08-23;六域零接缝范围——P1–P7 见 IMPLEMENTATION §3）
> 迁移单元：管理员持有效 admin-realm 会话完成六域管理读写（users/keys、providers/channels/
> channel-funds、models/rate-cards/fx/catalog、订阅资金动词、tracing/审计/请求日志）
> 旧实现：`/Users/wrr/work/ai-getway/apps/admin-api`（约 6.8k 行 + 28 个测试文件）
> 目标位置：`apps/admin-api`（本包）
> 关联：DESIGN.md §2/§5、IMPLEMENTATION.md §1/§3

用途：v1 测试作为行为规格逐文件映射到 v2 契约测试；已知偏差逐条核销（DESIGN §5 裁决同源）。
纪律：断言语义不改（总纲 P5「搬迁只搬文件与启动装置，不得借机改断言语义」——
例外必须在本表 D 项显式登记）。

## 1. 迁移单元语义对照（v1 测试 → v2 测试）

| v1 测试文件（src/**tests**/）                    | 行为规格要点                                                                                                                                        | v2 落点（apps/admin-api/**test**/）                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `app.test.ts`                                    | 路由挂载全景 / 404 信封 / 健康探针                                                                                                                  | `app.test.ts` + `architecture.test.ts`                                                     |
| `security.test.ts`                               | 会话 401 统一口径 / 探针豁免 / 安全头 / CORS / body 限                                                                                              | `session.test.ts` + `app.test.ts`                                                          |
| `list.test.ts`                                   | 统一列表契约：分页容错、q trim≤100、sort_by 白名单 400、order 缺省 desc、信封 `{rows,total,page,pageSize}`                                          | 各域契约测试的列表断言 + `routes-control-plane.test.ts`                                    |
| `users.test.ts`                                  | 列表钱包富化（available = balance+credit−inFlight）/资料/PATCH 封禁语义（freezeReason 仅随 status=1）/creditLimit 拆分/transactions 信封/audit-logs | `routes-users.test.ts`                                                                     |
| `keys.test.ts`                                   | 全量列表（q 搜用户邮箱语义→D3 偏差）/PATCH status 0..1（99→400）/keyPreview 无明文                                                                  | `routes-users.test.ts`                                                                     |
| `channels.test.ts`                               | CRUD/换 Key 复位运行态/import≤1000（success=0→400）/test 探针形状                                                                                   | `routes-control-plane.test.ts`                                                             |
| `channel-funds.test.ts`                          | 进货凭证内联（data URL）/调账可负/幂等键重放与 409                                                                                                  | `routes-control-plane.test.ts`                                                             |
| `providers.test.ts`                              | CRUD/协议词表外 400（control_plane.invalid_protocol）/软退役                                                                                        | `routes-control-plane.test.ts`                                                             |
| `models.test.ts`                                 | 价格十进制字符串/变体 billingConfig refine/绑定≤500/探针                                                                                            | `routes-control-plane.test.ts`                                                             |
| `rate-cards.test.ts`                             | 系数 0.001..9.999 三位小数/删除绑定守卫/卡内用户/健康自检                                                                                           | `routes-control-plane.test.ts`                                                             |
| `fx.test.ts`                                     | 状态含懒拉/强制刷新/override PUT+DELETE/buffer PUT（审计留痕）                                                                                      | `routes-control-plane.test.ts`                                                             |
| `catalog.test.ts`                                | 源清单/比对/价格溯源 externalName 必填/导入提交即确认                                                                                               | `routes-control-plane.test.ts`                                                             |
| `subscriptions.test.ts`                          | renew/change/cancel/grant 幂等（管理面 userId:null 免属主检查）                                                                                     | `routes-billing.test.ts`                                                                   |
| `ops.test.ts`（audit/logs 子集）                 | 审计列表 q/sort/信封；请求日志 30 天窗 + statusCode 分组                                                                                            | `routes-observability.test.ts`                                                             |
| `auth*.test.ts`、`units.test.ts`（funds 幂等）   | 登录编排/调账幂等与同事务审计                                                                                                                       | 幂等语义 → `routes-billing.test.ts`；登录编排 → P2                                         |
| `plans.test.ts`                                  | kind×周期/删除守卫/审计                                                                                                                             | `routes-billing-admin.test.ts`（app）+ `packages/billing/__test__/plans.test.ts`（U6）     |
| `redeem.test.ts`                                 | 明文一次返回/哈希脱敏/作废统一 404                                                                                                                  | `routes-billing-admin.test.ts` + `packages/billing/__test__/redemption-batches.test.ts`    |
| `e2e-money.test.ts`（billing-review 部分）       | retry/abandon 乐观锁 + 三路归还 + 同事务审计                                                                                                        | `packages/billing/__test__/settlement-review.test.ts` + `e2e/admin/journey.test.ts` 死信面 |
| `subscriptions.test.ts`（list 部分）             | join 富化/过滤/剩余额度                                                                                                                             | `routes-billing-admin.test.ts` 订阅列表                                                    |
| `e2e-login/e2e-ops/e2e-crud-sweep/e2e-cross-app` | 旅程断言面                                                                                                                                          | `e2e/admin/journey.test.ts`（五旅程合并矩阵;P2 登录/P4 stats/P7 cross-app 缺口记档）       |
| `marketing/*`                                    | —                                                                                                                                                   | P3（不迁移断言，仅留规格指针）                                                             |
| `architecture.test.ts`                           | v1 正则文本门禁                                                                                                                                     | `architecture.test.ts`（v2 机器锁：文件清单快照 + composition/Db 引用规则）                |

## 2. 归属已迁移的行为（v1 app 层不再持有）

v1 `services/*.service.ts` 的业务规则与持久化在 P4 波次已入能力包并被其测试锁定
（对齐清单见各包 MIGRATION：users/keys → accounts；providers/channels/models/rate-cards/
fx/catalog → control-plane；funds/subscriptions → billing；tracing/audit/logs → observability；
auth → identity）。本 app 契约测试只锁 HTTP 语义（路径/方法/状态码/信封/错误码），
不重复锁业务规则（铁律 16 测试即规格，规格单一真相在能力包）。

## 3. v1 裸码 → v2 命名空间码（错误面核销）

| v1 code                       | 触发               | v2 code                                                                                                                | 归属目录                           |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `unauthorized`                | 会话缺失/无效/过期 | `http.unauthorized`                                                                                                    | HttpErrors                         |
| `invalid_request`（ZodError） | 入参形状           | `http.validation_failed`                                                                                               | HttpErrors                         |
| `invalid_param`               | 路径参数/显式字段  | `admin.invalid_param`                                                                                                  | AdminErrors                        |
| `invalid_sort_field`          | sort_by 白名单外   | `admin.invalid_sort_field`                                                                                             | AdminErrors                        |
| `user_not_found`              | 用户/资料/资金属主 | `accounts.user_not_found`                                                                                              | AccountsErrors                     |
| `catalog_source_not_found`    | 目录源未知         | 形状非法 → `admin.catalog_source_not_found`；形状合法未注册 → `control_plane.catalog_source_not_found`（e2e 实测路径） | AdminErrors / controlPlaneErrors   |
| `idempotency_conflict`（409） | 幂等键异参         | 用户资金动词 `billing.idempotency_conflict`；渠道资金 `control_plane.operation_conflict`（operations store 归属）      | BillingErrors / controlPlaneErrors |
| `insufficient_balance` 等     | 钱包守卫           | `billing.*`                                                                                                            | BillingErrors                      |
| `invalid_protocol/vendor`     | 词表外             | `control_plane.invalid_protocol/vendor`                                                                                | controlPlaneErrors                 |
| 其余 service 码               | 领域规则           | 各能力包目录码（handler 按 nature/category 分派）                                                                      | —                                  |

## 4. 已知偏差登记（wire 形状）

| #   | 偏差                                                                 | v1 行为                                 | v2 本波                                                 | 补齐                     |
| --- | -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------- | ------------------------ |
| D1  | providers `vendor` 引用                                              | 30 条厂商档案词表内可选                 | 词表空 → 引用即 400；`/v1/vendor-catalog` 404（不挂载） | P6                       |
| D3  | keys 行 `userEmail/userDisplayName`                                  | join users 回显                         | 恒 null                                                 | accounts enrichment      |
| D4  | transactions `total`                                                 | 独立计数精确                            | `offset + rows.length`（末页精确，中间页为下界）        | P1 评审                  |
| D5  | 审计行 `adminSubject` / 日志行 `attempts`                            | join/列存在                             | null / 缺省                                             | observability G 项       |
| D8  | 会话属主回查                                                         | validateSession 查 admins.status        | 验签+jti+锚点线（identity 现行契约）                    | P2（W3）                 |
| D11 | 用户列表行 `rateCardName`                                            | join 回显                               | 恒 null（资料端点 `GET /v1/users/:id` 有实值）          | accounts 列表 enrichment |
| D12 | 渠道行 `cooldownUntil/providerBaseUrl/updatedAt`、`boundModels` 线形 | join/列存在、`{externalName,realModel}` | 恒 null；boundModels 为 string[]                        | control-plane 列表扩展   |
| D13 | 模型行 `fallbackModels/paramRules`                                   | 列存在                                  | 恒 null（v2 store 不暴露）                              | control-plane 列扩展     |
| D14 | transactions 行 `createdBy`                                          | 操作管理员回显                          | 恒 null（腿级流水无操作者来源）                         | 随 P1 评审               |
| D15 | 用户 PATCH `displayName: null`                                       | 置空清除                                | 显式 400（accounts 动词无 null 形——拒绝优于静默忽略）   | accounts patch 词表      |

## 5. 部署差异

- 端口/协议不变（8082，Bearer 会话）；`DATABASE_URL` 从「v1 藏缺省」改为必填（B2 同裁决）。
- Redis：v1 healthz 探测 Redis；本波不装配（P2 起 Redis 必配后恢复探测）。
- 秘密新增 `IDENTITY_CODE_PEPPER`（identity 配置必填；v1 无此键——挑战 pepper 归 identity 波新增）。
