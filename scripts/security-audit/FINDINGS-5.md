# 第五轮挂账清偿 · 修复记录（FINDINGS-5）—— 六批次全部完成

> 日期：2026-08-15（第五轮）。范围：前三轮审计中「明确未修复」清单里可代码级治本的
> 全部事项（六批次），架构/产品决策类 6 项另行提交用户拍板（见文末）。
> 验收：`pnpm test --force` 14/14 包、typecheck 17/17、lint 17/17、
> 实弹脚本 18/19/22/23/24/25 全部 exit 0。
> **本轮改动未提交**（等待用户允许）。

## 批次 1 · 资金 DB 约束族（治本：不变量下沉，迁移 0038）

加约束前逐项核存量 → 治理 → 上约束（加约束前先校验存量数据满足）：

| 约束 | 存量核查 | 治理 |
|---|---|---|
| `transactions_balance_chain_ck`（after = before + amount） | 1359 行违例（全部 2026-08-14 前旧计费实现：before 恒记 0，多为压测用户 21；其中 350 行 after 本身并发漂移） | **整链重算**：每用户首行 before 锚定 + 金额前缀和（干净用户零变化），重算后违例 = 0；重算语句在迁移文件内留痕 |
| `usage_logs_amounts_nonnegative_ck` + `usage_logs_amount_split_ck`（四方金额 ≥0；成功单 amount=plan+payg） | 0 违例 | 无需治理 |
| `model_mappings_prices_nonnegative_ck` | 0 违例 | 无需治理 |
| `rate_card_coefficients_global_uq`（部分唯一：每卡每 scope 至多一行 global） | 0 重复 | 无需治理（原 uq 因 NULLS DISTINCT 拦不住全局行重复） |

## 批次 2 · 上游错误出站脱敏（api-contract 白标闭环）

新增 `apps/gateway/src/lib/upstream-error-sanitize.ts`（单一脱敏组件：真实模型名→对外名、
供应商标识→「上游服务」、URL→[已隐藏]、HTML 粗剥、300 字封顶），接入四个出口：
1. 非流式 4xx/5xx 直接返回路径（err.message 脱敏）；
2. 流式不可换渠错误（state.failed.message）；
3. 503 全候选耗尽（改用固定通用文案，不再透传 lastError 原文）；
4. SSE 错误帧（rewriteSseModel 增 sanitize 回调，error.message 帧内脱敏；非错误帧字节透传不变）。
原始文案仍完整进服务端日志/request_logs（可审计）。测试：upstream-error-sanitize.test.ts 5 用例
+ 既有 sse-model-rewrite 4 用例不回归。

## 批次 3 · 金额类型与文档对齐（单一真相）

- `/api/usage/by-model` cost 去 `Number()` → 全精度字符串（与 /summary 一致）；
  `UsageByModelItem/UsageSummaryItem.cost` 类型改 string，前端图表端自行 Number() 展示。
- `UsageRow` 对齐实返回：删幻影 `statusCode`，补 `appId/apiKeyId`。
- 新增 `AdminTransactionRow`（含 createdBy，仅管理面）；admin 用户详情页改用之——
  修掉了「admin 页面用用户面类型」的漂移。
- docs/requirements.md 四处旧不变量（「不产生负余额/实际不超预估才结算」）改为信用模型
  语义；data-model.md users 表补 credit_limit 列与「可用额度 = balance + credit_limit −
  reserved_balance」公式、rate_card 全局行唯一约束说明。

## 批次 4 · 死代码一次删净（删除优于兼容）

| 项 | 动作 |
|---|---|
| `jti_blacklist` 只读死代码 | 删鉴权检查（零写入方；App 禁用 + 2h TTL 已覆盖吊销语义） |
| bad_debt 解冻分支 ×2（adminGift/Adjust + redeem） | 删（零写入方；解冻走管理端显式 PATCH status） |
| `request_logs.candidates_tried` 死列 | 迁移 0039 DROP COLUMN + schema/select/类型整链删除（attempts 保留） |
| auto-release 白名单 `rate_limit_error` | 删（429 归一化后无生产者；单一真相 = 金额阈值）；对应测试更新为新语义并断言「旧白名单码超阈值也不放」 |
| `formatYuan` 幽灵导出 | 删（无消费方） |
| `MeInfo.role` 幽灵字段 | 删（/api/me 不返回、前端不读） |
| `/debug/traces` token | 移除 query 传参（会进访问日志/浏览器历史）；改 Bearer-only + `timingSafeEqual` |

## 批次 5 · 功能补齐

- admin `GET /users/:id/transactions` 支持 `from/to` 过滤（与用户面同语义；此前参数被忽略）。
- org 邀请：新增 `POST /orgs/:id/invitations/:invitationId/revoke`（owner 撤销，0→2 revoked，
  幂等 404 + 审计）；创建面加待接受上限 min(剩余席位×2, 20)（防刷行——accept 才校验席位）。
- **登录审计（双面）**：client 与 admin 登录的成功/失败/锁定全部旁路落 audit_logs
  （action=auth.login.{success|invalid_credentials|locked}，含 ip；实测脚本运行已产生 154 条）。
- 目录导入审计 actor：路由注入真实 `adminId`（原硬编码 null）。
- Redis 键名单一来源：gateway 三处字面量（auth:key / app_status / user_profile）收敛到
  `@ai-gateway/http` cache.ts 构造器（gateway 补 http 依赖）。

## 批次 6 · 环境与安全小项

- **HS256 密钥强度**：生产强制 ≥32 字符（dev 保持 16 宽容，不破坏现有环境），JWT_SECRET /
  ADMIN_JWT_SECRET 同规则。
- **DEV_FAKE_ME 生产门控**：admin/client 的 get-user 与 keys 页共 4 处加
  `NODE_ENV !== 'production'`（一个 env 变量进生产不再渲染假身份壳）。
- `WORKER_HEALTH_TOKEN` 进 `.env.example`（含注释：不设则 /health 一律 403，livez/readyz 不受影响）。

## 迁移与数据总账

| 迁移 | 内容 |
|---|---|
| 0038 | transactions 整链重算（2051 行变更）+ balance_chain CHECK；usage_logs 双 CHECK；model_mappings 非负价 CHECK；rate_card 全局行部分唯一 |
| 0039 | request_logs DROP candidates_tried |

> 途中修复两次自伤（regex 删除误切 redeem 函数与 requestLogs 表定义），均已从 HEAD 对照重建并
> 通过全量测试——教训记档：结构性删除一律用精确 AST/编辑器操作，不用行号 regex。

## 仍需用户拍板的 6 项（架构/产品决策，本轮不动）

1. XFF 信任模型（TRUSTED_PROXY_HOPS 设计）
2. CSRF 双缺失头 fail-closed（需 Next.js BFF 服务间 token）
3. 管理面 maker-checker 职责分离（角色分级）
4. 免费模型滥用策略（独立 RPM/日请求数闸 + 目录价漂移自动处置）
5. 加密密钥轮换重设计（key 版本列 + 双 key 窗 + 事务化；脚本泄密已单独修复——stdout 不再打印密钥/明文片段，机制重设计仍挂账）
6. request_logs 按月分区（迁移量大，需停写窗口）
