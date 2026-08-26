# live-fire 红队压测 —— 发现记录（2026-08-26，80/80 全过后归档）

> 现场证据：`logs/*.log`（每次 run 覆写）；复跑 `bun e2e/live-fire/run.ts`。
> 本文件不入库（e2e/live-fire 整目录未跟踪）。

## 缺陷（需要修）

### F-1【高】单条结算失败可击穿 worker 进程（毒账单 = 结算系统拒绝服务）——✅ 已修复（2026-08-26，BullMQ 结算调度 + NaN 防护；验收 = live-fire P1 用例 + 81/81 全量回归，见 apps/worker/IMPLEMENTATION.md「增量：BullMQ 结算调度」）

复现链（`logs/worker.log` 留有完整堆栈与参数）：

1. 结算事务内 `usage_logs` 插入失败（本例：用户行已删 → FK 拒插；任何持久性
   约束错误同理）→ 进入失败路径；
2. `settleFailurePolicy`（`packages/billing/src/domain/billing/settle-failure.ts`）
   计算 `retryInMs = baseDelayMs * 2 ** (attempt - 1)`，attempt 为 undefined 时
   得 **NaN，无防护**；
3. `casToRetryOrDead` 的 SQL `clock_timestamp() + ($2 * interval '1 millisecond')`
   收到 NaN → PG `interval_mul` 越界错（22008）；
4. **错误处理路径自身抛错** → 逃逸 `runSettlementBatch` 的 `Promise.all`
   （`apps/worker/src/jobs/settlement.ts`，无 per-claim catch）→ 未捕获 →
   **worker 进程退出**。毒账单被 recover 反复重领 → 反复打崩。

最小修复（~10 行，不动架构）：
- `settle-failure.ts`：对 attempt/retryInMs 加 `Number.isFinite` 防护，非法值
  直接判死信（毒账单该进 dead 人工复核，不该杀进程）；
- `settlement.ts` 批处理：`claims.map` 加 per-claim try/catch；`finishFailure`
  自身再包一层（失败处置失败 → 记日志放弃本 claim，等 lease 恢复）。

### F-2【中】单用户高并发耗尽网关 DB 池 → 跨用户 500 —— 🟡 资金层已根治（2026-08-26 C2：钱包原子条件更新 + 按需串行，authorize 层 55×），剩余为池容量层：A 用户并发准入（裁决默认 8）/ B pgbouncer / E PG 容量，挂账待后续

证据：池 12 时 100 并发即 500（`timeout exceeded when trying to connect` ×700+）；
池 40 时 200 并发单用户仅 ~39 成功 / 161 有界拒绝；**资金全程精确**（X10 三不变量过）。

机理：单用户钱包行 `FOR UPDATE` 串行（资金安全正确设计）× 每请求持连接时间
被串行链放大 → 池 checkout 排队超 `connectionTimeoutMillis=5s` → 500；一个用户
的突发拖累全部用户。

对症方向（按性价比）：
1. 生产 `DB_POOL_MAX` 按 PG `max_connections` 预算配足 + 前置 pgbouncer
   （transaction pooling，应用连接与 PG 后端解耦）；
2. `admitRequest` 增加用户维度「并发信号量」（Redis，在碰 DB 前钳住单用户
   in-flight；rpm/tpm 数据面已就绪，缺并发维）；
3. 缩短锁持有：authorize 钱包锁段瘦身，或 `SELECT FOR UPDATE` 链改原子条件
   更新（`UPDATE ... WHERE balance+credit-in_flight >= hold RETURNING`）；
4. authorize 事务加 `lock_timeout`（快速失败优于排队 5s 撑爆池）。

## 观察项（已记录，后续解决 —— 2026-08-26 约定）

### O-1【低】空补全计费口径不一致

- 上游 200 + 响应流死灭 → 网关按 **empty completion 成功路径**处理：按估算计费
  （不免费），落 1 条 usage_logs（F10 实证）；
- 上游 200 + 空 JSON 体 → **failed 路径**：released 零扣费（B4 实证）。
- 两个方向资金都安全（保守多收 vs 释放），但同类异常两种结果，建议统一口径
  （倾向：都走「估算计费」的保守侧，或都走「零交付零收费」侧，择一）。

### O-2【低】responseModelRewrite 默认关（上游可影响客户端可见 model 字段）

上游回显伪造 model（`wrong-model-echo`）时，客户端响应的 `model` 字段原样透传
（B13 实证；计费不受影响，仍按对外目录价）。`packages/ai/src/transport/model-rewrite.ts`
注释明确「可配置开关、默认关」——是 §3.6 已文档化的设计决策，非缺陷；
建议评估生产默认开启（低成本消除一个信息面）。

## 参考（非问题）

- key 数量无上限（设计=数量自由）：60 key 秒建、服务不降级（C17）；如需防刷库可加上限。
- 容量观测（池 40 / 单实例 dev PG）：200 并发单用户墙钟 ~5.3s，成功 39/200；
  50 并发（5 用户）全部成功 ~0.8s。天花板本质见 F-2。
- 防守全过的面：见 run 汇总（80 用例：计费精确/薅羊毛全防/上游全谱故障零资损/
  鉴权零突破/挑战 CAS/熔断死凭据止血/failover 恰好一次计费/worker 崩溃恢复
  恰好一次结算/停摆 fail-closed/终极三不变量）。

## 增补：高并发支撑专项（2026-08-26 第二轮）

### 已修复

- **F-3【高】request-log 的 clone 嗅探在 @hono/node-server 下破坏请求 body**
  （`Body has already been read` → 路由读到 null → 高并发下大面积 400；undici
  类客户端 100% 触发）。修复=数据流反转：路由是唯一 body 消费者，摘要经
  context 交接给日志面。语义变化：401/429 请求不再有 requestSummary（本来
  也不该为日志去碰未鉴权请求的 body）。
- **F-4【高】bun runtime 跑网关在高并发下 PG 连接全灭**（idle-in-transaction
  悬挂、CPU profile 99% idle、200 并发 0 成功）。生产形态 = node dist
  （repo process-smoke 双形态本就支持）；`bun --watch src` 仅限低并发开发。

### 达标数据（live-fire X11，node 网关）

- 多用户 200 同瞬并发（40 用户 × 5）：**200/200 全成功、604ms 墙钟、零 5xx、
  逐用户金额精确对账**（全量 80/80 含此断言）。
- 单用户 200 并发（X8 观测）：共享 dev 池 40 下成功数随宿主负载波动（0~39）——
  池容量层（F-2 残余：pgbouncer/池扩容/准入）。

### 挂账：undici 客户端 × node 网关的窗口性池死锁（F-5，未闭合）

- 症状：200 同瞬并发下 pg-pool acquire 永久挂起（5s/60s 双超时确认永久性），
  单请求正常、爆发后正常（窗口性、非泄漏）；bun fetch 客户端不触发。
- 已排除：runtime（bun/node 均测）、裸 pg-pool/事务/多次 acquire/真实 drizzle
  最小复现（全部健康）、request-log、rate-limit、Redis guards、DNS/IPv6、
  fd 上限、libuv 线程池、mock 上游。
- 池内 dump（SIGUSR2 探针）：死锁时 95 个 acquire 未 settle、_pendingQueue=0、
  idle 连接存在但不分配——疑似 pg-pool 3.14 与 bundle 形态的交互缺陷。
- 影响评估：OpenAI node SDK（undici 系）高并发同瞬打点会触发；生产以
  pgbouncer 前置 + 客户端连接池配置缓解，根因需专项（pg-pool 升级/
  @tillgate/db 池层替换为自管信号量队列候选）。

