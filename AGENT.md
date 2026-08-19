# AGENT.md —— 本仓库工作规则（AI 协作铁律）

> 本文是所有 AI 代理在本仓库工作的**唯一规则书**。与代码冲突时：先查本文的规则是不是被违反了，
> 是则修代码；规则本身过时则先改本文再动代码。全程中文注释、中文提交信息。
> 修复记录 / 审计历史 / 施工留痕**不写在这里**——归档在 [CHANGELOG.md](./CHANGELOG.md)；
> 扣款链路唯一真相见 [docs/billing-flow-deep-dive.md](./docs/billing-flow-deep-dive.md)。

---

## 0. 铁律（每条都是硬约束，违反 = 返工）

1. **四层架构**：`routes → Service → Domain → Repository → db`。包依赖只有两个方向：
   `service → domain`、`service → repository`。无环。
2. **业务规则只住 domain**（纯函数），**事务只住 service**，**SQL 只住 repository**，**表定义只住 db**。
3. **零写死**：一切可变值（币种、refType、失败策略参数、开关、阈值）必须装配注入且**必填**，
   不藏全局默认；同一真相只定义一次（常量单一来源，放最底层被依赖的包）。
4. **未实现 = bug**：不许「接口先行 / TODO 将来实现 / 占位」。写了接口必须有实现与调用方；
   推迟实现的功能在文档里显式挂「待办」并说明后果。
5. **一动词一文件**：一个用例/动词/规则一个文件；文件超 ~150 行先问自己是不是装了两件事。
   禁止 class 做依赖捕获（用 `createXxx(env)` 工厂闭包——repo 除外，见 §3）。
6. **重构 = 基于老逻辑重写，不是复制**：改资金逻辑前先读懂 `packages/wallet` 与
   `docs/funding-package-plan.md` 对应节的行为语义；直接复制会把老 bug 一起带来。
   发现老逻辑错误要修并记录（记入 CHANGELOG）。
7. **行为等价验证**：重构类改动必须有测试兜底且全绿才算完成（见 §5 四门）。
8. **单一形态，不留兼容层**：v1 已整体退役删除（2026-08-20，见 CHANGELOG）。仓库只保留
   一套实现；**不写兼容老代码的逻辑**——旧路径别名、双轨字段、参数双收、世代轮换窗
   一律不做，发现即删。大体量删除（整包 / 整应用）仍须用户拍板，代理不得自行执行。

---

## 1. 仓库地图

```
packages/
  db/            表定义（schema/）+ 迁移（migrations/，幂等 SQL + drizzle journal）
  repository/    全部 SQL（唯一允许 SQL 的包）；只依赖 db + drizzle
  domain/        全部业务规则（纯函数）；只依赖 decimal.js + node: 内建
  service/       全部用例（事务编排）；只依赖 domain + repository
  wallet/        双分录账本内核（库形态；service/src/wallet 是生产装配层）
  ai/            上游 LLM 适配（七协议 / SSE 中继 / usage 归一 / 估算器 / SSRF 硬门）
  core/          Redis 基建（滑动窗口限流 / 爆破锁 / 加密 / Lua 脚本运行器）
  identity(-core)/ 会话 JWT + 挑战表；http / tracing / api-client / ui / money
  ledger-core/   通用幂等资金操作内核（db schema 依赖保留）
apps/
  gateway/       网关：路由 / 推理管线 / 装配根（业务全部来自 service）
  worker/        后台循环：结算 / 回收 / 生成轮询 / 对账哨兵 / 告警投递 / 分区维护
  client-api/    用户面后端；admin-api/ 管理面后端（app 内同样四层）
  admin/ client/ Next.js 前端（BFF 持 Bearer，api-client 调用封装）
  trace-receiver/ OTLP 接收端（PG 存储，管理台链路追踪页）
```

- 域目录：`domain/{shared,wallet,rating,billing,channel-budget,subscription,generation}`、
  `service/{wallet,billing,funding,channel-budget,settlement,subscription,generation,shared}`。
- **域归属判定**（什么进共享包、什么留 app）：
  - `db` / `repository`：**全仓集中**——所有表进 db、所有 SQL 进 repository（哪怕单 app 消费），
    守卫与事务口径必须同源。
  - `domain` / `service`：**只有 ≥2 个 app 需要的业务规则/用例进包**（资金域全部在包；
    订阅生命周期、渠道充值调账同例）。
  - 单 app 域**不进共享包**：用户管理、API Key 管理、支付、促销 → `client-api/src/services/`；
    模型目录/费率卡/渠道 CRUD、管理端复核 → `admin-api/src/services/`。app 内同样四层：
    routes → app services →（需要时 app domain）→ packages/repository。
- 文档：`docs/funding-package-plan.md`（分包与资金域方案）、
  `docs/billing-flow-deep-dive.md`（扣款全流程唯一真相）。

---

## 2. Domain 层规则

1. **纯函数 + 值对象**：本仓的 domain 是函数式（快照类型 + 自由函数），不是实体方法——
   这是对经典充血模型的**有意偏离**（防的是「逻辑散落 Service」，本仓规则全在 domain 层，形态为函数）。
2. 零基础设施：不 import drizzle / pg / @ai-gateway/* / 任何 app。`architecture.test.ts` 机器强制。
3. 域内方向（禁引表，测试强制）：
   - `shared`、`wallet`、`rating` 是核下层（被引用，不引用其他域；wallet 的 money 是全系统金额唯一构造器）；
   - `billing` 是编排域，可下行引用 `channel-budget` 错误家谱；`channel-budget` 不得反向引用 billing。
4. 错误全类型化分家谱（输入/拒绝/幂等冲突/不变量），消费方 `instanceof` 判定，不靠 message。
5. 金额：一律 string 落库、`Decimal`（domain/wallet/money 的克隆实例）运算、**账本永不 round**；
   出口统一 `normalizeAmount`（PG numeric 尾零不外泄）。金额解析必须走 `parsePositiveAmount /
   parseNonNegativeAmount`（负数/NaN/科学计数法/超尺度结构性拒绝）。
6. 领域词汇（科目码 `OUTSIDE_ACCOUNT/REVENUE_ACCOUNT`、`BILLING_REF_TYPE`、`DEFAULT_CURRENCY` 类常量）
   定义在 domain 最被依赖的位置，上层只引用不重复定义。

## 3. Service 层规则

1. **一用例一文件一工厂**：`createAuthorizeUseCase(env): (ctx, input) => Result` 形态；
   `env` 是进程级依赖（db/registry/repos/clock/policy），工厂闭包捕获，不出现在调用链。
2. **只编排**：查数据 → 调 domain 规则 → 落 repo。任何比较数学/判定分支下沉 domain
   （闸门、限额、分配、失败策略全已下沉，新规则照做）。
3. **事务边界在这里**：`db.transaction(tx => ... inTx(ctx, tx) ...)`；跨用例共享事务经
   `input.tx` 注入。**三生命周期**：进程级 env → 请求级 `RunContext`（requestId/actor/traceParent）
   → 事务级 `RepoContext = inTx(ctx, tx)`。ctx 只放「谁、哪条链路」，业务参数是 command。
4. **入参/返回全 DTO**（Input/Result 接口）；服务无状态。
5. wallet 动词保持 `(ctx, input & {tx?})` 双轨（自开/加入事务）——幂等三段式的唯一冲突兜底
   重放需要在池连接重读，**不要**改成单参 RepoContext（已试过并否决，见 plan §3.11）。
6. 包内方向（测试强制）：billing→funding→wallet/channel-budget 单向；
   wallet/channel-budget/shared/funding 不得上行引用；settlement 在最上层可引全部。

## 4. Repository 层规则

1. **一表/一聚合一个 Repository 类**（本仓唯一允许 class 的地方），`createRepositories()` 组合；
   方法统一接收 `RepoContext`。TS 结构化类型即接口，不建独立接口包（有意简化）。
2. **意图化原子方法，禁止 CRUD 化**：守卫 UPDATE / CAS / SKIP LOCKED 的原子性是方法边界
   （`tryReserveQuota`、`casFinalizeSettled`、`claimPending`…）。资金不变量必须留在单语句原子边界内，
   不做 find+save 两步（会开竞态窗口）。**numeric 列经 drizzle returning 是 string——JS 侧
   比较是字典序，数值判定必须放 SQL 侧或 Decimal**（预算熔断 '9'<='10' 教训）。
3. 返回**中性行形状**（string 金额），不 import domain、不认识错误家谱——翻译在上层。
4. 事务归上层：repo 永不自开事务（`c.db as DbTx` 由 service 注入）。
5. 写路径 `c.db` 必须是事务句柄；只读路径可传连接池。
6. Db/DbTx 类型经 repository 再导出（service 不直连 db 包）。

## 5. 测试与质量门

1. **四门全过才算完成**：typecheck / lint(oxlint) / test / build。
   快捷：`pnpm exec turbo run typecheck lint build test --filter=@ai-gateway/domain --filter=@ai-gateway/repository --filter=@ai-gateway/service --filter=@ai-gateway/gateway`
2. 测试归属：domain 规则单测（零 DB，毫秒级）→ domain 包；
   用例集成测试（真实 PG，`DATABASE_URL` 缺省 `postgres://postgres:postgres@localhost:5432/ai_gateway`）
   → service 包 `src/__tests__/`；app 端到端 → app（e2e 独立通道，不进默认门禁）。
3. 数据纪律：每套件独立前缀（v2w/v2b/v2s…）+ 独立用户；wallet 腿/交易 append-only 留档
   （DB 触发器禁删），业务行按 FK 逆序清理（先 billing_reservations 再 billing_requests…）。
4. 金额断言用 `new Decimal(x).eq('0.6')` / `normalizeAmount`（PG 尾零）。
5. 架构边界测试必须存在且跟随结构演进（domain 禁引表 / service 禁 drizzle+db /
   gateway 只许白名单 @ai-gateway 包）。
6. 迁移：DDL 写进 `packages/db/migrations/NNNN_xxx.sql`（幂等、`--> statement-breakpoint` 分隔、
   内联约束）+ `_journal.json` 追加条目 + `pnpm --filter @ai-gateway/db db:migrate` 应用。
   schema 与迁移同步改（单一真源在 db 包）。
7. **共享 dev 库竞态**：开发库可能有活 worker（1s 一轮）合法抢领——断言容忍合法终态
   （别人结算不是回归点，误释放 released/dead 才是），默认门禁不得假设独占共享库。

## 6. 资金域专项规则（违反 = 资损）

- **幂等三段式**：快速路径查既有 → 唯一冲突兜底重放 → 同键异命令 409（`commandFingerprint`
  canonical JSON + SHA-256）；重放不该被守卫误伤；SUM 口径查询须排除自身请求（`excludeRequestId`）。
- **并发**：同 user authorize 走 advisory xact lock；额度/预算守卫内联 WHERE；状态迁移全 CAS
  （五元组 fencing）；批量认领 SKIP LOCKED。
- **8 态状态机**：authorized→in_flight→settlement_pending→processing→settled/released/dead/retry_wait，
  终态不可回流；dead 只走人工复核出口。
- **资金来源瀑布**（funding/）：probe（≥0，结构性非法抛错）→ planFunding（probe 循环，不动账）
  → INSERT（投影三列从 plan 算出）→ commitFunding（逐源 reserve + billing_reservations 明细）。
  零金额空计划。开关式排他：`api_keys.allow_payg_fallback` 默认 false（OFF=额度不足整单拒绝=存量行为；
  ON=订阅出余量 PAYG 补差）。普通 Key 永不消耗订阅额度。
- **结算分配**（domain `allocateSettlement`）：优先级序消耗（订阅先）；超额 PAYG 走 §4 补充授权
  （`#over` 两笔）；**纯订阅链超额由额度池降级核销吸收**（`settleQuotaBounded` 钳到池容量、
  差额记损——不得红砬死信冻结预占）；**consume=0 的 PAYG 结算走全额 release**
  （settle 动词拒绝零额）；明细 id 序 = 消费优先级序。
- **终态落账纪律**：signal(request.succeeded) 失败必须退避重试（`signalSucceededWithRetry`——
  流式重试期间续租不停，防 recover 误释放已交付请求）；非流式重试耗尽 503 不交付。
- **限流并罚**：准入 = 凭证维（`key:`/`app:`/`pg:`）+ 用户维**无条件**并罚 + global 维 +
  模型 TPM/渠道维——任何凭证形态（含 App-JWT 自建 scope）不得绕过管理端用户帽；
  鉴权爆破锁对静态 Key 与 JWT 两分支同口径 fail-closed。
- **释放**：signal(failed) 与 recover 走同一 `releaseAllReservations`（明细逐笔 → markReleased）；
  释放前 CAS 状态，findActive 白名单须含本事务刚转入的 released。
- **usage_logs 是限额口径**：结算必须落投影（否则日限静默失效）；billedBy 随 planAmount
  （订阅实际吸收额）判 plan/payg。
- **回收三路径**：授权过期未发上游 / in_flight 租约过期（崩溃）/ processing 认领过期→retry_wait。
- **新表规则**（billing_reservations 范式）：CHECK 约束全给（正数/状态机/时间戳一致）、
  partial 唯一防重放、全量索引供对账、FK 要求父行先插。

## 7. 工作流规则

1. **读懂再写**：改资金逻辑前先读 `docs/billing-flow-deep-dive.md` 与
   `docs/funding-package-plan.md` 对应节 + 现有实现（wallet 动词、settlement 编排）。
2. **不理解就停下来问**，不要猜业务语义。
3. **死代码即删**：被新路径取代的旧实现在新路径全绿后由代理清掉（lint 也会强制）；
   兼容老代码的逻辑一律不做（见铁律 8）。大体量删除（整包/整应用）列清单等用户拍板。
4. 包骨架照抄现有模式：`exports` 带 `"development": "./src/index.ts"` 条件、四件 script、
   tsconfig 继承 base、turbo 按任务名自动接线。
5. 提交信息：中文 conventional（`feat(wallet): …` / `feat(wallet)!: …`），破坏性变更加 `!`。
6. 改 repository/domain 的公共类型后先 `pnpm --filter 对应包 build`（下游 typecheck 走 dist）。

## 8. 当前基线快照（2026-08-20）

- **门禁**：`pnpm regress` = typecheck/lint/test 全部共享包 + 四应用（31 任务）。
- **覆盖率**（v8 实测）：wallet 91%/83%（money.ts 100%）、domain 94%/89%、service 86%/74%、
  admin-api 带阈值门禁 90/85/90/90（唯一带门禁的包）；无被禁用测试（skip 仅为无 Redis/无真实
  上游凭证的环境守卫）。
- **E2E 独立通道**（依赖外网与 dev 库，不进默认门禁）：gateway `test:e2e` 32 例 7 文件 /
  client-api 22 例 4 文件 / admin-api 23 例 5 文件。
- **已知未修**（按优先级，上线后第一迭代）：无 CI 流水线（体系级最重）；资金包无覆盖率门禁；
  worker reconcile 哨兵零测试；admin 无 RBAC；兑换码券存本地磁盘（多副本前迁共享存储）；
  /v1/pricing 无缓存。
- **部署运维要点**：支付回调必须指向 `/v1/payments/notify/:provider`（EPAY 后台 + Stripe
  webhook——旧路径已 404，漏配=充值不入账）；生产 `SECURE_COOKIE=true` + `NODE_ENV=production`；
  `docker compose up` 加 `--remove-orphans` 清 v1 时代旧容器。
- **dev 注意**：共享 dev 库活 worker 竞态见 §5.7；Next dev 需 `allowedDevOrigins`
  （已写入两 next.config.mjs）；浏览器级 UI 测试建议跑生产构建（next start）。
