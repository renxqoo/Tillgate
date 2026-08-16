# 功能测试覆盖缺口报告（TEST-COVERAGE，2026-08-15 第八轮后盘点）

> **状态更新（同日 · 补测轮）**：A1-A12 与 B 全部补齐（13 个新测试文件、19 个新用例），
> 覆盖缺口仅剩 C（前端整包，需测试基建决策）与 D（环境型）。四关全绿：
> test 14/14 包、typecheck/lint 17/17。
>
> **补测战果——抓到 2 个生产级真 bug（均在 worker 分区维护，自上线起每小时静默失败）**：
> ① `CREATE TABLE ... FOR VALUES FROM ($1)` DDL 不接受参数（建分区必抛错）；
> ② `($2 || ' days')` 参数为数字 → PG `integer || text` 运算符不存在（过期清理必抛错）。
> 二者使 R6 的分区维护任务从未成功执行过（warn 日志被吞）。已修
> （`request-log-partitions.ts`：DDL 内联服务端生成日期 + 参数 ::text 转换），并提取为
> 可测函数 + 一次性表测试锁定。另修复一个存量测试时序缺陷（trace findByTraceId 同毫秒
> 排序不定 → fixture 毫秒错开）。

## 补测清单（全部 ✅）

| 项 | 测试文件 | 用例 |
|---|---|---|
| A1 免费模型日限额 | gateway `free-limit-and-fallback-ratelimit.test.ts` | 限额 2→第 3 次 429+retry-after |
| A2 fallback 限流维 | 同上 | fallback RPM=1：首承接、次跳过→503 rate_limited |
| A3 邀请撤销+上限 | client-api `orgs.invitation-cap-revoke.test.ts` | 上限 409/撤销/非owner 403/重复 404/释放再邀 |
| A4 2FA 开关 | admin-api `admin-auth.two-factor.test.ts`（扩展） | 无 SMTP 400/开关落库/审计 |
| A5 交易 from/to | admin-api `users-transactions-range.test.ts` | 三日期筛/组合/非法 400 |
| A6 router 双 key | gateway `model-router-dual-key.test.ts` | v1+OLD/v2/v1 无 OLD 必抛 |
| A7 8MB 读体 | ai `non-stream-large-body.test.ts` | 600KB 成功体→success+usage |
| A8 分区维护 | worker `partitions-and-health.test.ts`（提取 `request-log-partitions.ts`） | 建分区幂等/滚动删/一次性表验证 |
| A9 receiver bodyLimit | trace-receiver `receiver.test.ts`（扩展） | 9MB→413 |
| A10 /health 令牌门 | worker 同上（提取 `health-gate.ts`） | 未配拒/恒定时间比较 |
| A11 admin 公开组 CSRF | admin-api 2FA 测试内 | evil Origin 403 |
| A12 oauth 三传法 | gateway `oauth-token.test.ts` | JSON/form/Basic 等价+grant 400 |
| B 七路由 | admin-api `admin-routes-batch.test.ts` + `voucher-storage.test.ts` | billing-operations 参数/CAS、redeem 批次+撤销、keys 枚举、subscriptions 404/400、providers 重名 409、stats 结构、vouchers 白名单+往返 |

## 原始盘点（补测前快照，历史留档）

> 方法：源文件 ↔ 测试文件映射（16 个包）+ 路由引用核对 + 新功能断言 grep。
> 覆盖现状总评：**后端核心覆盖良好**（gateway 35 个测试文件、ledger 13、ai 11+real、
> client-api 13、http 8、worker 2），缺口集中在「第四~八轮新功能未建回归」+「admin
> 路由层」+「前端整包零测试」。

## A. 新交付功能无回归保护（最高优先——一次重构就可能静默回归）

| # | 功能（轮次） | 现状 | 建议测试 |
|---|---|---|---|
| A1 | 免费模型每日限额（R6） | 0 断言（`checkFreeDailyLimit` 无任何测试） | 管线级：isFree 模型第 N+1 次 → 429 业务码 + retry-after；非免费不受影响；Redis 故障 fail-open |
| A2 | fallback 模型限流维（R6/G3） | 0 断言 | 候选循环级：fallback 模型维超限 → 跳过该候选（不无计量承接） |
| A3 | org 邀请撤销 + 待接受上限（R7） | 0 断言（e2e 只测邀请/接受） | 撤销路由（owner 200/非 owner 403/重复 404）；pending ≥ min(剩余×2,20) → 409 |
| A4 | 2FA 开关路由（R8） | 0 断言（登录两步流已测） | toggle：开启无 SMTP → 400；开启/关闭状态落库 + 审计；非管理员 401 |
| A5 | admin 交易 from/to 过滤（R7） | 0 断言 | 造三条不同日期流水 → from/to 各筛出一条；非法日期 400 |
| A6 | model-router 双 key 解密（R6） | 0 直接断言（crypto 单元已测，router 接线未测） | 造 v1 密文渠道 + ENCRYPTION_KEY_OLD → 路由解密成功；无 OLD → 失败 |
| A7 | 非流式 8MB 读体上限（R6/G4） | 0 断言 | mock 上游返回 >256KB 成功体 → 200 正常结算（不再 invalid_response→uncertain） |
| A8 | worker request_logs 分区维护（R6） | 0 断言（SQL 实库手验过一次） | 单测化那段 SQL：建未来分区/删过期分区/幂等（或提取为可测函数） |
| A9 | trace-receiver bodyLimit（R6/G1） | 0 断言 | >8MB → 413；<8MB 正常入库 |
| A10 | worker /health 令牌门（R6/G2） | 0 断言（curl 实测过） | 无令牌 403；带对令牌 200（healthServer 可注入 req 模拟） |
| A11 | admin 公开组 CSRF（R7） | 0 断言（client 面已测） | evil Origin 打 admin login → 403（镜像 client 用例） |
| A12 | oauth-token form/Basic 分支 | 仅实弹脚本覆盖 | 单测：form-encoded 与 Basic 两种传凭证等价 JSON 分支 |

## B. 存量 admin 路由层零测试（业务在 ledger/services 层已测，路由接线未测）

| 路由 | 缺什么 | 风险 |
|---|---|---|
| `billing-operations` | retry/resolve/abandon 的参数校验、expectedRevision CAS 接线、decision 枚举 400 | **高**（资金处置入口） |
| `redeem`（批次管理） | 创建批次金额/count 校验、撤销码、码明细脱敏 | **高**（资金发放） |
| `keys`（admin） | 启停 + 清网关缓存联动 | 中（吊销时效） |
| `subscriptions`（admin） | cancel/change/renew 路由层与 ledger 的参数桥接（adminId 注入） | 中 |
| `providers` / `stats` / `vouchers` | CRUD 校验 / 聚合口径 / 穿越（穿越有实弹脚本 24 兜底） | 低-中 |

## C. 整包零测试（结构性缺口）

| 包 | 现状 | 判断 |
|---|---|---|
| **apps/admin、apps/client（前端）** | 0 个测试文件，仅 tsc 兜底 | 最大结构性缺口；需先决策测试基建（Vitest+RTL 组件测 或 Playwright e2e 二选一先行） |
| packages/db | schema 声明无测试（合理）；seed-dev 无 | 低 |
| packages/identity | 3 个测试文件（session/throttle/password）；admin-session 中间件靠集成间接覆盖 | 低 |

## R10 列表统一补测（本轮增量）

- `packages/http/src/__tests__/list-query.test.ts`（10 用例）：escapeLike / searchCondition（空值·多列 OR·表达式 ::text）/ sortQuerySchema 默认 desc / resolveOrderBy 白名单外 400 INVALID_SORT_FIELD + tiebreaker
- `packages/ui/src/lib/list-query.test.ts`（5 用例，ui 包首次接入 vitest）：listHref 保留/覆盖/删除参数、排序跳转回第 1 页、firstParam
- `apps/admin-api/src/routes/list-unification.test.ts`（5 用例）：providers envelope+q+sort asc/desc+400、models q+channelIds、channels 当页增强（boundModels/upstreamConsumed）、rate-cards q+系数回显、plans 默认 id desc+price asc、billing-operations status 必填+envelope
- `apps/client-api/src/routes/list-unification.test.ts`（3 用例）：keys q 搜索根治（name/remark 命中、默认 createdAt desc、非法 sort_by 400）、plans sortOrder asc、orgs 空 envelope
- 适配：admin tracing.test.ts 断言迁移至标准 envelope（page/page_size/total）
- 数据纪律：统一前缀 `lq10` / `lq10_` / `__lq10_`，清理仅删自身前缀（rate_cards 先删 coefficients 子行防 FK）

## R11-B uncertain 时效放行补测

- `packages/ledger/src/__tests__/billing-review-automation.test.ts` 新增时效通道用例：超时且≤上限放行、超时但>上限留人工、未超时不动、dead 不碰、未配置通道关闭、幂等、双通道命中去重（fixture 新增 ageHours 回拨）
- `packages/core/src/__tests__/env-uncertain-timeout.test.ts`（3 用例）：双参数无默认（不配=关）、缺一即拒、金额必须为正

## D. 环境依赖型验证（代码无法自测）

- **真实 SMTP 发信**（R8 2FA 邮件）：stub 已测；配好个人邮箱后需人工收一次真码（部署清单自检项）
- **浏览器级 e2e**：Playwright 无——登录两步 UI、邀请撤销按钮、交易筛选控件只有类型检查
- **真实上游限流联动**（A2 的真实版本）：脚本 21 真实模型对账覆盖主链路

## 优先级建议

1. **A1-A7（半天量）**：全是真金白银/安全语义的功能，各 1-2 个用例即可锁死
2. **B 的 billing-operations + redeem 两个资金路由（半天量）**
3. **A8-A12 + B 其余（按需）**
4. **C 前端**：建议 Playwright 只覆盖三条主链路（登录两步/邀请撤销/建 Key 调网关）而非全面组件测试——投入产出最优

## R12：邮箱登录 + 强制邮箱验证码（2026-08-16）
- identity `login-code.test.ts`（4）：冷却/计次作废/一次性消费/namespace 隔离
- identity `mailer.test.ts`（3）：双品牌渲染迁移回归
- client-api `auth-email-login.test.ts`（4）：email-only schema、两步全链路（赠额在验码后）、fail-closed 503、60s 限发 429、防枚举
- 适配：admin `admin-auth.two-factor.test.ts`（统一作废语义）、client throttle/xff/csrf 三套
- 实测：dev API（旧字段 400）+ 无头 UI 两步流 + 真实冷却触发

## R13：C 端邮箱自助注册（2026-08-16）
- identity `login-code.test.ts` 新增 extra 字段用例（5 例总计）：挑战暂存 email/密码哈希，验证成功原样返回
- client-api `auth-register.test.ts`（2）：占用 409/弱密码 400/两步全链路（建号+会话+赠额+可直接登录）/IP 限流 429/邮箱冷却 429/fail-closed 503
- 实测：dev API（200 challenge、弱密码 400）+ 无头 UI（注册两步转场、密码不一致校验、登录页入口）

## R14：OAuth 社交登录（2026-08-16）
- client-api `auth-oauth.test.ts`（3）：未配置 404 + authorize 302/state cookie；GitHub callback 双提交校验（无/错 cookie 403）→ 建号+会话+重定向；二次登录不重复建号；Google 建号 + next 防 open redirect
- 假 provider 本地起服务（token/profile/emails 端点可覆盖），不打真实外网
- 实测：dev 未配置 → providers 空、authorize 404、登录/注册页按钮隐藏

## R15：显示名称 rx 默认 + 自助修改（2026-08-16）
- client-api `auth-display-name.test.ts`（2）：邮箱注册/OAuth（无平台昵称）默认名匹配 ^rx[a-z2-9]{6}$；PATCH /api/me/display-name 改名+trim+空/超长 400+审计
- GitHub 适配（用户裁决修正）：OAuth 显示名优先级 姓名 → login/邮箱前缀 → rx 兜底；rx 默认名仅邮箱注册使用
- 实测：无头浏览器改名弹窗全链路（保存 → toast → 信息行+侧边栏同步刷新）
