# `@tillgate/runtime`

仅服务端运行时基础设施包（总纲 §3.1）：config 校验、logging、crypto、redis、进程生命周期。
**禁止业务规则 / 业务 SQL / HTTP route**；只可依赖 `@tillgate/errors`（ADR-0001）。

施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md)（含逐模块审计裁决；本包无独立 DESIGN/MIGRATION）

## 核心能力

- **config**：`strictBooleanSchema(default)`（布尔只收 true/false）与 `secretSchema(field, minLen)` 三道门（长度 ≥ minLen、非已知弱值、≥4 种不同字符）——各 app config.ts 的 zod 组装件
- **logging**：`createLogger({ level, serviceName?, pretty })`——pino JSON 结构化 + redact 脱敏（敏感字段 `apiKey/token/secret/password/key/clientSecret/…` 根级 + `*.` 嵌套 + `req.headers.authorization`，censor `[REDACTED]`；dev 可开 pino-pretty）；`level` 必填注入不藏默认，apps 从 env `LOG_LEVEL`（各 app 缺省 `info`）读出传入
- **crypto**：`createCipher(encryptionKey)`（工厂闭包，SHA-256 派生一次）——AES-256-GCM，密文格式 `enc:v1:<iv>:<tag>:<cipher>` 与存量落库行逐字节兼容；渠道上游 Key / 渠道 secret / 密码信封同源消费
- **redis**：`createRedisClient`（`logThrottleMs` 必填；**Sentinel 拓扑**支持——`sentinels + sentinelName` 判别联合）、`parseSentinels`、`assertRedisReachable`（启动期 fail-fast，冷连接重试直至截止）、`createRedisScriptRunner`（Lua evalsha + NOSCRIPT 自愈）、`createSlidingWindowLimiter`（滑动窗口限流）、`createKeyBruteForceGuard / createAuthFailureGuard`（爆破防护，gateway/client-api/admin-api 装配消费）
- **lifecycle**：`createShutdown(deps)`——优雅停机编排（收口顺序 otel → closeables → redis → db → exit 0；二次信号忽略）
- **testing 子入口**：`@tillgate/runtime/testing`——`testRedisUrl / connectTestRedis / disconnectTestRedis / waitForRedisReady`（全仓真实 Redis 测试装置样板；只许 `*.test.ts` 引用，不进生产 bundle）

## 目录结构（src/）

```
config/       # env-schemas.ts：strictBooleanSchema / secretSchema
logging/      # logger.ts：pino + redact 脱敏（根级+嵌套两级路径）
crypto/       # cipher.ts：AES-256-GCM enc:v1
redis/        # client / sentinels / 可达性断言 / script runner / 限流 / 爆破守卫
lifecycle/    # shutdown.ts：三 app 漂移拷贝合一（serviceName 参数化）
testing/      # Redis 测试装置（子出口）
```

## 依赖与错误

- 双入口：根出口只出生产面，`./testing` 只出测试装置（exports 分离）
- 唯一编译依赖 `@tillgate/errors`；错误码 `runtime.redis.unreachable`（infrastructure）与 `runtime.redis.sentinels_invalid` / `runtime.cipher.invalid_format` / `runtime.cipher.auth_failed`（defect）
- 消费方：全部 apps 的 config/装配/停机；control-plane 与 accounts 的落库加密；notifications 的 SecretCipher 注入源

## 测试

```bash
cd packages/runtime
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```
