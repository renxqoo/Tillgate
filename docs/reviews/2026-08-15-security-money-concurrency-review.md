# 全量审查报告：架构 / 安全 / 资金 / 并发（2026-08-15）

> **状态更新（同日晚）**：R1-R6 已全部修复并通过全量回归（`pnpm test --force` exit 0、
> 13 包 568 用例、typecheck/lint 全绿、脚本 18/19/20/21 验收通过、脏数据治理完成）。
> 修复明细见 `scripts/security-audit/FINDINGS-2.md` 文末「修复记录」。下文为审查时点的发现原文。
>
> **状态更新（第三轮攻击审查，同日）**：交易/金额/幂等/越权/DoS 实弹攻击又复现 4 项
> （T1 幂等键命名空间投毒可永久锁死任意新用户登录 / T1b 超长键 / T3 席位购买幂等失效+
> 孤儿 org / T4 巨型 client_id 落 Redis）+ 静态实锤 8 项（T2 幂等指纹未绑操作者、T5 API
> 无 bodyLimit、T6×6 批量加固），同日全部修复并全量回归通过。明细见
> `scripts/security-audit/FINDINGS-3.md`（账号 `ACCOUNTS-3.md`、验收脚本 `22-*.mts`）。

> 分支 `feat/gateway-production-hardening`（工作区含未提交改动，审查即针对当前工作区状态）。
> 方法：5 路并行静态审查（认证、金额、并发、薅羊毛、架构）→ 全部候选缺陷逐个人工验证
> （代码证据 + git 考古 + 红测真实复现 + 真实服务实时复现）→ mock 上游临界值 E2E →
> 真实模型 E2E（MiniMax-M3、deepseek-v4-flash 20 并发、gpt-oss-20b 免费模型）→ 全程对账以
> DB 为唯一真相。**未修改任何业务代码**；产出为红测与文档。
>
> - 缺陷明细（根因/证据/修复方向）：`scripts/security-audit/FINDINGS-2.md`
> - 测试账号与数据留档：`scripts/security-audit/ACCOUNTS-2.md`
> - 复现脚本：`scripts/security-audit/18~21-*.mts`（遵循既有约定，数据不清理）

## TL;DR

**计费引擎的「正确路径」经受住了最严格的检验**：真实模型 20 并发、临界值（恰好够/差最小单位/
上游超发）、流式尾帧、缓存价、免费模型——金额全部分毫不差（SQL numeric 精确比较，非浮点）。
**但「失败与变更路径」存在 6 个已实锤缺陷**，其中 2 个 P0 直接涉及资金（用户资金冻结、
平台资损），根因高度一致：**破坏性变更没做完整、不变量只存在于应用层单点**。

| # | 缺陷 | 级别 | 复现方式 |
|---|---|---|---|
| R1 | `request.failed` 不释放 `users.reserved_balance`（PAYG 预占永久泄漏，用户被锁死） | **P0 资金冻结** | 红测 3 用例 + 网关实时（上游 429 → released 后 reserved 滞留） |
| R2 | 零价上架套餐自助订阅白得额度（¥10 亿）并可 1:1 变现平台上游资金 | **P0 资损** | 实时攻击链全程复现（201 → 真实消耗平台资金） |
| R3 | org 订阅 renew/change 丢 orgId；change 不重绑 Key/App；已取消订阅可复活 | P1 | 红测 4 用例全红 |
| R4 | reserveChannel 预算 check-then-act，并发超扣进货预算（20>10） | P1 采购敞口 | 确定性并发红测 + 33 渠道 ¥3.02 存量泄漏 |
| R5 | OAuth client_id 锁死 DoS；改密不注销会话；NaN 路径参数 → 500 | P1/P2 安全 | 实时复现 3/3 |
| R6 | is_free 标志（授权口径）与价格表（结算口径）分裂：0 元授权 + 实价结算 | P1 口径分裂 | 红测 + 网关实时（账号 7908 被扣 ¥0.001002） |

静态审查另有 ~20 项（见 FINDINGS-2.md「静态审查发现」），重点：文档与信用模型实现相反
（高危误导）、usage_logs/transactions 零 CHECK 约束、密钥轮换脚本打印明文片段、上游错误
信息透传破坏白标、网关私有一份 Redis 键名副本。

## 已验证可靠（防误修清单）

- **金额核心**：单一 `calcAmount` 公式全链路引用；Decimal 全程 + `numeric(38,18)` 字符串落库；
  无 parseFloat/Math.round 触钱。真实模型对账：`amount == (未缓存×输入价 + 缓存×缓存价 +
  输出×输出价)/1e6 × 系数` 逐行成立；余额守恒 `初始 − Σ扣款 == 当前` 精确成立。
- **并发正确路径**：用户余额/套餐额度预占均为条件原子 CAS + DB CHECK 兜底；结算 claim/fencing
  在事务最终语句复查；usage_logs 唯一约束 + consume 流水部分唯一索引防双扣；redeem 单笔原子
  认领；订阅唯一索引兜底并发购买；20 并发实测无双扣、预占清零、无滞留。
- **临界值行为**：恰好够 → 精确归 0（18 位小数全 0）；差 1e-6 → 402 零残留；上游超发 →
  重试 10 次后 dead 进人工复核，余额绝不为负、无部分扣款；免费模型（is_free+零价）0 元计费。
- **XSS**：两个前端唯一 `dangerouslySetInnerHTML` 为静态主题串；无原生 innerHTML 赋值；
  密钥/兑换码只存 SHA-256，展示全脱敏。
- **注册关闭**、三面凭证物理隔离、CSRF Origin 校验覆盖、常量时间口令比较、登录锁定带正确
  密码豁免（用户面板路径）。

## 架构评价（结合五路审查结论）

**强**（企业级 SaaS 的骨架是对的）：billing_requests 持久状态机 + 预授权 + durable receipt +
worker 租约/fencing；fund_operations 幂等指纹；审计面广（admin 变更几乎全覆盖）；env zod
启动校验 + 弱密钥黑名单；trace 分区维护；分层干净（包不依赖应用、无循环）。

**弱**（按项目自己的八条原则度量）：
1. *破坏性变更一次做完整* —— R1（恢复预占未恢复释放）、R6（免费判定双口径）都是半迁移产物。
2. *不变量下沉 DB* —— usage_logs/transactions/rate_card/model 价格/channel 预算的关键不变量
   无 CHECK/唯一约束；R4 正是「无守卫 UPDATE」的直接后果。
3. *单一真相* —— 网关与 http 包各持一份 Redis 键名；intParam 与裸 Number 并存（R5-3）；
   requirements.md/data-model.md 描述的是已被删除的旧计费不变量。
4. *删除优于兼容* —— bad_debt 死分支、jti 黑名单只读死代码、candidates_tried 死列、
   auto-release 废弃码表。

## 修复优先级（建议顺序）

1. **R1**：signal 释放事务补 payg 递减（镜像 releaseReservations）——一块代码 + 回归断言。
2. **R2**：applySubscription 拒绝 price<=0 + 存量 96 行零价套餐一次性下线（先治理再上约束）。
3. **R4**：reserveChannel 守卫进 UPDATE WHERE；worker 接线 reconcileChannelReserved（补 dead）；
   channels CHECK；修 test helper 渠道投影清理。
4. **R3**：renew/change 继承 orgId+quantity、change 补改绑、renew 加 status 过滤。
5. **R6**：authorize 拒绝 explicitlyFree+非零价（invalid_quote），管理端同步互斥校验。
6. **R5-1/5-2**：OAuth 正确凭证豁免；users.token_version（或 sessions 表）实现改密/重置即时吊销。
7. 加固批：intParam 全量替换（R5-3）、上游错误信息脱敏、rotate-encryption-key 重设计（停止
   打印明文 + key 版本列）、文档对齐信用模型、DB CHECK 批量补齐、免费模型独立限流。

每项修复的验收 = 红测转绿 + 全量回归（`pnpm test` + typecheck + lint + 相关 e2e 脚本 exit 0）。

## 本轮新增测试资产

| 文件 | 类型 | 状态 |
|---|---|---|
| `packages/ledger/src/__tests__/billing-flow.payg-release.red.test.ts` | 红测 R1 | 3 红（修复后应绿） |
| `packages/ledger/src/__tests__/subscription-renew-change.red.test.ts` | 红测 R3 | 4 红 |
| `packages/ledger/src/__tests__/channel-budget-race.red.test.ts` | 红测 R4（确定性并发） | 1 红 |
| `packages/ledger/src/__tests__/free-model-inconsistency.red.test.ts` | 红测 R6 | 1 红 1 绿对照 |
| `scripts/security-audit/18-free-plan-self-subscribe.mts` | 实时攻击链 R2 | exit 1 = RED |
| `scripts/security-audit/19-oauth-lockout-session-nan.mts` | 实时 R5 | exit 1 = RED |
| `scripts/security-audit/20-boundary-billing-e2e.mts` | 临界值 E2E（含可控 mock） | 6 绿 1 红（S5=R1） |
| `scripts/security-audit/21-real-models-reconciliation.mts` | 真实模型对账 | 全绿 exit 0 |

渠道资金消耗合计 ≈ ¥0.003（deepseek ¥0.0025 + minimax ¥0.0003），未充值。
