# AGENT.md —— 工程规范（人类贡献者与 AI 协作共用）

> 本文档是本仓库的**代码规范**：架构分层、各层写法、资金域专项纪律与质量门禁。
> 与代码冲突时：先查本文规则是否被违反，是则修代码；规则过时则先改本文再动代码。
> 全程中文注释；提交信息用英文 Conventional Commits（见 §7）。
> **代码是业务逻辑的唯一标准**——docs/ 下的文档仅作导读，可能与实现不同步，与代码冲突时一律以代码为准。

---

## 0. 铁律（每条都是硬约束，违反 = 返工）

1. **单向分层**：最终结构为 `routes → application → domain`，存在真实边界时使用
   `application → ports ← adapters → db`；
   未迁移能力暂用 `routes → service → domain`、`service → repository → db`。两种形态都必须无环且不得在同一能力中混用。
2. **职责位置唯一**：业务规则只住 domain（纯函数），事务只住 application（迁移前为 service），
   SQL 只住 `adapters/postgres`（迁移前为 repository），表定义只住 `db`。
3. **零写死**：一切可变值（币种、refType、失败策略参数、开关、阈值）必须装配注入且**必填**，
   不藏全局默认；同一真相只定义一次（常量单一来源，放最底层被依赖的包）。
4. **未实现 = bug**：不许「接口先行 / TODO 将来实现 / 占位」。写了接口必须有实现与调用方；
   推迟实现的功能在文档里显式挂「待办」并说明后果。
5. **一动词一文件**：一个用例/动词/规则一个文件；文件超 ~150 行先问自己是不是装了两件事。
   禁止 class 做依赖捕获（用 `createXxx(env)` 工厂闭包——Postgres repository adapter 除外，见 §4）。
6. **改资金逻辑先读懂再动手**：先读 `packages/wallet`、`packages/service` 的现有实现
   （代码是行为语义的唯一标准），基于语义重写而不是复制粘贴。发现现有逻辑错误要修并在 PR 里说明。
7. **行为等价验证**：重构类改动必须有测试兜底且全绿才算完成（见 §5 四门）。
8. **单一形态，不留兼容层**：仓库只保留一套实现；不写兼容旧代码的逻辑——
   旧路径别名、双轨字段、参数双收一律不做，发现即删。
   大体量删除（整包 / 整应用）先开 issue 列清单等维护者确认。
9. **配置不是包，发布不等于 workspace**：TypeScript / Vitest / Oxlint / Oxfmt / Turbo 配置放根目录，
   不建 `tooling` workspace 包；所有 workspace 默认私有，只有经过明确批准且发布闭包完整的包才能独立发布。
10. **目标态按业务能力聚合**：最终采用 `domain ← application`，按真实边界增加 `ports ← adapters`；
    迁移前代码继续遵守现有 `service/domain/repository` 纪律。一个能力必须原子切换并删除旧位置，禁止长期双轨。
11. **边界必须可执行**：package、协议和未来插件边界不能只靠目录命名；显式 `exports`、依赖白名单、
    无环检查、架构测试和发布闭包检查必须在 CI 中执行。没有真实边界的浅包必须合并，不保留永久编制。
12. **数据面与观察面分离**（`ai` 硬约束）：上游响应逐块透传 C 端，不缓冲、不改写、不收完再转发；
    触碰「不改写」的仅有透传例外清单三种情形（重构文档 §3.6）：跨协议最小必要转换（含错误体）、
    响应侧 model 字段替换（可配置开关）、错误出站三层（结构翻译成 OpenAI 信封、内容脱敏后保留
    原文、细节只进日志关联 requestId）。计费取证、审计、trace、渠道健康（熔断/死凭据）一律经
    `onEvent` 监听面旁路消费，不进热路径。`ai` 不持有跨请求运维状态；
    观察 tap 丢失不得造成资损——兜底在 billing 状态机与对账（§6），禁止在热路径同步结算换确定性。

---

## 1. 仓库地图

### 1.1 当前实现（迁移期间有效）

```
packages/
  db/            表定义（schema/）+ 迁移（migrations/，幂等 SQL + drizzle journal）
  repository/    全部 SQL（唯一允许 SQL 的包）；只依赖 db + drizzle
  domain/        全部业务规则（纯函数）；只依赖 decimal.js + node: 内建
  service/       全部用例（事务编排）；只依赖 domain + repository
  wallet/        双分录账本内核（库形态；service/src/wallet 是生产装配层）
  ai/            上游协议库（透传中继 / 多协议 / 多模态适配 / 渠道内重试 / onEvent 观察面 / SSRF 硬门；
                 零 workspace 依赖，最终保留为独立库包，inference 依赖它，见 §1.2 与铁律 12）
  core/          Redis 基建（滑动窗口限流 / 爆破锁 / 加密 / Lua 脚本运行器）
  identity(-core)/ 会话 JWT + 挑战表；http / tracing / api-client / ui / money
  ledger-core/   通用幂等资金操作内核（db→ledger-core 存量反向依赖，P3 清除，见 §1.4）
apps/
  gateway/       网关：路由 / 推理管线 / 装配根（业务全部来自 service）
  worker/        后台循环：结算 / 回收 / 生成轮询 / 对账哨兵 / 告警投递 / 分区维护
  client-api/    用户面后端；admin-api/ 管理面后端（app 内同样四层）
  admin/ client/ Next.js 前端（BFF 持 Bearer，api-client 调用封装）
  trace-receiver/ OTLP 接收端（PG 存储，管理台链路追踪页）
```

- 域目录：`domain/{shared,wallet,rating,billing,channel-budget,subscription,generation}`、
  `service/{wallet,billing,funding,channel-budget,settlement,subscription,generation,shared}`。
- **迁移链现状（四条并存，P3 收口）**：`db`（drizzle-kit + `migrations/`，权威链）、`wallet`（migrate-cli）、
  `identity-core`（provision）、`ledger-core`（provision）各有独立建表链。**迁移期新 DDL 只进 `db` 链**（写法见 §5.6），
  其余三条链冻结新增；生产库链状态审计是重构文档 P0 交付物。
- **域归属判定**（什么进共享包、什么留 app）：
  - `db` / `repository`：**全仓集中**——所有表进 db、所有 SQL 进 repository（哪怕单 app 消费），
    守卫与事务口径必须同源。
  - `domain` / `service`：**只有 ≥2 个 app 需要的业务规则/用例进包**（资金域全部在包；
    订阅生命周期、渠道充值调账同例）。
  - 单 app 域**不进共享包**：用户管理、API Key 管理、支付、促销 → `client-api/src/services/`；
    模型目录/费率卡/渠道 CRUD、管理端复核 → `admin-api/src/services/`。app 内同样四层：
    routes → app services →（需要时 app domain）→ packages/repository。

### 1.2 最终目标（新结构决策）

完整目录、包内结构和阶段计划见 `docs/project-structure-refactoring.md`。目标 package 集合为：

```
packages/
  errors/            零依赖错误根契约
  runtime/           config/logging/crypto/redis/lifecycle
  db/                DB client/transaction/schema/migrations
  http/              纯 HTTP/Hono 基础工具
  identity/          身份认证能力
  accounts/          用户/组织/API Key/Application
  billing/           money/wallet/ledger/rating/subscription/settlement
  ai/                上游协议库：透传中继/协议适配/onEvent 观察面（第三发布候选，零内部依赖）
  inference/         推理用例/路由候选循环/quote/故障转移（单向依赖 ai）
  control-plane/     provider/channel/model/rate-card 管理
  notifications/     notification/outbox/template/dispatch
  observability/     OTel/trace/audit/request-log
  api-client/        框架无关客户端 + 可选 ./next 入口（公开候选）
  ui/                纯 React 设计系统（第二公开候选）
```

最终每个业务能力包内部统一为：

```text
src/
  domain/            纯规则与值对象
  application/       用例与事务编排
  ports/             可选：真实 I/O/外部服务/依赖倒置接口
  adapters/          可选：postgres/redis/http/供应商实现
  <capability>.ts    小而稳定的 createXxx facade
  index.ts           唯一公开出口
```

Wire contract 不建集中式 package：由 `apps/*-api/src/http/contracts` 与 `apps/gateway/src/http/contracts`
分别拥有，生成 OpenAPI 后再生成 `api-client`。

只有单一协议已存在多个跨部署/跨仓库消费者，需要运行时校验、独立版本和兼容承诺时，才允许经 ADR
建立单一用途的 `*-protocol`；它不得聚合多个业务域 DTO。当前三个 HTTP API 继续使用 app-owned contract，
不能因为已有 schema 就自动升格为 package。

当前 → 目标：`core → runtime/observability`、`db → 保留名称并收窄职责`、
`domain/service/repository → 按业务迁入各能力包`、`wallet/ledger-core → billing`、
空 `money → 删除`、`ai → 保留为独立库并收窄（路由/计费语义移入 inference，库本体按铁律 12 契约保留）`、`identity-core/identity → identity`、`tracing → observability`。

### 1.3 迁移纪律

1. 不预建空目标包；只有能力接口、实现、测试和调用方可在同一阶段迁移时才创建。
2. 未迁移能力严格遵守本文 §2–§4 的现有横向分层规则。
3. 已迁移能力严格遵守 `domain/application` 与按需 `ports/adapters`，不得再向旧 `service/domain/repository` 添加同类代码。
4. 每个能力切换后立即删除旧实现、旧 exports 和旧依赖，不保留兼容转发层。
5. 迁移提交必须证明对外协议与资金语义不变，并通过架构边界测试和四门质量检查。
6. 迁移 PR 逐用例灰度合入，禁止长寿命 refactor 分支；业务 PR 不得顺手搬迁，迁移 PR rebase 业务 PR。
   完整并行规约见重构文档 §9.1。

### 1.4 存量违规清单（已知越界，按阶段清除）

以下违规是结构审计确认的存量事实，**不是可模仿的模式**；清除前维持现状、不得加深：

| 存量违规 | 清除阶段 |
|---|---|
| `db` → `ledger-core`（基础设施反向依赖业务包） | P3 |
| `http` → `db`（目标要求 `http` 零 db 依赖） | P3 |
| wallet / identity-core / ledger-core 三条 provision 链与 db 主链并存 | P3 |
| 两个 Next app 的 tsconfig `paths` 直映射 `packages/ui/src`、`packages/api-client/src` 绕过 `exports` | P2 |
| `apps/worker` 直依赖 `@tokenlens/wallet`（对账任务） | P4 |
| `apps/admin` 直依赖 `@tokenlens/ai`、`@tokenlens/tracing`（前端吃后端包） | P5 |

与 §0 铁律、§8 规则冲突时：表中条目是唯一豁免，表外违规一律修代码。
清除完成的条目随对应阶段合入时同步删行；清单为空即结构达标。

---

## 2. Domain 层规则（新旧结构共同适用）

1. **纯函数 + 值对象**：domain 是函数式（快照类型 + 自由函数），不是实体方法——
   这是对经典充血模型的**有意偏离**（防的是「逻辑散落 Service」，本仓规则全在 domain 层，形态为函数）。
2. 零基础设施：不 import drizzle / pg / HTTP / Redis / 任何 app；只允许标准库、纯计算依赖与
   零基础设施根契约——`@tokenlens/errors` 于 P3 落地，落地前沿用现有错误基座，不得提前 import。
   `architecture.test.ts` 机器强制。
3. 现有 `packages/domain` 域内方向（迁入能力包前由测试强制）：
   - `shared`、`wallet`、`rating` 是核下层（被引用，不引用其他域；wallet 的 money 是全系统金额唯一构造器）；
   - `billing` 是编排域，可下行引用 `channel-budget` 错误家谱；`channel-budget` 不得反向引用 billing。
4. 错误全类型化分家谱（输入/拒绝/幂等冲突/不变量），消费方 `instanceof` 判定，不靠 message。
5. 金额：一律 string 落库、`Decimal`（domain/wallet/money 的克隆实例）运算、**账本永不 round**；
   出口统一 `normalizeAmount`（PG numeric 尾零不外泄）。金额解析必须走 `parsePositiveAmount /
   parseNonNegativeAmount`（负数/NaN/科学计数法/超尺度结构性拒绝）。
6. 领域词汇（科目码 `OUTSIDE_ACCOUNT/REVENUE_ACCOUNT`、`BILLING_REF_TYPE`、`DEFAULT_CURRENCY` 类常量）
   定义在 domain 最被依赖的位置，上层只引用不重复定义。

## 3. Application / 现有 Service 层规则

1. **一用例一文件一工厂**：`createAuthorizeUseCase(env): (ctx, input) => Result` 形态；
   `env` 是进程级依赖（db/registry/repos/clock/policy），工厂闭包捕获，不出现在调用链。
2. **只编排**：查数据 → 调 domain 规则 → 落 repo。任何比较数学/判定分支下沉 domain
   （闸门、限额、分配、失败策略全已下沉，新规则照做）。
3. **事务边界在这里**：`db.transaction(tx => ... inTx(ctx, tx) ...)`；跨用例共享事务经
   `input.tx` 注入。**三生命周期**：进程级 env → 请求级 `RunContext`（requestId/actor/traceParent）
   → 事务级 `RepoContext = inTx(ctx, tx)`。ctx 只放「谁、哪条链路」，业务参数是 command。
4. **入参/返回全 DTO**（Input/Result 接口）；服务无状态。
5. wallet 动词保持 `(ctx, input & {tx?})` 双轨（自开/加入事务）——幂等冲突兜底重放
   需要在池连接重读，不要改成单参 RepoContext。
6. 包内方向（测试强制）：billing→funding→wallet/channel-budget 单向；
   wallet/channel-budget/shared/funding 不得上行引用；settlement 在最上层可引全部。

## 4. Postgres Adapter / 现有 Repository 层规则

1. **一表/一聚合一个 Repository 类**（允许 class 的持久化 adapter），迁移前由 `createRepositories()` 组合；
   迁移后仅在存在替换/倒置需求时实现本能力 port，否则作为 application 的内部 adapter。
   方法接收显式事务/请求上下文，禁止另建全仓接口包。
2. **意图化原子方法，禁止 CRUD 化**：守卫 UPDATE / CAS / SKIP LOCKED 的原子性是方法边界
   （`tryReserveQuota`、`casFinalizeSettled`、`claimPending`…）。资金不变量必须留在单语句原子边界内，
   不做 find+save 两步（会开竞态窗口）。**numeric 列经 drizzle returning 是 string——JS 侧
   比较是字典序，数值判定必须放 SQL 侧或 Decimal**。
3. 返回 port 定义的中性形状（string 金额）；不得包含业务判定。迁移前 repository 不 import domain，
   迁移后的 adapter 只实现本能力 port，不得穿透其他能力内部类型。
4. 事务归 application/service：adapter/repo 永不擅自开启业务事务（事务句柄由上层注入）。
5. 写路径 `c.db` 必须是事务句柄；只读路径可传连接池。
6. Db/DbTx 类型不得泄漏到 facade、domain 或 wire 契约；迁移前经 repository 收口，迁移后封装在 adapter/port 边界。

## 5. 测试与质量门

1. **四门全过才算完成**：typecheck / lint(oxlint) / test / build。
   快捷：`bunx turbo run typecheck lint build test --filter=@tokenlens/domain --filter=@tokenlens/repository --filter=@tokenlens/service --filter=@tokenlens/gateway`
2. 测试归属：domain 规则单测（零 DB，毫秒级）→ 对应能力包；
   application 用例与 adapter 集成测试（真实 PG，`DATABASE_URL` 缺省
   `postgres://postgres:postgres@localhost:5432/ai_gateway`）→ 对应能力包；
   未迁移代码暂留 domain/service 测试；跨进程端到端 → 根 `e2e/` 独立通道。
3. 数据纪律：每套件独立测试前缀 + 独立用户；wallet 腿/交易 append-only 留档
   （DB 触发器禁删），业务行按 FK 逆序清理（先 billing_reservations 再 billing_requests…）。
4. 金额断言用 `new Decimal(x).eq('0.6')` / `normalizeAmount`（PG 尾零）。
5. 架构边界测试必须跟随结构演进：domain 禁基础设施，application 禁 drizzle/pg/框架，
   adapters 不得泄漏到公共 facade，packages 禁引 apps，跨包禁引 `src/*`，app 只能依赖白名单 facade/基础包。
6. 迁移：DDL 写进 `packages/db/migrations/NNNN_xxx.sql`（幂等、`--> statement-breakpoint` 分隔、
   内联约束）+ `_journal.json` 追加条目（`when` 必须大于上一条，否则 drizzle 静默跳过）+
   `bun run --filter @tokenlens/db db:migrate` 应用。schema 与迁移同步改（单一真源在 db 包）。
   新 DDL 只进 db 链；禁止向 wallet/identity-core/ledger-core 的 provision 链新增建表（见 §1.4）。
7. 断言容忍合法终态：并发环境里他人合法完成的结算不是回归点，误释放（released/dead）才是；
   默认门禁不得假设独占数据库。

## 6. 资金域专项规则（违反 = 资损）

- **幂等三段式**：快速路径查既有 → 唯一冲突兜底重放 → 同键异命令 409（`commandFingerprint`
  canonical JSON + SHA-256）；重放不该被守卫误伤；SUM 口径查询须排除自身请求（`excludeRequestId`）。
- **并发**：同 user authorize 走 advisory xact lock；额度/预算守卫内联 WHERE；状态迁移全 CAS
  （五元组 fencing）；批量认领 SKIP LOCKED。
- **8 态状态机**：authorized→in_flight→settlement_pending→processing→settled/released/dead/retry_wait，
  终态不可回流；dead 只走人工复核出口。
- **资金来源瀑布**（funding/）：probe（≥0，结构性非法抛错）→ planFunding（probe 循环，不动账）
  → INSERT（投影三列从 plan 算出）→ commitFunding（逐源 reserve + billing_reservations 明细）。
  零金额空计划。开关式排他：`api_keys.allow_payg_fallback` 默认 false（OFF=额度不足整单拒绝；
  ON=订阅出余量 PAYG 补差）。普通 Key 永不消耗订阅额度。
- **结算分配**（domain `allocateSettlement`）：优先级序消耗（订阅先）；超额 PAYG 走补充授权
  （`#over` 两笔）；**纯订阅链超额由额度池降级核销吸收**（`settleQuotaBounded` 钳到池容量、
  差额记损——不得红字死信冻结预占）；**consume=0 的 PAYG 结算走全额 release**
  （settle 动词拒绝零额）；明细 id 序 = 消费优先级序。
- **终态落账纪律**：signal(request.succeeded) 失败必须退避重试（`signalSucceededWithRetry`——
  流式重试期间续租不停，防 recover 误释放已交付请求）；非流式重试耗尽 503 不交付。
- **限流并罚**：准入 = 凭证维（`key:`/`app:`/`pg:`）+ 用户维**无条件**并罚 + global 维 +
  模型 TPM/渠道维——任何凭证形态（含 App-JWT 自建 scope）不得绕过管理端用户帽；
  鉴权爆破锁对静态 Key 与 JWT 两分支同口径，Redis 故障 degraded（本地内存粗限：登录可用、达阈值仍锁——降质换可用）。
- **释放**：signal(failed) 与 recover 走同一 `releaseAllReservations`（明细逐笔 → markReleased）；
  释放前 CAS 状态，findActive 白名单须含本事务刚转入的 released。
- **usage_logs 是限额口径**：结算必须落投影（否则日限静默失效）；billedBy 随 planAmount
  （订阅实际吸收额）判 plan/payg。
- **回收三路径**：授权过期未发上游 / in_flight 租约过期（崩溃）/ processing 认领过期→retry_wait。
- **新表规则**（billing_reservations 范式）：CHECK 约束全给（正数/状态机/时间戳一致）、
  partial 唯一防重放、全量索引供对账、FK 要求父行先插。

## 7. 工作流规则

1. **读懂再写**：改资金逻辑前先读现有实现（wallet 动词、settlement 编排）——代码是唯一标准；
   docs/ 下的文档（如 billing-flow-deep-dive.md）只作快速导览，不是权威依据。
2. **不理解就停下来问**，不要猜业务语义。
3. **死代码即删**：被新路径取代的旧实现在新路径全绿后清掉（lint 也会强制）；
   兼容旧代码的逻辑一律不做（见铁律 8）。大体量删除（整包/整应用）开 issue 列清单等维护者确认。
4. 内部包骨架照抄现有模式：`exports` 可带 `"development": "./src/index.ts"` 条件、四件 script、
   tsconfig 继承 base、turbo 按任务名自动接线；可发布包必须遵守 §8，只对外暴露构建产物。
5. 提交信息：英文 Conventional Commits（`feat(wallet): …` / `feat(wallet)!: …`），
   破坏性变更加 `!`；错误码与 API 返回 message 一律英文。
6. 改 repository/domain 的公共类型后先 `bun run --filter 对应包 build`（下游 typecheck 走 dist）。

## 8. 仓库结构、配置与发布规范

详细设计与迁移顺序见 `docs/project-structure-refactoring.md`；以下是必须执行的硬约束。

### 8.1 目录职责

1. `apps/*` 是可部署应用和装配根，必须 `private: true`；应用可依赖 packages，packages 禁止依赖 apps。
2. `packages/*` 只放具有真实代码边界的模块：必须有稳定公共接口、隐藏实现复杂度、明确消费者，
   并能独立 typecheck / lint / test（有运行产物时还必须 build）。
3. `scripts/` 是仓库自动化，`docs/` 是设计与运维文档，`docker/` 是部署基础设施；三者都不是 workspace 包。
   `generated/` 只放 OpenAPI/API Client 等机器产物，禁止手改，也不是业务事实源。
4. 不因“以后可能复用”、共享几个类型/常量、缩短相对路径或视觉分类而建包。
5. 包间禁止循环依赖和 `@tokenlens/x/src/*` 深层导入；跨包只能走目标包 `exports`。
6. 两个包若总是一起修改、接口几乎等于实现、测试无法独立，应先评估合并成更深模块。
7. API wire schema 放在提供接口的 app `src/http/contracts/`；包内测试只覆盖单元/契约/集成，
   跨进程系统测试统一放根 `e2e/`，禁止两处维护同一 E2E。
8. 当前 Provider 只放 `inference/adapters/providers/*`；供应商 SDK 不得进入 domain/application，
   可选重型 SDK 必须经窄入口延迟加载。没有外部独立安装、版本兼容和至少两个真实插件实现时，
   禁止创建 `plugin-sdk`、`extensions/*` 或按供应商拆分 workspace package。
9. package 失去真实边界时必须退出：单一消费者且无切环/发布责任、只做转发、接口约等于实现，
   或长期与另一包成对修改/测试，均应合并回所属能力并删除旧 exports。

### 8.2 根配置

1. 仓库级配置固定放根目录：`tsconfig.base.json`、`tsconfig.next.json`、`turbo.json`、
   `.oxlintrc.json`、`.oxfmtrc.json`，以及确有需要时的 `vitest.shared.ts`。统一测试入口只用根
   `vitest.config.ts` 的 `test.projects`；禁止 `vitest.workspace.ts`（已被当前 Vitest 版本替代）。
2. 禁止创建 `tooling/package.json`，禁止把静态配置纳入 `apps/*` 或 `packages/*`。
3. `tsconfig.base.json` 只放全仓共同严格规则；框架差异放命名明确的根配置；子项目配置只保留本项目差异。
4. Vitest 配置默认属于各项目；只有至少两个消费者语义完全一致的逻辑才能提取到根共享文件。
   覆盖率阈值、串行策略与 E2E 排除规则有差异时不得强行统一。
5. 只有配置需要跨多个仓库复用、独立版本化和发布时，才允许另立配置仓库或配置包；本仓内复用不满足条件。

### 8.3 包准入与依赖

新建 package 前必须能回答：

- 它隐藏了什么复杂度？
- 当前有哪些真实消费者？
- 它的公共接口是什么，为什么比实现更小且更稳定？
- 它依赖谁、谁可以依赖它，如何保证无环？
- 它由哪些边界测试保护？

回答时按以下依据排序：独立安装/版本/发布生命周期 → 运行时与依赖所有权 → 多消费者公共兼容契约 →
跨应用共享的深能力 → 切断真实依赖环。代码量、目录数量和“未来可能复用”不属于独立依据。

答不完整则代码留在最接近的现有 app/package，不创建空壳包、桥接包或纯转发包。

最终依赖固定为：`apps/assembly → capability facade`，能力包内部 `domain ← application`；
只有真实 I/O、第三方、可替换实现或依赖倒置时才使用 `ports ← adapters`，禁止一类一接口的模板化拆分。
`errors` 零内部依赖，`db` 不依赖业务包，`http` 不依赖 db/业务包；domain 不依赖 DB/HTTP/缓存/app。
跨能力默认依赖窄 facade；出现循环、远程边界或替换需求时才由消费方定义 port、在 app 装配注入。
Wire contract 由提供 API 的 app 所有，禁止建立集中式 DTO/type 仓库；OpenAPI 是跨进程契约产物。
独立 `*-protocol` 只允许描述一个协议，并且必须同时具备多个真实跨边界消费者、运行时 schema/版本需求、
独立发布与兼容责任；协议与客户端分包，固定为 `client → protocol`，例外必须先写 ADR 和架构测试。
Hono route/middleware 属于 app 入站适配，不进入 identity/billing 等能力包。
目标 `ui` 禁止依赖 `api-client` 和 Next 专有 API；数据通过 props/callback 注入。
目标 `api-client` 禁止依赖任何私有 `@tokenlens/*` 运行时包，所需 wire 类型由 OpenAPI 生成并随产物发布。
业务方向固定为 `accounts → identity/billing`、`inference → control-plane/billing`、
`accounts|billing|control-plane → notifications`；`inference` 另单向依赖零内部依赖的上游协议库 `ai`
（铁律 12 的数据面/观察面契约），`apps` 运行时代码不直接 import `ai`。
反向需求一律通过调用方提供的标识、事件 payload 或消费方 port 解耦。

能力包确需 app 装配的跨能力 bridge 与外部 adapter 只能从显式 `./composition` 子入口导出；
该子入口仅 `apps/*/src/assembly.ts`、迁移脚本和 adapter 集成测试可引用，app 路由/任务代码与
业务调用方一律禁止，由架构测试强制白名单。
迁移期间，未迁移代码仍允许 `apps → service → domain`、`apps → service → repository → db`；
同一业务能力不得同时采用新旧两套依赖链。任何公共 API 都不得泄漏其他私有包的类型。

### 8.4 私有与公开包

1. 根 `package.json` 永远保持 `private: true`。
2. `apps/*` 与所有内部 `packages/*` 默认并持续保持 `private: true`。
3. 加入 workspace、参与 Turbo 构建和发布 npm 是三个独立决策；禁止因为包位于 `packages/` 就发布。
4. 公开包采用显式发布白名单和独立版本；允许发布零至三个包（候选：`api-client`、`ui`、`ai`），禁止遍历 `packages/*` 全量发布。
5. 只有存在真实外部消费者、公共 API 已冻结、发布产物和依赖闭包已验证后，才能删除目标包的 `private: true`。
6. 当前 `api-client`、`ui`、`ai` 仅是未来公开候选，在完成发布准备前仍为私有包。

### 8.5 公开包门禁

公开包必须同时满足：

1. `main`、`types` 和 `exports` 只指向 `dist`，不得向 registry 用户暴露 `src/*.ts`。
2. `files` 只包含运行产物、声明文件、README、LICENSE 等必要文件。
3. 具备独立 `build`、`typecheck`、`lint`、`test`，并对实际打包产物执行安装冒烟测试。
4. 所有运行时依赖均已发布、被安全打包或被正确声明为 peer dependency；禁止保留无法从 registry 解析的 `workspace:*` 私有依赖。
5. 遵守 SemVer；公共 API 破坏性变更只能提升 major，且必须记录 changelog/changeset。
6. 发布前检查 tarball，不得包含 `.env`、密钥、测试数据、内部文档和无关源码。
7. CI 只发布白名单中发生版本变化且 typecheck / lint / test / build 全绿的目标包。

### 8.6 自动化边界门禁

1. CI 必须检查 package graph 无循环、`packages/*` 不依赖 `apps/*`、跨包引用只命中显式 `exports`。
2. 架构测试必须阻止深导入、相对路径越界、domain/application 引入基础设施，以及公共 API 泄漏 adapter、
   供应商类型或其他私有 package 类型。
3. 公开候选必须执行 API/export diff、依赖闭包、`npm pack` 内容检查和 registry 环境安装冒烟。
4. 新增边界例外必须同时提交 ADR、架构测试和最小允许清单；禁止只修改 lint ignore 或口头约定。
5. Provider 延迟加载必须有测试证明：未启用该 Provider 时，启动热路径不会加载其重型 SDK。
