# @tillgate/runtime 迁移实现文档

> 状态：R1–R3 实施完成，四门全绿，行为对照核销完毕（含 enc:v1 跨仓互解硬验证）
> 基线：旧仓 `ai-getway/packages/core`（12 源文件 ~1375 行 + 5 测试 ~290 行）+ 三个 app 的 `shutdown.ts`（43 行 × 3）
> 目标：`core → runtime + observability` 拆分的 runtime 半边（重构方案 §3.2 / §9 P3）；**只收纯服务端运行时基础设施**，业务/观测语义全部拒之门外
> 依据：`docs/project-structure-refactoring.md` §3.1（runtime 禁止进入：业务规则、业务 SQL、HTTP route）、§5.1（runtime 只可依赖 `errors`）

---

## 0. 原则

1. **范围收窄是本迁移的主要工作**：`core` 是个混合包——纯基建（logger/crypto/redis-client）、观测（otel）、PG 分类（pg）、
   带计费语义的限流（rate-limiter TPM 预占/结算回填）、安全策略（auth-guards）、`ai` 跨请求健康状态存储（ai-storages）混在一起。
   runtime 只收第一类；其余各自归位（§2.4），一个都不带走。
2. **不是复制，是重构**：三份漂移中的 `shutdown.ts` 合一（D1）；测试样板提取为 testing 子入口（D2）；每个模块逐一裁决。
3. **行为等价**：迁移模块的旧测试是行为规格；微修处逐条列出并给理由。
4. **已接入 `errors` 根契约**（AGENT.md §11）：起步时 errors 包未建，曾零内部依赖；errors 落地（ADR-0001）后按 §11 接入——
   `assertRedisReachable` 抛 `InfrastructureError`（`runtime.redis.unreachable`，context 只进脱敏后 URL）；
   `parseSentinels` 配置缺陷与 `cipher` 解密失败（格式/认证）抛 `DefectError`（`runtime.redis.sentinels_invalid` /
   `runtime.cipher.invalid_format` / `runtime.cipher.auth_failed`，GCM 原生失败保留在 cause 链）。
   `testing/` 子入口保持原生 Error（测试装置非 §11 运行时范畴）。

---

## 1. 外部契约（v2 API，已定稿）

```ts
// config/ —— 环境变量校验原语（zod）
strictBooleanSchema(defaultValue: boolean)          // 布尔只收 true/false（字符串精确匹配）
secretSchema(field: string, minLen: number)         // 密钥三道门：长度 ≥ minLen、非已知弱值、≥4 种不同字符

// logging/
createLogger({ level, serviceName?, pretty }): Logger    // level/pretty 必填注入（铁律 3 收口）；pino + redact 脱敏

// crypto/ —— 渠道上游 Key 落库加密（AES-256-GCM，enc:v1 格式与存量行兼容）
createCipher(encryptionKey: string): Cipher              // 工厂闭包：key 派生一次；encrypt/decrypt 纯方法
type Cipher = { encrypt(plaintext: string): string; decrypt(packed: string): string }

// redis/
createRedisClient(url, { serviceName, logThrottleMs, sentinels?, sentinelName?, sentinelPassword?, log? }): Redis
                                                      // logThrottleMs 必填；sentinel 形态 sentinelName 必填（判别联合）
parseSentinels(spec: string): { host: string; port: number }[]
assertRedisReachable(redis, serviceName, rawUrl, timeoutMs): Promise<void>    // timeoutMs 必填注入；启动期 fail-fast（冷连接重试直至截止）
createRedisScriptRunner(redis): RedisScriptRunner       // Lua evalsha + NOSCRIPT 自愈

// lifecycle/
createShutdown(deps: ShutdownDeps): (signal: string) => void   // 优雅停机编排（三 app 合一，serviceName 参数化）

// testing/ —— 子入口 @tillgate/runtime/testing（只许 *.test.ts 引用）
testRedisUrl(): string | undefined                      // REDIS_URL 非空才返回（skipIf 判据）
connectTestRedis(timeoutMs?): Promise<Redis | null>      // 连接并等就绪；无 URL 返回 null
disconnectTestRedis(redis): Promise<void>
waitForRedisReady(redis, timeoutMs?): Promise<boolean>   // 冷连接就绪等待（offline queue 已关）
```

- 双入口：根入口只出生产面；`./testing` 子入口只出测试装置（exports 分离，架构测试后续限定引用者）。
- 全部工厂闭包形态（铁律 5）；`createCipher` 取代 v1 双参纯函数——key 派生（SHA-256）每次调用重复计算是浪费，装配一次派生一次。
- `enc:v1` 密文格式**逐字节保持**（`enc:v1:<ivHex>:<tagHex>:<cipherHex>`）——存量落库行不受影响，v1 密钥直接可解。

---

## 2. 审计结论（12 源文件 + shutdown ×3 逐一过）

### 2.1 真 bug / 缺陷清单

| #   | 位置                                | 问题                                                                                                                                                                                                                                                  | 级别                                                   |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B1  | `apps/*/shutdown.ts`                | `now?: () => number` 注入参数**从未使用**（gateway 版声明、另两版没有）——死参数，随合一删除                                                                                                                                                           | 死代码                                                 |
| B2  | `redis-client.ts` createRedisClient | 降级日志硬编码 `console.error`——使用方无法统一日志面/注入测试 spy 只能劫持 console                                                                                                                                                                    | 可测性                                                 |
| B3  | `env.ts` KNOWN_WEAK_SECRETS         | 测试专用密钥值（'test-jwt-secret-min-16-chars' 等 3 个）编入生产黑名单——黑名单是脆弱兜底（改一字符即绕过），真实防线只有长度+多样性两道                                                                                                               | 记录不改（行为保持；强度门是主防线的结论写入代码注释） |
| B4  | `shutdown.ts`                       | `Math.max(1_000, graceMs)` 静默把 <1s 的宽限抬到 1s——无害防御，**保留**但注释声明（不 fail-fast 的理由：宽限下界是强退定时器正确性的前提）                                                                                                            | 记录                                                   |
| B5  | `logger.ts` redact                  | v1 六条 `*.field` 通配路径**对根级日志字段从未生效**——fast-redact 的 `*` 只匹配嵌套层，`logger.info({ apiKey })` 根级用法明文输出，与「敏感字段脱敏」意图不符（v2 行为等价测试暴露）。**修复**：敏感字段清单单一来源，派生根级显式 + 嵌套通配两级路径 | 安全，R1 已修                                          |

### 2.2 结构性发现

| #   | 发现                                                                                                                                                                                     | 处置                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| S1  | 三个 app 的 `shutdown.ts` 逐字重复且**已漂移**（gateway 版独有 closeables/now；注释分叉）——client-api/admin-api 的附加收口无法复用                                                       | D1 合一进 lifecycle，serviceName 参数化                                       |
| S2  | `waitForRedisReady`（100ms 轮询返 bool）与 `assertRedisReachable`（200ms 轮询超时抛错）90% 相似——**不是重复，是两个角色**：前者的 8 处消费者全是测试装置，后者是 4 个 app 的生产启动路径 | 按 consumer 归位：前者进 `testing/` 子入口，后者进 `redis/`；文档写明防再合并 |
| S3  | `redis.test.ts` 的「REDIS_URL 缺省整套跳过 + beforeAll 连接 + afterAll quit」样板在 core 与各 app 测试中重复 ×8+                                                                         | D2 提取为 `testing/` 装置                                                     |

### 2.3 逐文件裁决总表

| 文件                                                                                         | 裁决           | 去向 / 要点                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env.ts` strictBooleanSchema / secretSchema（~33 行）                                        | ✅ 复制        | `config/`                                                                                                                                        |
| `env.ts` loadTraceReceiverEnv / traceReceiverEnvSchema（~27 行）                             | 不迁移         | trace-receiver app 自有 config（app 建立时随 app 走）——app 配置不进 runtime                                                                      |
| `logger.ts`（41 行）                                                                         | 复制+微修      | `logging/`；修 B5（根级 redact）；redact 补 `token` / `secret` / `password` 三类字段；新增 `stream` 注入面（pino 直写 fd 1，劫持 stdout 不可靠） |
| `crypto.ts`（46 行）                                                                         | 复制+微修      | `crypto/`；工厂闭包化（key 派生一次），算法/格式/错误语义逐字节不变                                                                              |
| `otel.ts`（321 行）                                                                          | 不迁移         | `observability` 包（P3 后续迁移单元）——OTel SDK、内存环形缓冲、traceparent 都是观测语义                                                          |
| `pg.ts`（13 行）                                                                             | 不迁移         | `db` 包（pgSqlState 是 PG 基础分类，归 db 收窄职责）                                                                                             |
| `redis/redis-client.ts` createRedisClient / parseSentinels / assertRedisReachable（~120 行） | 复制+微修      | `redis/`；修 B2（`log?` 注入，缺省 console.error）                                                                                               |
| `redis/redis-client.ts` waitForRedisReady（~12 行）                                          | ✅ 复制        | `testing/`（S2：纯测试消费面）                                                                                                                   |
| `redis/script-runner.ts`（37 行）                                                            | ✅ 复制        | `redis/`（无瑕疵；NOSCRIPT 自愈语义官方规定）                                                                                                    |
| `redis/rate-limiter.ts`（280 行）                                                            | 不迁移         | gateway 鉴权/限流侧（`apps/gateway/http/middleware/rate-limit`）——TPM 预占/结算回填是计费衔接语义，违反「runtime 禁业务规则」                    |
| `redis/auth-guards.ts` + `auth-local-guard.ts`（296 行）                                     | 不迁移         | 安全策略（爆破锁定阈值/降级三档）随第一个消费者（gateway 鉴权中间件 / http security）迁移；`degraded()` 的 `dim` 死参数届时一并修                |
| `redis/ai-storages.ts`（79 行）                                                              | 不迁移         | `inference/health`（重构方案 §3.6 / P4.4 明确：熔断/死凭据跨请求状态是 inference 的 AiEvent 订阅者形态）                                         |
| `apps/{gateway,client-api,admin-api}/shutdown.ts`（43×3）                                    | **重构合一**   | `lifecycle/`（D1）；gateway 全集形态 + serviceName；删 B1 死参数                                                                                 |
| `apps/worker/health.ts`（59 行）                                                             | 不迁移         | worker app 自有（livez/readyz/deep 是进程部署语义）                                                                                              |
| `__tests__/` 5 文件                                                                          | 见 §5 迁移矩阵 | 随模块分流                                                                                                                                       |

### 2.4 消费者面（迁移后谁用 runtime）

- `config/` + `logging/` + `lifecycle/`：全部 apps 的 config.ts / 装配 / 停机（v2 apps 未建，本包先行——P3「基础设施按消费者切片」）。
- `crypto/`：control-plane（渠道上游 Key 落库）、accounts（充值码/App secret）——`enc:v1` 格式兼容是硬约束。
- `redis/`：全部 apps 装配；`createRedisScriptRunner` 另被 rate-limiter / ai-storages 的未来归宿复用。
- `testing/`：全仓需要真实 Redis 的测试装置（8+ 处样板的替代）。
- **注意**：本轮只建包不迁 app——v2 的 apps/* 尚不存在，无调用方切换；老仓不动（只读）。

---

## 3. 拆分决策（引用审计证据）

1. **目录即边界**（§3.1 目标树）：`config/ logging/ crypto/ redis/ lifecycle/ testing/` 六目录 + 双入口 `index.ts`。
   testing 不进根入口——vitest 语义不得混入生产 bundle（决策依据 S2/D2：它只被测试引用）。
2. **`createCipher` 工厂取代双参纯函数**（铁律 5）：`http/secrets.ts` 等消费方在装配期拿一次 cipher；
   SHA-256 派生从「每次调用」变「装配一次」。**单一形态**：不同时保留双参版本。
3. **shutdown 合一形态**：收口顺序保持 v1（otel → closeables → redis → db → exit 0）——行为等价优先于美学重排；
   二次信号行为保持 v1「忽略」不改「立即强退」（K8s SIGKILL 是强退兜底，改语义无证据支撑）；
   `graceMs` 的 `Math.max(1_000, ·)` 下界保留并注释（B4）。
4. **testing 子入口 exports 形态**：`"./testing"` 与 `"."` 平级（development 源码 / types / import dist 三条件，与 ai 包同款）；
   build 双入口产物。架构测试（scripts/check-package-boundaries.ts 建立 P0 门禁后）限定 `./testing` 只被测试文件引用。
5. **依赖**：`pino`、`pino-pretty`（pretty transport 动态加载，老仓放 dependencies 的先例保持）、`ioredis`、`zod`；
   内部依赖仅 `@tillgate/errors`（§0.4：ADR-0001 落地后接入根契约，起步时零内部依赖的陈述已过时）。
   5a. **redis 一动词一文件拆分**（铁律 5，2026-08-23 审计收口）：原 `redis-client.ts`（153 行三动词）拆为
   `parse-sentinels.ts` / `create-redis-client.ts` / `assert-redis-reachable.ts`，`sanitizeUrl`/`describeError`
   两纯函数提取为共享件 `redis-diagnostics.ts`（单一真相，两消费方共用）。同期收口：logThrottleMs/
   sentinelName（sentinel 形态）/assertRedisReachable timeoutMs/createLogger level+pretty 全部必填注入
   （铁律 3，函数内 `??` 默认值清除）；parseSentinels 端口改严格十进制 1-65535（拒 0x/1e/空白形态）、
   url db 段 NaN 守卫、createCipher 空密钥 fail-fast（P3 加固，英文 message）。
6. **不建 lifecycle 的信号注册器**：v1 的信号注册（`process.on('SIGTERM', shutdown)`）留在 app 的 index.ts——
   runtime 只提供可测编排件（createShutdown 返回函数），不接触全局进程状态（未实现 = bug 的反面：不预建没有消费者的设施）。

---

## 4. 测试计划

### 4.1 `__test__/`（平铺，铁律 14；无需任何外部服务）

- `config.test.ts`：secretSchema 三道门（弱值/短/低多样性拒，强值过）+ strictBooleanSchema（字符串 'false' 不得变 true；'yes' 拒）——移植 `env-secrets.test.ts` 前两个用例（loadTraceReceiverEnv 用例随模块不迁）
- `crypto.test.ts`：往返 / iv 随机 / 错误密钥认证失败 / 篡改认证失败 / 非法格式拒绝——移植 `crypto.test.ts` 5 用例（工厂形态改写）
- `logger.test.ts`（新写）：redact 命中（apiKey/token 被 `[REDACTED]`）+ level 生效 + serviceName 输出
- `shutdown.test.ts`：drain 顺序（close → otel → closeables → redis → db → exit 0）/ 宽限耗尽 exit(1) / 二次信号幂等——移植 gateway 版 3 用例 + **补 closeables 顺序用例**（v1 从未测过）
- `redis-client.test.ts`：错误监听已挂 + 30s 去重 / AggregateError 展开 / URL 脱敏——移植 3 用例（合成 emit，无真实连接）+ **补 `log` 注入用例**（B2 回归）
- `parse-sentinels.test.ts`（新写，v1 无）：合法多节点 / IPv6 `[::1]:26379` / 非法项抛错 / 空串抛错
- `script-runner.test.ts`（新写，mock redis）：首跑 LOAD→evalsha / NOSCRIPT 后重载自愈 / 非 NOSCRIPT 错误原样上抛 / sha 缓存命中不再 LOAD

### 4.2 `__test__/redis-integration.test.ts`（真实 Redis；REDIS_URL 未配置整套 skip——CI 必配；平铺无子目录）

- `redis.test.ts`：script-runner 真实自愈（SCRIPT FLUSH 后仍可跑）+ assertRedisReachable 对不可达端口超时抛错（信息含脱敏 URL）
- CAS/限流/爆破防护的真实 Redis 用例**不迁**（模块不在 runtime；随各自归宿的迁移单元走）

### 4.3 覆盖率

与 ai 包同门槛：lines/statements/functions 90、branches 85；`src/index.ts` 桶文件不计分母。

---

## 5. 实施顺序（每阶段独立提交 + 四门）

1. **R1 壳 + 纯原语**：package.json（双入口 exports）/ tsconfig / vitest.config + `config/` + `logging/` + `crypto/` + `index.ts` + 对应测试
2. **R2 redis + testing**：`redis/`（client + script-runner，修 B2）+ `testing/` 子入口（connectTestRedis/waitForRedisReady，D2）+ 单元/集成测试
3. **R3 lifecycle + 收口**：`lifecycle/shutdown.ts`（D1 合一，删 B1）+ 测试；全量四门、覆盖率门槛、行为对照核销

### 5.1 行为对照核销清单（2026-08-23 逐项核销，全部满足）

- [x] secretSchema：弱值/短/低多样性三道门拒绝行为与 v1 逐条一致（`__test__/config.test.ts`）
- [x] strictBooleanSchema：'true'/'false'/boolean 三形解析与 v1 一致 + 缺省值补测
- [x] createLogger：redact 根级 + 嵌套（`*`）+ authorization 头三面命中；v1 六字段全保留 + 新增 token/secret/password（B5 修复后根级才真正生效）
- [x] createCipher：enc:v1 格式逐字节一致；**跨仓硬验证通过**——v1 密文 v2 可解、v2 密文 v1 可解（同密钥，实机互跑证实；`test/unit/crypto.test.ts`）
- [x] createRedisClient：maxRetriesPerRequest=1 / enableOfflineQueue=false / 错误监听去重日志（30s）/ URL 脱敏 / AggregateError 展开（`__test__/redis-client.test.ts`）
- [x] parseSentinels：IPv6 lastIndexOf 切分语义 + 非法端口/空规格 fail-fast（`__test__/parse-sentinels.test.ts`）
- [x] assertRedisReachable：冷连接重试 + 超时抛错信息（服务名 + 脱敏 URL + 拒绝降级启动）（真实 Redis 集成）
- [x] script-runner：evalsha + NOSCRIPT 重载自愈（mock 忠实建模 + 真实 Redis SCRIPT FLUSH 双验证）
- [x] createShutdown：v1 三 app 全部可观察行为（顺序/宽限强退/二次信号幂等）+ closeables 顺序（v1 从未测过）+ 收口件失败不阻断 + 日志注入
- [x] waitForRedisReady：100ms 轮询 + 超时 false（`__test__/testing-harness.test.ts`）

### 5.2 实施中的 API 对照变更（相对 v1，均已落码）

| v1 签名                                                          | v2 签名                                          | 理由                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `encrypt(pt, key)` / `decrypt(packed, key)` 双参纯函数           | `createCipher(key)` 工厂                         | 铁律 5 装配一次；SHA-256 派生从每次调用变一次  |
| `createRedisClient(url, { serviceName, ... })` console 硬编码    | 增 `log?: (message) => void`                     | B2 可测性/统一日志面                           |
| `createShutdown` 的 `db: { $client: { end() } }`（drizzle 形状） | `db: { end(): Promise<unknown> }`（pg 原生形状） | runtime 不认识 drizzle 词汇；适配留给 app 装配 |
| `createShutdown` 的 `now?: () => number`                         | 删除                                             | B1 死参数（从未使用）                          |
| shutdown/redis-client console 直打                               | `log` 注入（缺省 console）                       | 与 B2 同理                                     |
| `createLogger` 无输出注入                                        | 增 `stream?: DestinationStream`                  | pino 直写 fd 1，劫持 stdout 不可靠             |
| v1 各处抛原生 `Error`                                            | `InfrastructureError`/`DefectError`（§11 接入）  | 错误根契约；身份/码在抛出点定一次              |
| 测试 `test/unit` + `test/integration` 子目录                     | 包根 `__test__/` 平铺（铁律 14）                 | include 固定 `__test__/*.test.ts`              |
