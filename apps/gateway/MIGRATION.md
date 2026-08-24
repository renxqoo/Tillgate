# gateway app 迁移文档

> 状态：已完成并核销（app 本体 + e2e 归组切片均收口：单元 126 + 全栈 real 4/4 +
> e2e 默认门 6 文件 27 用例 + rxm3 真上游 real 4/4 + 双形态进程冒烟；四门与覆盖率
> 全绿；实施期抓出并修复三个真缺陷——见 §8 e2e 切片段）
> 迁移单元：「客户端凭证经公网入口完成一次推理请求」（鉴权/限流/计费衔接/协议出站）
> 旧实现：`/Users/wrr/work/ai-getway/apps/gateway`（app 层 12 文件约 3.1k 行 + app 层测试
> 12 文件约 3.9k 行 + e2e 7 文件 + kit 约 2.7k 行；pipeline 族 5.9k 行已迁 inference）
> 目标位置：`apps/gateway`（+ 五包接缝补件，见 IMPLEMENTATION §4）
> 关联：DESIGN.md §5 裁决 / IMPLEMENTATION.md §2 裁决表 / 重构方案 §3、§5、P5

## 1. 行为规格基线（旧测试 = 行为规格）

| 旧测试（apps/gateway/src/**tests**）         | 用例 | 测什么                                                         |
| -------------------------------------------- | ---- | -------------------------------------------------------------- |
| app.test.ts                                  | 9    | 探针、错误映射 7 类、鉴权全路径、JWT 锁定                      |
| routes/**tests**/inference-endpoints.test.ts | 11   | 9 端点契约、codec 往返、multipart、oauth                       |
| config-security.test.ts                      | 6    | 配置 fail-closed 全族                                          |
| security-fixes.test.ts                       | 4    | requestId 服务端生成、脱敏、502 不泄漏                         |
| final-hardening.test.ts                      | 2    | 限流并罚、playground JWT 退役                                  |
| production-hardening.test.ts                 | 6    | 限流/爆破全族（假 limiter 注入）                               |
| shutdown.test.ts                             | 3    | drain 顺序/宽限/幂等                                           |
| surface.test.ts                              | 6    | 目录形状、CORS、安全头、413、404、requestLog                   |
| v1-parity.test.ts                            | 6    | livez/engines 别名/SSE x-request-id/三协议目录/gemini 计费闭环 |
| oauth-appjwt.test.ts                         | 3    | 签发→鉴权闭环、错 secret、Basic                                |
| upstream-smoke.test.ts                       | 3    | 真 ai + mock 上游：usage 归一、SSE 透传、换渠 502              |

**删除的用例**（机制已裁决移除 ≠ 功能缺失）：

- pipeline/quote/output-cap/overflow-alert/billing-partial/billing-stream-receipt 六文件
  （inference 波已改写核销，出处 inference MIGRATION §1）。
- architecture.test.ts 的 v1 包名白名单（v2 白名单重写，IMPLEMENTATION §3）。

## 2. 审计结论引用

app 层 A1–A9 见 IMPLEMENTATION §1；inference 族 B1–B11 见其 IMPLEMENTATION §1。
本波新登记：**B-G1**（A1 落位 accounts）、**R-E1**（错误码命名空间化，DESIGN §2.3）。

## 3. API 对照（要点）

| 旧签名/形态                                     | 新签名/形态                                                                  | 变化理由                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `createApp(deps: {db, runChat?, ...})`          | `createGatewayApp(deps: {inference, accounts, ...})`                         | P5：app 持 facade 不持 Db；runChat → inference.chat/stream |
| `runChat(ctx, input) → ChatResponse 三态`       | `inference.chat/stream → ChatDelivered/StreamDelivered/PassthroughDelivered` | inference 波已裁决；app 只做信封                           |
| `apiKeyMiddleware(db, guards, jwtSecret, opts)` | `apiKeyMiddleware({resolveKey, resolveApp, guards, jwt})`                    | 读模型注入（accounts facade 面）；Db 出签名                |
| `repos.modelMapping.listEnabledModels`          | control-plane `reader.listEnabledModels`                                     | 目录所有权                                                 |
| `repos.generationTask.findByOwner`              | `inference.generation.query`                                                 | 端口化                                                     |
| `createSettleWakeupProducer`                    | `adapters/settle-wake.ts`                                                    | C-G8                                                       |
| `mapErrorToHttp` 24 条 instance 表              | 目录组合 + override 表（error-face）                                         | §11 体系；status 逐条等价                                  |
| error code `insufficient_balance`               | `billing.insufficient_balance`                                               | R-E1                                                       |

## 4. 错误码核销表（v1 24 条 → v2）

| v1 code/status                                                                                                                                                                   | v2                                                                                           | 备注                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| invalid_amount/invalid_ref/invalid_operation_id 400                                                                                                                              | billing.invalid_amount / billing.invalid_ref / billing.invalid_operation_id（invalid_input） |                                                    |
| insufficient_balance/insufficient_cash 402                                                                                                                                       | billing.*（quota_exhausted）                                                                 |                                                    |
| daily_spend_limit_exceeded 402                                                                                                                                                   | billing.daily_spend_limit                                                                    |                                                    |
| member_daily_limit_exceeded/member_quota_exceeded 402                                                                                                                            | billing.*（U4 码表核对）                                                                     | 实施期核对目录键名                                 |
| subscription_required 402 / subscription_quota_exhausted 402                                                                                                                     | billing.subscription_required / billing.*                                                    |                                                    |
| billing_backlog 503                                                                                                                                                              | billing.settlement_backlog（unavailable）                                                    | 实施期核对                                         |
| rate_limiter_unavailable / auth_guard_unavailable 503                                                                                                                            | runtime infrastructure 渲染 503                                                              | v2 三性体系                                        |
| subscription_forbidden 403 / account_frozen 403                                                                                                                                  | billing.*（forbidden）                                                                       |                                                    |
| ref_key_conflict/idempotency_conflict/operation_conflict/billing_state_conflict/authorization_not_active 409                                                                     | billing.*（conflict）                                                                        | B10 重放 409 对照回写（billing §8-3 挂账本波核销） |
| settle_exceeds_hold/poison_receipt/receipt_user_mismatch/billing_configuration 422                                                                                               | billing.*（invalid_input）                                                                   |                                                    |
| invariant 三类 500                                                                                                                                                               | defect 渲染 errors.unhandled                                                                 | 不透传语义保留                                     |
| unauthorized 401 / not_found 404 / invalid_body 400 / rate_limit_exceeded 429 / model_not_found 404 / no_available_channel 503 / upstream_failed **502** / payload_too_large 413 | http/gateway/inference 目录码 + override                                                     | 502 必须 face override                             |
| invalid_client 401 / unsupported_grant_type 400                                                                                                                                  | gateway.*（OAuth 标准错误形）                                                                | A9                                                 |

## 5. 显式挂账（不迁清单）

- **e2e-worker.test.ts**：消费端 worker app 未建（worker 波）；迁 `e2e/billing-recovery` 届时同波。
- **e2e-rxm3.test.ts**：真上游 MiniMax 凭证隔离，单列 `*.real` 契约测试不进默认门禁。
- 生成任务轮询/结算落账、死凭据永久拉黑、overflow/dead-credential 告警订阅：worker /
  control-plane / observability 波（inference MIGRATION §5 同源挂账）。
- `GENERATION_MAX_ACTIVE_PER_USER` 并发上限：未迁（v1 已是废弃键告警语义）。
- B7 dead-credential 告警 dedupeKey 缺陷随迁 control-plane 时消亡（inference B7 同裁决）。
- **OpenAPI 生成链（gateway.json）**：总纲 §3 目标态含 `generated/openapi/gateway.json`，
  本波未建 registry（admin-api 已建同款链可作模板——`src/http/openapi/` 13 件约 2.3k 行
  - `scripts/generate-openapi.ts` + 逐字节重生成测试）。gateway 契约含 SSE 流式语义与
    OpenAI 信封，先出设计文档（铁律 13）再建；生成链接入前手写 DTO 快照为唯一事实源，
    禁止双轨（总纲 §2.2）。同源挂账：client-api MIGRATION §8-4。
- **trace 领域 span 缺生产者（T1，2026-08-23 trace 审计）**：v1 `upstream.attempt`/
  `billing.*` span 族未迁——gateway HTTP 根 span 是全仓唯一 span 生产点，
  `/v1/tracing/topology` 恒空、trace_spans channel/model 提升列恒 NULL。词表两端
  （observability graph + admin 链路图）已在，只缺生产者；恢复属 inference/observability
  后续波（见 observability IMPLEMENTATION §7 T1 全记录，含配置断点修复记录）。

## 6. 回滚方案

- 每阶段独立提交可 revert；旧仓只读不新增（§9.1 并行规约）。
- 无 DDL：本波零 schema 变更（generation_tasks 0053/0054 已在库），回滚无数据动作。
- 包补件均为加法（runtime/inference/control-plane/accounts 新出口），gateway 删除即整体还原。

## 7. 验收（全部满足才算完成）

- [x] 四门全绿（typecheck/lint 0-0/build/test），覆盖率 ≥ 90/85/90/90（apps 口径同 trace-receiver）。
- [x] 行为对照清单逐项核销：鉴权双形态全路径、9+3 端点契约、错误码×status 表（§4）、
      SSE 透传字节等价、requestId 服务端生成、限流并罚与 TPM 归还、爆破双维、
      oauth 三形态闭环、multipart 白名单、目录三协议形状、停机顺序、readyz 双探。
- [x] e2e/gateway 归组文件断言语义与 v1 逐条等价（仅码表/装配面适配——适配清单
      见 §8 e2e 段：线名 max_completion_tokens、⑮ connect→deadline 旋钮映射、
      ② 「拉满再掐」形态适配需求耦合 relay、渠道/映射 id 取世界种子值）。
- [x] 双形态进程冒烟通过（bun 源码 / node dist：探针×3、鉴权 200/401、真请求 200、
      SIGTERM 优雅退出 0、结算对账）；冒烟数据自清（隔离 schema drop cascade）。

---

## 8. 实施记录（2026-08-23 收口）

- **交付**：apps/gateway 23 源文件（config/assembly/app/index/shutdown + http/{contracts×2,routes×6,middleware×4,face×2,sanitize} + adapters×3）
  - 能力包接缝五件（runtime 限流/爆破、ai codec 出口、inference 端口扩展+pg 任务存储、
    control-plane 只读目录+composition、accounts 资金解析器）。
- **门禁**：typecheck/lint 0-0/build；单元 126 用例 13 文件；real 门——gateway 全栈
  4/4（真 PG+Redis：探针/catalog 系数三层/Key 鉴权/oauth→models 闭环）+ 各包 real
  （inference generation-pg 3/3、accounts funding-resolver 3/3、runtime 真件 17 用例）。
- **覆盖率**：94.49/86.29/92.56/96.06 ≥ 90/85/90/90；index.ts/assembly.ts 排除口径
  （vitest.config 注释在案：装配面由 real 全栈测试覆盖，单测无注入缝不造假）。
- **新增裁决补录**：R-E2（App-JWT 解析键 apps.app_id 字符串——签发/验签同端配对）、
  R-E3（模型维 TPM 与渠道维 TPM 预占缓迁——inference admitChannel 钩子无请求作用域
  生命周期；渠道维 RPM 已实现）、R-E4（admission 桥级调用——requestId 恒服务端生成，
  HTTP 面无客户端重放路径，不破坏 billing 内部重放免疫）。
- **真实缺陷修复（实施期发现）**：request-log 摘要嗅探原用 c.req.json() 会吞掉
  multipart 原始流（v1 用 raw.clone()——迁移走样，测试抓出后改回同款）。
- **e2e 归组（§1/§5）**：v1 e2e-kit 深绑 v1 装配与 worker，独立切片跟进——
  attack/params-floor/cost-drain/slow/auth-audit → e2e/gateway|security；rxm3 真
  上游单列 real；worker 跨 app 缓迁（§5 原案）。
- **并行会话协调（ironlaw 15）**：共享 barrel（runtime/ai/inference/accounts 各
  index 与 composition）混有 ADR-0004 波在途行——本提交不含，工作区完整可跑。

---

## 9. e2e 归组切片收口（2026-08-23 第二波）

- **归组落地**：attack/params-floor/slow → `e2e/gateway/`；auth-audit/cost-drain →
  `e2e/security/`（安全/资损旅程）；rxm3 → `e2e/gateway/rxm3-upstream.real.test.ts`
  （真上游 real 门，默认排除）；worker 维持 §5 挂账（worker 波）。双形态进程冒烟
  `e2e/gateway/process-smoke.test.ts` 进默认 e2e 门。
- **装置（e2e/gateway/kit.ts + upstream.ts）**：隔离 schema（全迁移链回放 + 42P01
  容错，同 settlement-lifecycle 范式）+ 脚本化 mock 上游（openai-compatible 协议族，
  九种脚本覆盖全部向量）+ 全真装配网关 + key 台账/结算驱动/对账。种子事实沿用
  v1 dev 库口径（RX-M3 → MiniMax-M3、2.1/8.4/0.42）——断言值零漂移；v1 的共享库
  预算快照/逐表清理/熔断复位等手法由 schema drop 与 resetChannelHealth 替代。
- **断言语义等价 + 装置适配清单**：转发参数线名 `max_tokens` → `max_completion_tokens`
  （v2 协议归一）；⑮ connect 旋钮 → `GATEWAY_UPSTREAM_DEADLINE_MS`（v2 connectMs
  只管建连，慢响应归 totalMs 支配——两分支旋钮语义保持）；② 「拉满输出再掐线」
  形态改为读完全部帧后断线（v2 relay 需求耦合，网关只累计已交付内容——计量口径
  与交付一致，攻击面不放大）；渠道/映射 id 取世界种子值（v1 dev 库硬编码 id 的
  装置适配）。
- **rxm3 real（4/4 通过，真 MiniMax）**：dev 库渠道 2 凭据克隆进隔离 schema（明文
  key 测试密钥重加密——预算/熔断与 dev 环境互不干扰）；①流中取消 ②上游未返取消
  ③低余额并发（4 放行/4 拒绝、亏损 ≤ 单笔级）④5 用户×4 并发（20/20 成功、逐用户
  分毫对账）。E2E_REAL_UPSTREAM=1 显式 opt-in。
- **真实缺陷修复（e2e 抓出，按 ironlaw 6/16 记录）**：
  1. **流式结构性死锁（ai/inference 接缝，阻断级）**：TransformStream 需求耦合——
     relay 的 first_chunk 事件源（transform）只在客户端读响应流时执行，而 inference
     的 decisive 锚等 first_chunk 才交还路由 → 两侧互等，v2 网关流式从未真正通过
     （单测都有读侧需求所以从未暴露）。修复：ai chatStream 在 relay 挂好后合成
     first_chunk（peek 已锁定上游首字节）+ 事件总线一次性事件幂等缓冲重放
     （packages/ai stream-report.ts / create-ai.ts）。ai 包 365 单测全绿回归。
  2. **tee 分支 cancel 语义（ai peek）**：`tee()` 后单分支 `cancel()` 在现代运行时
     （bun 1.4 / node 22/24 实测）等两分支齐 cancel 才 resolve，且挂起时另一分支
     pipeTo 停摆。修复：peekFirstChunk 改原始 reader 直读 + 回放式 rest 包装（契约
     不变，零 tee）。
  3. **control-plane dist 缺 JSON 资产（打包缺陷）**：`--packages=external` 把
     models-dev-snapshot.json 留成运行时 require 但构建不拷贝——dist 形态必挂
     （进程冒烟暴露）。修复：build 脚本补 cp；gateway devDeps 补 pino-pretty
     （bun 子进程 transport worker 解析口径）。
- **运行装置**：根脚本 `test:e2e` / `test:e2e:real` / `test:e2e:smoke`（smoke 已入
  默认门——脚本保留作单独入口）；`e2e/node_modules` 符号链接到 apps/gateway/
  node_modules（e2e 非 workspace 包，gateway 依赖闭包覆盖；说明见 e2e/README.md）。
- **门禁（切片收口态）**：gateway 四门全绿；单元 126 + 覆盖率 94.32/86.51/91.6/95.92
  ≥ 90/85/90/90；real 门 gateway 全栈 4/4；e2e 默认门 6 文件 27 用例全绿（41s）；
  e2e real 门 4/4（真上游）；ai/inference 包回归全绿（ai 的 2 个 max-lines lint 错
  为并行波在途文件与未提交 lint 配置的碰撞，非本切片引入，在案待其收口）。
