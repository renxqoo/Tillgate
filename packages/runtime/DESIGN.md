# @tillgate/runtime 设计基线（DESIGN）

> 状态：定稿（2026-08-23 补档——R1-R3 已实施核销；限流/爆破件经 gateway P5 波 C-G5 裁决入编，见 §1.1）
> 迁移单元：纯服务端运行时基础设施包——配置校验原语、日志、渠道密钥加密、Redis 客户端/脚本/限流/
> 爆破防护、进程停机编排、测试装置（不是垂直业务用例）
> 旧实现：`/Users/wrr/work/ai-getway/packages/core`（12 源文件 ~1375 行 + 5 测试 ~290 行）+
> 三个 app 的 `shutdown.ts` 逐字漂移拷贝（43 行 ×3）——core 是混合包，runtime 只收纯基建半边，
> 观测（otel）归 observability、PG 分类归 db、计费语义/安全策略按消费者归位（IMPLEMENTATION §2.3）
> 目标位置：`/Users/wrr/work/Tillgate/packages/runtime`
> 关联：[project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3.1（runtime 禁止进入：
> 业务规则、业务 SQL、HTTP route）、§5.1（runtime 只可依赖 `errors`）、§9 P3「按消费者切片」；
> [apps/gateway/DESIGN.md](../../apps/gateway/DESIGN.md) C-G5（限流/爆破机制归 runtime、策略归 app）；
> 施工图与审计见同目录 [IMPLEMENTATION.md](./IMPLEMENTATION.md)

---

## 0. 原则

1. **范围收窄是本包的主要边界**：`core → runtime + observability` 拆分的 runtime 半边
   （总纲 §3.2/§9 P3）。纯基建（config/logging/crypto/redis-client/lifecycle）全部收编；
   带计费语义的限流（TPM 预占/结算回填）与安全策略（爆破阈值/降级档）在 v1 曾被裁定不迁，
   gateway P5 波按「机制归 runtime、策略归 app」的 C-G5 裁决将**机制半边**（滑动窗口限流器、
   key/IP 双爆破 guard，含 degraded 本地粗限）平移入编——机制不含任何阈值/维度业务数据。
2. **行为等价**：迁移模块的 v1 旧测试是行为规格；`enc:v1` 密文格式逐字节保持（存量落库行
   不受影响，v1 密钥直接可解——跨仓互解已实机硬验证，IMPLEMENTATION §5.1）。
3. **零隐藏默认**（铁律 3）：连接串、池参数、重试策略、日志档位、限流 fail 模式之外的一切
   可变值必填注入；v1 的隐藏默认（6 处硬编码连接串属 db 波次、`??` 兜底）全部清除。
4. **错误根契约**（AGENTS.md §11）：基础设施错误源头分类——`assertRedisReachable` 抛
   `InfrastructureError`（`runtime.redis.unreachable`，context 只进脱敏后 URL）；`parseSentinels`
   配置缺陷与 `cipher` 解密失败抛 `DefectError`（`runtime.redis.sentiels_invalid` /
   `runtime.cipher.invalid_format` / `runtime.cipher.auth_failed`）；限流/爆破存储不可用抛
   `InfrastructureError`（`runtime.rate_limit_unavailable` / `runtime.auth_guard_unavailable`）。
   `testing/` 子入口保持原生 Error（测试装置非 §11 运行时范畴）。错误 message 一律英文。
5. **不接触全局进程状态**：不建信号注册器（`process.on('SIGTERM')` 留在 app 的 index.ts）；
   runtime 只提供可测编排件（createShutdown 返回函数），exit/log 可注入。

## 1. 问题域

### 1.1 处理

- **config/**：环境变量校验原语——`strictBooleanSchema`（布尔只收 true/false 精确匹配）、
  `secretSchema`（三道门：长度 ≥ minLen、非已知弱值、≥4 种不同字符；黑名单是脆弱兜底、
  强度门是主防线——B3 结论写入注释）。
- **logging/**：`createLogger`（pino + redact；level/pretty 必填；根级 + 嵌套 `*` 两级脱敏
  路径——B5 修复后根级字段才真正生效；`stream` 注入面直写 fd 1）。
- **crypto/**：`createCipher(encryptionKey)` 工厂闭包（AES-256-GCM；SHA-256 派生装配一次；
  `enc:v1:<ivHex>:<tagHex>:<cipherHex>` 格式逐字节保持）。
- **redis/**：`createRedisClient`（sentinel 判别联合拓扑、错误监听 30s 去重日志、URL 脱敏、
  AggregateError 展开、log 注入）、`parseSentinels`（严格十进制端口 1-65535、IPv6 切分）、
  `assertRedisReachable`（启动期 fail-fast，冷连接重试直至截止）、`createRedisScriptRunner`
  （Lua evalsha + NOSCRIPT 自愈）、`createSlidingWindowLimiter`（RPM = ZSET 滑动窗口 +
  TPM = actual+reserved 双计数预占；默认 fail-closed，`failMode:'open'` 才放行；
  release/renew/backfill 恒 best-effort）、`createKeyBruteForceGuard` / `createAuthFailureGuard`
  （key 维 + 来源 IP 维双层爆破防护；三档 fail 模式 `degraded`（默认，本地内存粗限）/
  `closed`（503）/`open`；recordSuccess 恒 best-effort）。
- **lifecycle/**：`createShutdown`（三 app 漂移拷贝合一；收口顺序 v1 语义：otel → closeables →
  redis → db；二次信号幂等忽略；宽限 `<1000` 按 1000 生效并注释声明）。
- **testing/ 子入口**：`testRedisUrl` / `connectTestRedis` / `disconnectTestRedis` /
  `waitForRedisReady`——只许 *.test.ts 引用（v1 八处样板的替代，D2）。

### 1.2 明确不处理（写明归属，不留白）

| 不处理                                                  | 归属                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| otel.ts（OTel SDK、内存环形缓冲、traceparent）          | `observability`（P3 后续迁移单元）                                       |
| pg.ts（SQLSTATE 探测）                                  | `db` `pg-error.ts`（PG 基础分类归 db）                                   |
| 限流**策略**（维度组装、并罚制、global 维、阈值数值）   | 消费 app（gateway `http/middleware/rate-limit`，C-G5）                   |
| 爆破**策略**（keyHash/IP 提取语义、可信代理跳数、阈值） | 消费 app（注入 guard；C-G5）                                             |
| TPM 预占的**结算回填编排**（worker 侧消费语义）         | worker / billing 迁移单元                                                |
| app 配置 schema（env 读取与模式推导）                   | 各 app 自有 config.ts（app 配置不进 runtime；trace-receiver R4/R5 先例） |
| `.env` 加载 / 进程入口 / 信号注册                       | 根配置与 app index.ts（runtime 只出编排件）                              |
| 请求日志 / 审计 / trace 消费                            | `observability`                                                          |
| 优雅停机的调用时机                                      | app 进程入口（createShutdown 返回函数由 app 持有并接信号）               |

## 2. 外部契约（v2 API，定稿）

```ts
// 根入口 @tillgate/runtime（生产面）
strictBooleanSchema(defaultValue)            // 'true'/'false'/boolean 三形，其余拒
secretSchema(field, minLen)                  // 密钥三道门
createLogger({ level, serviceName?, pretty, stream? }): Logger
createCipher(encryptionKey): Cipher          // { encrypt(pt), decrypt(packed) }——enc:v1 逐字节兼容
parseSentinels(spec): { host, port }[]       // 非法项/空规格/越界端口 fail-fast
createRedisClient(url, { serviceName, logThrottleMs, sentinels?, sentinelName?, sentinelPassword?, log? }): Redis
                                             // sentinel 形态 sentinelName 必填（判别联合）；logThrottleMs 必填
assertRedisReachable(redis, serviceName, rawUrl, timeoutMs): Promise<void>
createRedisScriptRunner(redis): RedisScriptRunner
createSlidingWindowLimiter(redis, opts): SlidingWindowLimiter   // checkRpm/checkTpm/reserveTpm/releaseTpm/renewTpm/backfillTpm
rateLimitUnavailable(cause)                  // fail-closed 语义错误构造（infrastructure）
createKeyBruteForceGuard(redis, policy): KeyBruteForceGuard     // recordFailure/recordSuccess/check
createAuthFailureGuard(redis, policy): AuthFailureGuard         // 三档 failMode，degraded 本地粗限
authGuardUnavailable(cause)
createShutdown(deps): (signal) => void       // 见下

// 停机编排（全必填核心件 + 可选注入）
createShutdown({
  serviceName, server: { close }, otel: { shutdown },
  redis: { quit } | null, db: { end },        // db 收 pg 原生 end() 形状（drizzle 经 $client.end 适配）
  graceMs,                                    // <1000 按 1000 生效（强退定时器正确性下界，B4 注释在案）
  closeables?, exit?, log?,                   // 附加收口件失败不阻断；exit/log 测试注入
})

// 子入口 @tillgate/runtime/testing（只许测试引用）
testRedisUrl() / connectTestRedis(timeoutMs?) / disconnectTestRedis(redis) / waitForRedisReady(redis, timeoutMs?)
```

- 双入口 exports：`.`（development/src、types、import/dist 三条件）与 `./testing` 平级——
  vitest 语义不混入生产 bundle；build 双入口产物。
- 全部工厂闭包形态（铁律 5，无 class 依赖捕获）；`createCipher` 取代 v1 双参纯函数
  （SHA-256 派生从每次调用变装配一次）；`createShutdown` 删除 v1 死参数 `now?`（B1），
  db 收口形状从 drizzle 词汇改 pg 原生（runtime 不认识 drizzle）。

## 3. 词表与语义

- **fail 模式词表**：限流 `{ closed（默认）| open }`；爆破防护 `{ degraded（默认）| closed | open }`
  ——closed = infrastructure 503 拒绝；open = 放行（仅失去防护/限流，资金正确性另有硬闸门）；
  degraded = Redis 不可用时降质为每实例内存粗限（固定窗口 + 本地锁，auth-local-guard），
  恢复后自然回精确计数。策略数据（阈值、窗口、维度键）全部由调用方 policy 注入，包内零默认。
- **错误码**（§11 源头分类）：`runtime.redis.unreachable` / `runtime.redis.sentinels_invalid` /
  `runtime.cipher.invalid_format` / `runtime.cipher.auth_failed` /
  `runtime.rate_limit_unavailable` / `runtime.auth_guard_unavailable`。
- **enc:v1 密文格式**：`enc:v1:<ivHex>:<tagHex>:<cipherHex>`——与存量落库行逐字节兼容的
  物理事实，改动等同数据迁移。

## 4. 治理与稳定性

1. **依赖白名单**：内部仅 `@tillgate/errors`（总纲 §5.1）；外部 `pino` / `pino-pretty`
   （pretty transport 动态加载）/ `ioredis` / `zod`。禁止 drizzle / hono / 业务包
   （`__test__/architecture.test.ts` 锁定）。
2. **testing 子入口引用面**：架构测试限定 `./testing` 只被测试文件引用
   （scripts/check-package-boundaries 门禁建立后并入 CI）。
3. **行为等价验证**：v1 测试迁移矩阵核销完毕（IMPLEMENTATION §5.1 十项全勾，含跨仓
   enc:v1 互解硬验证）；API 对照变更（工厂化、log 注入、pg 原生形状、铁律 14 平铺）逐条
   列于 IMPLEMENTATION §5.2。
4. **覆盖率**：与全仓同门槛（lines/statements/functions 90、branches 85）。

## 5. 并发与性能预算

无热路径帧预算（本包是装配期工厂 + 启动期断言 + 停机编排；IMPLEMENTATION/代码注释中的
显式数字化约束如下，未列之处无显式预算）：

- **错误日志去重窗口** `logThrottleMs` 必填注入（v1 语义 30s 同错误只记一次）——防错误风暴
  打爆日志面。
- **冷连接等待**：`waitForRedisReady` 100ms 轮询返 bool（测试装置）；`assertRedisReachable`
  由 timeoutMs 注入截止、冷连接重试直至超时抛错（生产启动路径）。
- **停机定时器**：强退定时器 `unref`（不阻止进程退出）；宽限下界 1000ms 是强退定时器
  正确性的前提（防御而非 fail-fast，B4 注释在案）。
- **限流/爆破件的 Redis 往返**：RPM 判定单 Lua 脚本原子执行（evalsha）；TPM 预占双计数；
  释放/续租/回填恒 best-effort 不反杀在途请求（TTL 兜底）——机制件自身无跨请求可变状态
  （Redis 是共享存储，进程内零缓存）。
- **cipher**：装配期 SHA-256 派生一次；加解密 O(明文长度)。
