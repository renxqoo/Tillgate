# settlement —— worker 结算编排域

> 出口：`@ai-gateway/ledger/settlement`
> 源码：`src/settlement/{claim,claim-lease,process-claim,run-once,failure,recover,inventory,effects,tpm-backfill,queue-contract,index}.ts` + 3 例测试

## 1. 职责与边界

BullMQ worker 的**纯编排**：认领 settlement_pending/retry_wait → 租约保活 → 逐单调
billing.settleClaim → 失败分类 → 重试/死信；外加滞留恢复、库存健康、优雅停机归还、
TPM 回填与 Redis 缓存效应。**不做任何领域判定**——资金与状态语义全部在 billing 域
（settleClaim 由装配层注入）。

核心哲学：**所有业务重试状态都在 PostgreSQL；Redis/BullMQ 只是低延迟通知层**
（payload 永不携带账务事实，worker 崩溃后 DB 扫描自愈）。

## 2. 逐组件说明

### claim.ts —— 批量认领
`FOR UPDATE SKIP LOCKED` 领取到期账单（settlement_pending/retry_wait 且
next_settlement_at 到期；可选 requestIds 定点）→ 置 processing + **claim 三元组**
（claim_owner/claim_token=gen_random_uuid()/claim_until）+ settlement_attempts++ + revision++。
多副本天然分片（skip locked）；`decodeReceipt` 在此做毒收据结构校验
（类型化抛 `PoisonReceiptError`，不靠 message 文本）。

### claim-lease.ts —— 租约保活
settlement 期间周期续 claim_until（interval = claimLeaseMs/3，unref），
防长事务结算被 recover③ 误判「认领过期」重排（双扣风险）。纯基础设施：
串行合并的 renewal 链（防并发续租乱序）+ finally 保证退出前最后一次续租落定；
续租失败静默（兜底在 recover）。

### process-claim.ts —— 单单管线
`decodeReceipt → settleClaim（可被 telemetry.settle 包装做 span）→ 成功出 effects /
失败进 finishFailure`。四种结局词汇表：settled / retried / dead / claim_lost
（认领被并发拿走——幂等安全，不计失败）。

### failure.ts —— 失败分类与处置
**结构化分类（classifyFailure），不做 message 文本启发式**——文案变更不得改变分类：

| 类 | 判定 | 处置 |
|---|---|---|
| serialization | PG 40P01/40001 | retry_wait（抖动退避） |
| db_transient | 08xxx/53300/57P0x | retry_wait |
| poison_receipt | PoisonReceiptError/SyntaxError/ReceiptUserMismatch | **permanent → dead** |
| invariant_violation | BillingInvariantError/BillingStateConflict/PG 23514/**wallet InsufficientBalance/AuthorizationNotActive** | **permanent → dead**（确定性失败重试不自愈；人工处置后 retry） |
| unknown | 其余 | 按 maxAttempts |

重试退避 `retryDelayMs = random × min(max, base×2^(attempt-1))`；
`safeEffect`：告警/投影 effect 2s 超时 + 吞错——失败不改变已提交的资金事务。

### run-once.ts —— 批次编排
claim → withClaimRenewal{ 并发逐单 processClaim → 结局计数 }。
claim() 抛错直接上抛（DB 级故障交 worker 循环层）。

### recover.ts —— 三类滞留兜底
| # | 滞留 | 处置 |
|---|---|---|
| ① | authorized 且租约过期且从未发上游 | released（资格判定与迁移同事务；三路预扣同步释放） |
| ② | in_flight 租约过期（网关崩溃） | released 不扣（崩溃不可被攻击者操纵；bytesRelayed 已随进程丢失，留痕 failure_code） |
| ③ | processing 认领过期（worker 崩溃） | 回 retry_wait（立即可被重领；failure_class=claim_expired） |

①②的释放走 billing/release-reservations（wallet + quota + channel 三路），
每批 SKIP LOCKED。

### inventory.ts —— 库存与停机
`inventory`：pending/processing/retrying/dead 计数 + 最老 pending 账龄（健康检查）。
`abandonOwnedClaims`：优雅停机把本副本 processing 归还 retry_wait（其他副本立即接手）。

### effects.ts + tpm-backfill.ts —— Redis 提交后效应
`createRedisBillingEffects(redis)`：balanceChanged → 清余额缓存；usageSettled →
**TPM 回填**（预占 hash 每维释放；实际用量只记收据归属维——failover 试过的渠道/模型
不计入 actual，防虚增误触限流）。Redis 只承载投影，不参与资金事务。

### queue-contract.ts
`BILLING_SETTLEMENT_QUEUE = 'billing-settlement'`；wakeup payload 只有 `{requestId}`。

## 3. 装配

```ts
createSettlementProcessor({ db, wallet, options, effects?, clock?, random? })
// options: { ownerId, batchSize, concurrency, claimLeaseMs, retryBaseMs, retryMaxMs,
//            maxAttempts, recoveryBatchSize?, telemetry?: { settle(claim, next) } }
// → { runOnce(requestIds?), recoverOnce(), inventory(), abandonOwnedClaims() }
newProcessorOwnerId(prefix?)  // `${prefix}:${uuid}`，健康面板区分副本
```

并发上限必须显式（`Math.min(batchSize, concurrency ?? 1)`）——不得靠 Bull 并发间接放大
（单 processor 同时持有的 claim 数是资源契约）。

## 4. 多副本安全性小结

认领互斥（SKIP LOCKED + claim 三元组 CAS）· 租约防重排（保活 + recover③ 只认过期）·
结算互斥（settle 的 CAS 终态迁移）· 幂等兜底（usage_logs 唯一键 → already_settled）。
四层叠加下，双 worker 双结算在结构上不可能。

## 5. 测试（5 例）

runOnce 批量认领结算（settled 计数 + wallet 实扣 + 在途归零）、
毒收据 → dead（不扣款、wallet 在途保持）、
授权过期恢复 → released + wallet 在途归还余额不动、
in_flight 租约过期（网关崩溃）→ released 释放不扣、
processing 认领租约过期（worker 崩溃）→ retry_wait 重领并完成结算（不丢钱）。
