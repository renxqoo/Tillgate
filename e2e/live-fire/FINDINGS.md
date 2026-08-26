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


---

## 增补：bun-native 全栈形态实测（2026-08-26，Bun.serve + Bun.sql，未提交试用）

### 迁移内容（工作区未提交，等最终指令）
- 驱动：pg → Bun SQL（drizzle-orm/bun-sql）；SQLSTATE 在错误的 `errno` 字段（pg 在 `code`）——db 包 pg-error 双字段探测收敛全部本地副本（billing real-pg / 订阅单活索引 / e2e kit）。
- HTTP：@hono/node-server → Bun.serve（@tillgate/http `serveApp` 单一来源，env.server 注入供 requestIP 取 socket 对端）；client-api/admin-api/trace-receiver/gateway 四入口。
- worker 唤醒：pg Client 事件机 → `sql.listen/unlisten`（Bun 内建断线重连+重订阅；自留启动失败退避）。
- jsonb：drizzle 0.45 × Bun SQL 双重编码（drizzle#5139 / bun#28819）——db schema 全量换 customType 透传对象参数。
- vitest：全仓切 `bun x --bun vitest`（`bun` 内建在 node worker 下不可解析）；zod v4 `export { z }` 命名空间再导出在 vite-node 转换下丢失——200 文件 `import { z }` → `import * as z`。
- 语义差异（无资金影响）：Bun SQL 对 numeric 零解析为裸 '0'（pg 为定标串）——测试断言 Decimal 化；JSC Intl（¥ 符号、日期 ' at ' 分隔符）成为单形态真相。

### 结果
- 四门全绿（typecheck/lint/test 34 任务/build 20）；real 套件全绿：db 6、billing 24、worker 3、observability 11、accounts 11、control-plane 9、identity 7、inference 5。
- process-smoke 双形态（bun 源码/bun dist）通过：探针+鉴权+真实计费+SIGTERM+对账。
- live-fire **77/80**：鉴权/注册攻击/计费薅羊毛/上游故障/毒账单全绿；**X1/X2/X11（并发三连）被 F-6 阻断**。

### F-6（已解：机制确认 + workaround，2026-08-26 深夜定案）
- 症状：并发超过池连接数时，网关在途事务全体停在「下一条语句发出前」（PG 侧 idle in transaction/ClientRead，CPU 0% 纯等待），30s idleTimeout 收割转 500。
- **精确触发条件（阈值扫描实证）：并发请求数 > 池 max 即触发检出排队，排队一旦发生，在途事务停摆；失败数恰好 = 池连接数**。20 并发全过 / 40 并发（池40）全挂 / 60 并发恰好挂 40 过 20。
- 归因：Bun SQL 池「检出排队」路径丢失在途查询的响应唤醒（bun#38163/#38231 家族，上游 open）。
- **workaround：池 ≥ 峰值并发（消除检出排队）**。实测：池 210 × 200 同瞬并发 → **200/200 全成功 779ms 零 5xx**；全量 live-fire **80/80**。
- 部署约束：池上限受 PG max_connections 限制（本机已抬 400；部署形态需配套：独占 PG 预算 / 前置 pgbouncer 需评估 prepared-statement 兼容 / 或应用层准入闸把 in-flight 钳在池内）。上游修复后可撤 workaround。
- 排除矩阵（均实证）：bun fetch 客户端（curl 同结果）、prepare:true/false、池 20/40/64、fire-and-forget 请求日志、ioredis 内联 multi/exec、bun 1.4.0/canary 1.4.1、src/dist 形态、单进程迷你网关（2/10 语句事务、真 wallet.authorize 链 60 并发均 130-475ms 全过）。

## 增补：node vs bun-native 双分支 A/B（2026-08-26 深夜，同机同负载同用例）

分支：`feat/live-fire-hardening`（node dist + pg + @hono/node-server）vs `feat/bun-native`（bun dist + Bun.sql + Bun.serve）；同宿主（含 agent-work 并行负载）、同 80 用例、同 DB_POOL_MAX=210：

| 场景 | node（池40） | node（池210） | bun-native（池40） | bun-native（池210） |
|---|---|---|---|---|
| X11 200 同瞬并发 | 8~25/200（pg-pool 建连超时 500） | **200/200 @735ms** | 0/200（检出排队→事务楔死） | **200/200 @779ms** |
| 全量 live-fire | 79/80 | **80/80** | 77/80 | **80/80** |

结论：两形态都需要「池 ≥ 峰值并发」才能扛 200 突发；失效模式不同（pg-pool 建连超时 vs Bun SQL 检出排队楔死）；满足该条件后吞吐同量级（735 vs 779ms，单样本）。bun-native 无兼容层、正确性/安全用例全绿，作为未上线仓库的候选形态成立；上游 bun#38163/#38231 修复后可解除池尺寸耦合。
