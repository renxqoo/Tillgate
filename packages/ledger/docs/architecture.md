# 总体技术架构 —— @ai-gateway/ledger

> 本文回答：这个包为什么这样切、每个技术决策（事务/幂等/并发/错误）的统一模式是什么。
> 各域的业务细节见同目录 sibling 文档。

## 1. 分层与依赖铁律

```
                    ┌──────────────────────────────────────────┐
   apps（gateway / worker / admin-api / client-api）            │
   │  自有状态机（兑换/支付/营销）+ wallet 动词                    │
   └──────┬───────────────────────────────────────┬────────────┘
          ▼                                       ▼
 ┌─────────────────┐                    ┌──────────────────┐
 │  settlement/    │  编排（不判定）      │   apps 侧资金服务  │
 └───────┬─────────┘                    └──────────────────┘
         ▼
 ┌─────────────────┐   认领后调用 settleClaim
 │    billing/     │  请求计费状态机（编排，不碰钱）
 └──┬──────┬───────┘
    ▼      ▼
 ┌────────┐ ┌────────────┐ ┌────────────────┐
 │rating/ │ │subscription/│ │channel-budget/ │
 └───┬────┘ └─────┬──────┘ └───────┬────────┘
     └────────────┼────────────────┘
                  ▼
      wallet（资金内核） + ledger-core（幂等内核） + db（schema）
                  ▲
          platform/（错误家谱 + HTTP 映射 + 幂等执行器）← 被所有域引用
```

**铁律**：`settlement → billing → {subscription, rating, channel-budget} → {wallet, ledger-core}`。
platform 是根（不依赖任何域）。任何域不得 import settlement，任何代码不得反向依赖 apps。
这条规则物理上就是 import 方向，由 `src/__tests__/architecture.test.ts` 机械强制——
越层/反向相对导入即测试失败（新增域须在测试的 ALLOWED 矩阵登记）。

## 2. 「业务账本」与「资金钱包」的分界

| 维度 | wallet（外部内核包） | ledger（本包） |
|---|---|---|
| 关心什么 | 钱：账户/复式腿/冻结单/授信/不变量 | 业务：计价规则、套餐权益、渠道预算、请求生命周期 |
| 表 | `wallet_accounts/transactions/legs/authorizations` | `billing_requests`、`plans/user_subscriptions`、`channels`、`usage_logs` 等 |
| 幂等键 | `(refType, refId)` + 命令指纹 | `ledger_operations.operation_id` + canonical 指纹 |
| 事务 | 动词自带（或 `tx` 注入变 SAVEPOINT） | `db.transaction` 编排，内部调钱包动词 |

一句话：**ledger 域做完业务判定后，把「动钱」委托给 wallet，把「至多一次」委托给 ledger-core。**

## 3. 事务的统一模式

所有写路径收敛为一个形状：

```
domainVerb(input)
  └─ operations.run({ operationId, kind, fingerprint, execute(tx) })
       └─ ledger-core：同事务内 INSERT 操作行（唯一键占位）→ execute(tx) → 回执落档
            └─ execute 内：业务状态机写 + wallet 动词（tx 注入，SAVEPOINT 语义）
```

要点：
- **占位先行**：`ledger_operations` 的唯一索引让并发同键的第二个事务阻塞直到首个终结——
  提交则读回重放，回滚则接棒执行。不存在「提交了但没有回执」的中间态。
- **SAVEPOINT**：注入的 tx 上调钱包动词时，wallet 内部用 SAVEPOINT 包裹——
  并发同键撞唯一索引只回滚到 savepoint，外层业务事务不受损，随后走重放读回。
  注入与否并发语义完全一致。
- **原子组合**：订阅购买 = 业务行 + 扣款同生共死；「实际 > 预留」结算 = 补充授权 +
  两笔结算 + 状态迁移一个事务——这是 S1 给 wallet 加 `tx` 注入的全部动机。

## 4. 幂等的统一模式

| 层 | 机制 | 谁负责 |
|---|---|---|
| 业务操作 | `operationId` 全局唯一（推荐 `domain.subject:业务键`）+ canonical 指纹（同键不同参 = 409 冲突） | platform.`createDomainOperations`（域内建实例，kinds 白名单 fail-closed） |
| 资金命令 | `(refType, refId)` + 命令指纹（authorizeFingerprint / commandFingerprint） | wallet 内核 |
| 状态机 | 条件 UPDATE（CAS）：`WHERE status = 期望态` + revision 乐观锁 | 各域自持 |
| 报表回执 | `usage_logs.request_id` 唯一约束 | billing.settle |

设计纪律：**调用方设计幂等键**（自然键优先，如 `referral-commission:{inviterId}:{yyyyMMdd}`）；
连接句柄（tx）与策略开关（allowCredit 的 true/缺省）**不进指纹**——重试换事务/等价缺省
必须命中同一指纹，否则部署即冲突。

## 5. 并发控制的统一模式（按问题选武器）

| 问题 | 武器 | 出处 |
|---|---|---|
| 单行余额/额度竞态 | 守卫内联 UPDATE WHERE（check-then-act 消灭） | wallet 曝口、quota 原语、channel 敞口 |
| 多账户加锁 | 按 account_id 全序 `FOR UPDATE`（防死锁） | wallet.lockAccounts |
| SUM 类限额并发突刺 | `pg_advisory_xact_lock(user)` 串行化授权决策 | billing.gates/daily-limit |
| 多 worker 抢任务 | `FOR UPDATE SKIP LOCKED` 批量认领 + claim 三元组 CAS | settlement.claim |
| 同键幂等竞态 | 唯一索引单语句定序（阻塞→重放/接棒） | ledger-core |
| 状态机并发迁移 | CAS（status/revision/claimToken 条件 UPDATE） | billing 全域 |

## 6. 错误语义的统一模式

单一继承树（platform/errors.ts）+ 全局唯一 code + 分级：

- **业务拒绝**（客户端 4xx，不重试）：`LedgerError`（订阅/金额/幂等冲突…）、
  `ChannelBudgetError`、`InsufficientBalance/DailySpend/Member/Subscription` 系。
- **状态冲突**（409）：`BillingStateConflictError`、`IdempotencyConflictError`。
- **毒输入**（结算永久失败 → dead 人工）：`PoisonReceiptError`、`ReceiptUserMismatchError`。
- **不变量红灯**（理论不可达，出现即 bug/数据脱节）：`BillingInvariantError`——
  分类器归 `invariant_violation`，首次失败直接 dead，不重试 churn。
- **配置错误**：`BillingConfigurationError`（invalid_quote/invalid_coefficient/reservation_limit_exceeded）。

翻译入口唯一：`platform/ledgerHttpError(error)`——LedgerError 查编译期穷尽映射表
`LEDGER_HTTP`，wallet 错误族（InsufficientBalance/InsufficientCash/Frozen/IdempotencyConflict）
映射到 402/403/409。apps 只调这一个函数，不写本地 switch。

## 7. 状态机：billing_requests 8 态

```
authorized ──upstream.started──▶ in_flight
    │  └───────────────request.succeeded──▶ settlement_pending
    └──request.failed──▶ released           │
              processing ◀──claim（SKIP LOCKED）── settlement_pending / retry_wait
                  │ │ └──失败（可重试类）/ recover③认领过期 / 停机归还──▶ retry_wait
                  │ └──毒收据/不变量/超限──▶ dead ──人工 retry──▶ retry_wait
                  └──成功──▶ settled（终态）
                          dead ──人工 abandon──▶ released（终态）
in_flight ──request.failed / recover②崩溃──▶ released
authorized ──recover①过期未发上游──▶ released
```

规则：**每个迁移都是一条条件 UPDATE（CAS）**——状态机没有独立迁移表，
`WHERE status in (...)` 就是唯一的迁移真相（与资金动作同事务）；
终态只有 settled/released；
冻结单不设 expiresAt——生命周期由 billing 显式管理（recover 兜底三类滞留：
授权过期未发上游 / 网关崩溃 / worker 认领过期），与 wallet 的 `releaseExpired`
双超时系统互不干扰（wallet 只管自己测试/脚本场景的短时冻结）。

## 8. 决策记录（为什么不是别的）

- **单包多域而不是多包**：域边界 = 目录 + import 铁律即可表达；分包带来版本/出口/
  依赖声明的治理成本，而本包域间总是同仓同节奏演进。
- **channel-budget 自治不进 wallet**：渠道进货额度是公司运营资金，与用户资金永不混账；
  熔断是运营语义不是资金不变量。预留了 `platform_revenue → channel_cost` 的
  wallet.transfer 结转路径，需要进总账时再启用。
- **quota 不用 wallet 冻结单建模**：额度不是钱；`used + reserved ≤ quota` 的业务不变量
  下沉在守卫 UPDATE + DB check 足够，复用冻结单反而引入两套生命周期。
- **「实际 > 预留」用补充授权而不是放宽 settle**：wallet 契约 `settle ≤ hold` 不动
  （宁可多押不可少押的资金纪律）；AI 计费的实际超预估在同一事务内以
  `authorize#over + settle#over + settle 原单` 三步表达，statement 呈现两笔结算，
  复式守恒、审计可追。
