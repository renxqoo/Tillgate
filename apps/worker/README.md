# @tillgate/worker —— 后台任务应用

七类后台 job 的调度与进程生命周期壳（结算/恢复/生成轮询/佣金/告警/对账/分区）；
业务全部来自能力包 facade，本 app 无业务 HTTP。结算调度由 BullMQ/Redis 承载，
PG `LISTEN settle-wake` 作低延迟门铃，PG 状态机与恢复扫描作确定性兜底。

相关 [ADR-0007](../../docs/adr/0007-apps-assembly-ai-injection.md)

## 核心能力

- **七 job**（v1 八循环对位；缺省值唯一真相在 config）：settle 结算扫描（30s）、recover 滞留恢复（15s）、generation 生成任务轮询（5s，含 music 代执行）、referral 佣金日结（1h，7 日回补）、notify 告警投递（15s，`WORKER_NOTIFY_ENABLED` 可关）、reconcile 周期对账（1h，advisory lock 单副本 + 差异告警入箱）、partitions 分区维护（1h；trace 保留 7 天 / 请求日志 90 天）
- **低延迟唤醒**：PG `LISTEN settle-wake` 消费端（生产端 = gateway `pg_notify` 纯门铃；`WORKER_SETTLE_WAKE` 可关，丢失由兜底扫描覆盖）
- **健康端点**（独立 HTTP，`WORKER_HEALTH_PORT` 缺省 `8792`，0 = 关闭）：`/livez` 反映进程存活，`/readyz` 验证 scheduler+PG+BullMQ Redis；`/health` 深度报告需请求头 `x-health-token`（timingSafeEqual；`WORKER_HEALTH_TOKEN` 未配置 = 恒 403）
- **优雅停机**：停收批次 → 在途宽限（`WORKER_SHUTDOWN_GRACE_MS` 15s）→ 归还本副本认领 → 连接收口

## 目录结构（src/）

```
config.ts      # env zod schema（job 节奏/批量/租约/退避/令牌/逃生门）
assembly.ts    # 唯一装配根（七段：观测/db → billing → notifications → inference poll → 佣金 → 对账 → jobs/wakeup）
bridge-mappers.ts # 装配桥接纯映射（billing 信号/渠道行形状）
jobs/          # settle / recover / poll / referral / notify / reconcile / partition
wakeup/        # postgres-notify.ts（LISTEN 专用连接）
health.ts / scheduler.ts / shutdown.ts / index.ts
```

## 配置与端口

- 必填：`DATABASE_URL`、`ENCRYPTION_KEY`（≥32，对称加密根键——渠道上游 Key 与 integration settings 解密共用，与全服务同值）
- 选配：`SMTP_HOST/USER/PASS` 三要素（缺一 = 不装配，email 渠道 fail-closed）；逃生门 `WORKER_AI_ALLOW_LOCAL_URL` / `WORKER_WEBHOOK_ALLOW_LOCAL_URL`（缺省 false，仅非生产语义）
- 常用缺省：`WORKER_OWNER_ID=worker-<pid>`、`WORKER_BATCH_SIZE=20`、`WORKER_CLAIM_LEASE_MS=60000`、`WORKER_MAX_ATTEMPTS=10`、`WORKER_BALANCE_LOW_THRESHOLD=5`
- OTel：`OTEL_TRACES_MODE=off|memory|console|otlp`（缺省开发 memory / 生产 off）；推送鉴权 `TRACE_RECEIVER_TOKEN`（与 trace-receiver 同键同值）

## 装配与依赖

- facade：`@tillgate/billing`（`/settlement` 窄子入口 + `/composition`、signal 四事件桥、佣金日结与对账差异用例）、`@tillgate/inference`（`createGenerationPollUseCase` + 任务 store + 内存健康存储）、`@tillgate/notifications`（`dispatchOnce` / `enqueue` / `composition.outboxWithinTx` 同事务入箱桥）、`@tillgate/observability`（`partitions.*` + initOtel）、`@tillgate/accounts`（佣金词表）、`@tillgate/control-plane/composition`（渠道凭据源）、`@tillgate/ai`（`createAi`/`assertSafeUrl`，ADR-0007）、`@tillgate/runtime`、`@tillgate/db`
- apps 互不依赖：与 gateway 共享的 billing signal 词表真相是两包的类型本身（蛇形 ↔ 点点映射在各自 adapters）

## 本地运行与测试

```bash
bun dev        # 仓库根（--env-file=../../.env --watch src/index.ts）
cd apps/worker
bun run typecheck && bun run lint && bun run test
bun run test:real     # __test__/*.real.test.ts：真实 PG 集成
```
