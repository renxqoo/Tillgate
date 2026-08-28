# DB 并发预算门信号感知（客户端断连 × 停机排水）方案

> 状态：已核销（2026-08-28）
> 级别：中（模板 B）
> 前置事实：db-budget 中间件（`packages/http/src/middleware/db-budget.ts`）已落地预算钳制
> + FIFO 排队 + 溢出/超时 fail-closed（live-fire FINDINGS F-6 / R-3 已核销）。本方案补
> **排队等待期的取消感知**——HA 复审识别的两项缺口：
> 缺口 A（幻影负载）：客户端断连后排队请求仍占槽，被授予后对死连接执行全链 DB 工作；
> 缺口 C（停机拖 drain）：排队请求收不到停机信号，只能干等 waitTimeout 出局。

## 契约

1. **`DbBudgetOptions` 新增可选字段 `drainSignal?: AbortSignal`**（纯加法：缺省 = 无
   drain 感知，行为与现状逐字节一致；非兼容层、无双轨）。
2. **中间件新增三条取消路径**（每条恰好一次出局，均不占预算、不执行业务链）：
   - 入口即断连（`c.req.raw.signal.aborted`）→ `http.db_budget_abandoned`
   - 排队中断连（abort 事件）→ 出队 + `http.db_budget_abandoned`
   - `drainSignal` abort → 全体排队者出队 + `http.db_budget_draining`；
     drain 后新到请求立即 `http.db_budget_draining`（不再排队）
3. **新码 ×2**：`db_budget_abandoned` / `db_budget_draining`，category `unavailable`
   （→503 + Retry-After，客户端/LB 可安全重试）——沿 `db_budget_full`/`db_budget_timeout`
   既有裁决；目录码集 17 → 19。
4. **优先级固定**：探针旁路 > drain 拒流 > 断连短路 > 预算检查——探针在风暴与停机期
   都必须直通（LB 摘除探活不能停，否则实例被误判死亡）。
5. **出局清理不变量**：每条出路（授予/超时/断连/drain）同步拆除其余唤醒源
   （`clearTimeout` + `removeEventListener`）；`drainSignal` 全进程恰一个 `once` 监听。

## 问题域

- 处理：排队等待的四源取消竞态收口（grant/timeout/abort/drain）、入口断连短路、
  监听器与定时器生命周期、gateway/admin-api/client-api 三条公网 ingress 接线。
- 不处理：
  - **已授予（inflight）请求的断连取消** → 业务语义域：gateway 推理链已把
    `c.req.raw.signal` 贯通上游 fetch 与终止分类（server_draining/request_cancelled）；
    机制中间件不粗暴取消在途业务与计费。
  - **waitTimeoutMs/maxQueue 配置化** → 信号感知落地后 timeout 绝对值不再产生幻影负载
    （LB 掐断连接 → 请求即时出队放弃），120s 定值在任意 LB 超时配置下安全；无真实
    部署 LB 参数前不建推测性配置面。【默认裁决，否决窗口】
  - **分布式/用户维度准入** → FINDINGS F-2 挂账的独立机制（admitRequest 并发维度）。
  - **admin/client 的 drain reason 分类** → `ServerDrainAbort` 是 gateway 推理终止分类
    专属语义（@tillgate/ai）；admin/client 用裸 `abort()`——预算队列只关心 aborted
    布尔事实，不消费 reason。

## 并发/一致性预算

- `drainSignal` ≤ 1 个监听（`once`，中间件工厂装配期挂载一次）。
- 每排队请求恰 1 个 timer + 1 个 abort 监听；四条出路任一触发后同步拆除其余
  （cleanup 幂等；timer 保证排队者必然出局 → 无监听器/定时器泄漏）。
- 授予与超时/断连无竞态窗口：`release() → grant()` 同步段无 await，timer 与 abort
  事件均为后续宏任务；超时/断连先 `splice` 摘除自己再 reject，名额不可能发给已出局者。
- 队列摘除 O(n) ≤ maxQueue 20,000（既有不变量，微秒级，不引入堆/链表）。

## 拆分

- `packages/http`：`src/middleware/db-budget.ts`（核心机制）、`src/errors/catalog.ts`
  （+2 码）、`__test__/db-budget-middleware.test.ts`、`__test__/catalog.test.ts`。
- `apps/gateway`：`src/db-budget.ts`（`gatewayDbBudget` 加可选 `drainSignal` 参）、
  `src/index.ts`（`toAppDeps` 传入既有 `drainController.signal`）、
  `__test__/db-budget.test.ts`（透传断言）。
- `apps/admin-api`：`src/index.ts`（建 `AbortController` + `dbBudget` 注入 + shutdown
  接 drain）、`src/shutdown.ts`（`drain` 可选透传——形状对齐 runtime `ShutdownDeps`）。
- `apps/client-api`：`dbBudget` 整体经 `AssemblyOverrides` 注入（新增可选字段——
  进程入口持有停机排水 controller，与 gateway 的 index-owned-controller 同形态；
  装配根文件已贴 400 代码行上限，不在此扩面）、`src/index.ts`（controller + 预算
  构造 + shutdown 接 drain）、`src/shutdown.ts`（drain 可选透传）、
  `__test__/shutdown.test.ts`（透传断言）。

依赖方向：apps → `@tillgate/http`（既有）；不新增任何包依赖
（AbortController/AbortSignal 是 JS 平台内建，Bun 原生支持）。

## 实施顺序

- 阶段 1（packages/http）：错误目录 +2 码 → 中间件四源取消 → 单测
  （新用例先在旧实现上验证失败，再实现转绿）。
- 阶段 2（apps 接线）：gateway（复用既有 drainController）→ admin-api → client-api。
- 阶段 3：根四门 + http 包覆盖率 + 收口核销。
- 无过渡态：`drainSignal` 可选字段是纯加法，收口即单轨。

## 裁决

- drain 语义 = 宽限耗尽时 abort（沿 gateway `b3d62d3` 既有裁决，推广到另两个
  ingress；排队请求在宽限内仍有机会被授予自然完成）。【默认裁决】
- 两新码均 `unavailable` → 503 + Retry-After（沿目录既有裁决）。【默认裁决】
- 入口断连短路（沿 gateway 路由消费 `c.req.raw.signal` 的既有行为，一致推广）。【默认裁决】
- 不做 timeout/queue 配置化（理由见问题域「不处理」）。【默认裁决，否决窗口】

## 测试口径

- 契约断言：目录码集封闭（17→19，两新码 category/message/zh）；`drainSignal` 缺省时
  既有四用例（FIFO/溢出/超时/探针旁路/推导）全绿不变。
- 边界清单：入口即断连（不占预算——后续请求仍可直通）；授予后断连（无 late-reject，
  请求照常完成）；drain 后探针仍直通；drain 后新到立即拒；超时先于断连的竞态。
- 并发断言：多排队者混合断连后 FIFO 保序；drain 清队不误伤已授予者；无双重结算
  （出局者 `next` 永不被调用）。
- 分层：单元（http 中间件 + 目录）/ 契约（gateway 透传矩阵、client shutdown 透传）；
  装配级接线（index.ts/assembly.ts 属进程入口，类型锁 + 条件型 real 门覆盖）。
- 表驱动：错误码表（2 新码条目）+ gateway 预算矩阵（既有 10 行不动，加透传行）。

## 验收清单

- [x] 契约 1-5 逐条落地（drainSignal 可选字段纯加法；三条取消路径 + 两新码 +
      优先级 + 出局清理不变量——中间件测试 6 新用例锁定）
- [x] 边界清单逐条有测试锁定（入口断连不占预算 / 授予后断连无 late-reject /
      drain 后探针直通 / drain 后新到立即拒 / 超时先于断连竞态）
- [x] 并发/一致性预算 4 条逐条（drainSignal 恰一 once 监听——代码结构保证；
      每排队者 1 timer + 1 监听、出路恰一——cleanup 幂等 + 测试；
      release→grant 同步段无 await；摘除 O(n) ≤ 20k 维持）
- [x] 四门 + 覆盖率：根 typecheck 34/34、build 20/20、test 34/34 全绿；
      根 lint 唯一失败在 `@tillgate/inference`（他人在途 `buildReceipt`/`settleStream`
      超 50 行,与本方案无关——本方案四个 workspace lint 0 警告 0 错误）；
      http 包覆盖率 99.26 lines / 96.59 branches / 100 functions / 99.59 statements
      （阈值 90/85/90/90 只升不降;db-budget.ts 100/93.33/100/100）
- [x] 条件型未跑如实列出：live-fire 大规模负载与 `*.real.test.ts` 属 opt-in
      不进默认门（依赖外部环境与凭证,本次未运行）;装配级入口接线
      （三 app 的 index.ts）由类型锁 + 上述 shutdown/透传测试覆盖
