# @tillgate/gateway 迁移实现文档（施工图）

> 状态：app 本体已完成（2026-08-23；见 MIGRATION §8 收口记录）
> 设计基线见 [DESIGN.md](./DESIGN.md)；行为规格与测试矩阵见 [MIGRATION.md](./MIGRATION.md)。

---

## 0. 原则

- 旧仓代码是行为语义参考（`/Users/wrr/work/ai-getway/apps/gateway`），迁移 = 语义重写；
  pipeline 族已迁 `@tillgate/inference`（P4 wave-4），本波**只落 app 面与装配桥**。
- 一动词一文件、工厂闭包（铁律 5）；测试平铺 `__test__/`（铁律 14）；错误目录 `gateway.*`
  - 组合面（铁律 18 / §11）；单文件 ≤500 行（oxlint max-lines）。
- app 非 assembly 代码不引用 `Db/DbTx`/`./composition`（P5；架构测试机器锁定，
  trace-receiver 范式 + `adapters/` 桥列入装配面白名单——见 §3 架构测试）。

## 1. 审计结论（app 层；inference 族 B# 见其 IMPLEMENTATION §1）

- **A1 oauth-token 直查 apps 表**（v1 routes/oauth-token.ts:120-123，其架构测试自注债务）：
  v2 修复——凭证校验走 `accounts.verifyAppClient`，SQL 不进 app。
- **A2 requestId 服务端生成**（v1 S1 修复已落地）：保留；`@tillgate/http` `requestIdMiddleware`
  同语义（注释明示防绕过），直接消费不自写。
- **A3 CORS/安全头/bodyLimit 三件**：v1 app 内实现 → v2 `@tillgate/http` 已有同源件
  （trace-receiver 波收口），消费不自写。
- **A4 v1 `AppError`**（status+code 自带）：v2 由目录 `BusinessError` + face override 取代；
  路由层不再自造错误类。
- **A5 双信封形状**：`not_found` 在 `/v1/` 与其他路径文案不同（v1 :69-75）——保留语义，
  统一走 `http.not_found` 目录码。
- **A6 e2e-kit 以字面量 config 强转注入**（v1 `as never`）：v2 e2e 夹具走 `loadConfig(env)`
  真实入口，消除类型旁路。
- **A7 `estimateAudioDurationSeconds` 解析失败兜底 1 秒**：保留（宁可多扣不少扣）。
- **A8 JWT 分支只计 IP 维、Key 分支双计**（v1 :163-165/:185-191）：保留（Key 可枚举、JWT 不可）。
- **A9 /oauth/token 失败 401 用 OAuth 标准错误形**（`invalid_client`，非 OpenAI 信封）：保留。

## 2. 逐模块裁决表（旧 → 新）

| 旧文件（ai-getway/apps/gateway/src） | 裁决                                                          | 新位置                                                           |
| ------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| config.ts                            | 重写（键面保留 + v2 secretSchema/strictBoolean + 废弃键告警） | src/config.ts                                                    |
| index.ts                             | 重写（runtime shutdown + 配置快照）                           | src/index.ts                                                     |
| shutdown.ts                          | 重写（runtime createShutdown 绑定；目标树指定独立文件）       | src/shutdown.ts                                                  |
| assembly.ts                          | 重写（inference facade 装配 + 五桥）                          | src/assembly.ts                                                  |
| app.ts                               | 重写（错误面 composeErrorCatalogs + 路由挂载）                | src/app.ts                                                       |
| http/error-map.ts                    | 重写（24 条 instance 表 → 目录组合 + face override 表）       | src/http/openai-error-face.ts                                    |
| http/sanitize.ts                     | 复制+微修                                                     | src/http/sanitize.ts                                             |
| middleware/api-key.ts                | 重写（accounts 读模型 + jose app_jwt 分支 + runtime guards）  | src/http/middleware/api-key.ts                                   |
| middleware/request-id.ts             | 删除（http 包同源件）                                         | —                                                                |
| middleware/security.ts               | 删除（http 包三件）                                           | —（app.ts 组装）                                                 |
| middleware/request-log.ts            | 重写（observability RequestLogStore 注入）                    | src/http/middleware/request-log.ts                               |
| middleware/otel.ts                   | 改写（observability OTel 再出口）                             | src/http/middleware/otel.ts                                      |
| rate-limit/gate.ts                   | 改写（runtime limiter 机制 + app 策略）                       | src/http/middleware/rate-limit.ts                                |
| routes/inference-endpoints.ts        | 改写（schema → contracts/；调用面 → inference facade）        | src/http/routes/inference-endpoints.ts + src/http/contracts/*.ts |
| routes/native-protocol.ts            | 改写（ai codec 出口）                                         | src/http/routes/native-gemini.ts                                 |
| routes/models.ts                     | 改写（control-plane 目录读 + accounts 白名单）                | src/http/routes/models.ts                                        |
| routes/modality-multipart.ts         | 改写                                                          | src/http/routes/modality-multipart.ts                            |
| routes/generation.ts                 | 改写（inference.generation submit/query）                     | src/http/routes/generation.ts                                    |
| routes/oauth-token.ts                | 重写（A1 修复）                                               | src/http/routes/oauth-token.ts                                   |
| （v1 pipeline/run-chat 信封分派）    | 重写（ChatDelivered 三态 → Response）                         | src/http/openai-envelope.ts                                      |
| billing/wakeup.ts                    | 复制+微修（通道常量单源）                                     | src/adapters/settle-wake.ts                                      |
| （无：五个装配桥）                   | 新写（DESIGN C-G2/3/4 + 任务/健康）                           | src/adapters/{catalog-port,billing-port,funding?}.ts             |
| （v1 core/redis 三件）               | 平移（DESIGN C-G5）                                           | packages/runtime/src/redis/{rate-limiter,auth-guards}.ts         |
| （v1 generation-task.repo）          | 重写（inference 端口形状）                                    | packages/inference/src/adapters/generation-pg.ts                 |
| （v1 repo 读法：映射/渠道/费率卡）   | 重写（只读目录）                                              | packages/control-plane/src/**（§4.3）                            |
| （v1 凭证→资金来源读法）             | 新写                                                          | packages/accounts/src/adapters/postgres/funding-resolver.ts      |
| e2e-kit.ts + e2e-*.test.ts×7         | 搬迁改写（e2e-worker 显式缓迁，见 MIGRATION §5）              | e2e/gateway、e2e/security                                        |

## 3. 拆分后的 app 结构

```text
apps/gateway/
├── src/
│   ├── index.ts                  # 进程启动（listen/信号/配置快照）
│   ├── config.ts                 # env schema + 缺省 + 生产 fail-fast
│   ├── assembly.ts               # 唯一装配根（composition 白名单唯一消费者）
│   ├── app.ts                    # createGatewayApp（Hono；错误面/中间件序/路由挂载）
│   ├── shutdown.ts               # createGatewayShutdown（runtime 绑定）
│   ├── http/
│   │   ├── contracts/            # 请求 zod schema（chat/embeddings/completions/responses/
│   │   │                         #   claude/images/audio-speech/rerank/moderations/video/music）
│   │   │                         #   + 端点表（path/kind/codec/stream）
│   │   ├── routes/               # inference-endpoints / native-gemini / models /
│   │   │                         #   modality-multipart / generation / oauth-token
│   │   ├── middleware/           # api-key / otel / request-log / rate-limit
│   │                         #   （api-key 与 rate-limit 各包阶段 span：auth.api_key /
│   │                         #   rate_limit.admit——docs/observability.md §3 全链清单）
│   │   ├── openai-error-face.ts  # 目录组合 + face override（502/402/429…）+ OAuth 错误形
│   │   ├── openai-envelope.ts    # 交付三态 → Response（SSE/raw/json + x-request-id）
│   │   └── sanitize.ts           # 上游细节脱敏（§3.6 三层）
│   └── adapters/                 # inference 端口生产实现（装配面专属，架构测试白名单）
│       ├── catalog-port.ts       # C-G2：control-plane 读 + billing 纯函数 → CatalogPort
│       ├── billing-port.ts       # C-G3：BillingPort ← billing facade
│       ├── trace-port.ts         # inference TracePort ← observability withAsyncSpan（阶段 span）
│       └── settle-wake.ts        # C-G8：pg_notify 生产端
└── __test__/                     # 平铺（铁律 14）
```

架构测试（§5.5 机器锁定，trace-receiver 范式扩展）：
src 顶层文件集合快照；`/composition` 只允许出现在 {assembly.ts, adapters/_}；
`@tillgate/db` import 与 `Db/DbTx` 类型只允许 {index,config,assembly} ∪ adapters/_
（app.ts 与 http/** 禁入）；跨包 import 只走包名（禁 `/src/` 深导入）；http/** 不 import
`@tillgate/ai`（§3.6：ai 类型消费方自 inference 出口引用）。

## 4. 能力包补件（同波落地）

1. **runtime**：`createSlidingWindowLimiter`（check/checkAll/reserveTpmAll/releaseTpm/
   renewTpm/backfillTpm；RPM ZSET + TPM hash 预占，Lua CAS，TTL 600s，`rl:` 键前缀）+
   `createKeyBruteForceGuard`/`createAuthFailureGuard`（degraded 本地粗限降级体；fail 模式
   open/closed/degraded）。v1 源：packages/core/src/redis/{rate-limiter,auth-guards,
   auth-local-guard}.ts——逐文件审计后平移（B# 见 v1 源注释与 e2e 断言）。
2. **ai**：根出口补 protocol codec（completions/responses/claude/gemini 双向 + 流式转换）
   与 `estimateAudioDurationSeconds`（usage/media-duration）。纯加导出，零实现变更。
3. **inference**：`CatalogPort.findMapping(externalModel, pricing)` 扩展（quote.ts/
   candidates/harness/测试同步）；`adapters/generation-pg.ts` + 根出口
   `createPostgresGenerationTaskStore`（real PG 测试）。
4. **control-plane**：只读目录——ModelStore `findActiveByExternalName(s)`（status 过滤 +
   快照全列）、ChannelStore `findRouteCandidates(realModel)`（启用渠道+密文+priority/weight）、
   RateCardStore `findActiveCardByUser(userId)`；facade 增 `reader` 组；新增 `./composition`
   出口 postgres store 工厂（app 装配取件，billing 同范式）。
5. **accounts**：`./composition` 新增 `createPgFundingSourceResolver(db)`（billing
   FundingSourceResolver 结构等价实现；api_keys/users 凭证事实）。

## 5. 测试计划（先行；铁律 16 边界即规格）

| 文件                             | 覆盖                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| config.test.ts                   | 缺省值表、必填 fail-closed、fixed/full 交叉校验、生产密钥门槛、'false' 字符串不开逃生门、GLOBAL_RPM 生产钳制、废弃键告警                                                                     |
| app.test.ts（real PG）           | healthz/livez/readyz、鉴权全路径（有效/缺头/错前缀/未知/吊销/过期/未注册 404）、JWT 伪造→锁定→锁后合法也拒、错误面 24 码 × status 核销、信封形状                                             |
| error-face.test.ts               | 目录组合封闭性、502/402/429 override、上游 502 脱敏端到端（不泄漏真实模型/URL）、OAuth 错误形                                                                                                |
| api-key.test.ts                  | 双形态分派、scope 白名单、allowPaygFallback 语义、socket 缺注防御（A8 维度计数）                                                                                                             |
| rate-limit.test.ts（real Redis） | 并罚制（高限额 Key 不越用户帽）、key RPM/TPM 429 零落账、渠道超限换渠 200、TPM 全败归还、global 维、Retry-After                                                                              |
| routes.test.ts                   | 9 端点契约（schema 拒绝矩阵/codec 往返/embeddings 0 输出/模态强制非流式/engines 别名/gemini 双动作）、multipart 白名单与上界、generation 201/404 归属、oauth token 三形态、models 三协议形状 |
| request-log.test.ts              | 401/429 入日志、SSE 不嗅探 errorCode、requestSummary 截断、写失败不阻塞                                                                                                                      |
| shutdown.test.ts                 | drain 顺序、宽限耗尽 exit(1)、二次信号幂等                                                                                                                                                   |
| architecture.test.ts             | §3 机器锁定清单                                                                                                                                                                              |
| adapters.test.ts（real PG）      | catalog-port（费率卡系数三层解析、fallback 链、停用卡 403、快照列全）、billing-port（词表映射、金额推导、explicitlyFree、重放透传）、settle-wake NOTIFY 到达                                 |
| smoke（双形态）                  | bun 源码 / node dist：readyz 200、401 信封、413、SSE 透传、SIGTERM 排空、冒烟数据自清                                                                                                        |
| e2e/gateway（根）                | attack/params-floor/cost-drain/slow/auth-audit 归组改写；rxm3 真上游单列 real；worker 缓迁（MIGRATION §5）                                                                                   |

## 6. 实施顺序（每阶段独立提交 + 四门）

1. 方案文档三件（本提交）。
2. runtime 限流/爆破件 + ai 出口补件（独立可回滚）。
3. inference 端口扩展 + pg 任务存储；control-plane 只读目录 + composition；accounts resolver。
4. gateway 骨架：config/app/envelope/error-face/middleware/index/shutdown（chat 主链）。
5. routes 全量（codec/gemini/multipart/generation/oauth/models）+ adapters 桥。
6. 测试全量 + real PG/Redis + e2e 归组 + 双形态冒烟。
7. 收口核销（MIGRATION §7 清单逐项打勾、各包文档状态推进）。

---

## 7. 增量：SSRF 装配收口与免费闸口径（2026-08-25 审计复核）

1. **上游白名单接线**：config 新增 `GATEWAY_UPSTREAM_ALLOWED_HOSTS`
   （逗号分隔；生产必填，schema superRefine fail-fast），assembly 生产形态
   给 `createAi` 注入 `guardUrl = assertSafeUrl(url, { allowedHosts })`——
   ai DESIGN §0.4「生产组合形态」自此真正装配（此前生产只跑机械基线，
   rebinding TOCTOU 窗口实际存在）。渠道新增 provider 域名需同步扩 env。
2. **免费闸 Decimal 口径**：`adapters/billing-port.ts` 的 `allPricesZero`
   由 `Number(p) === 0` 改 `Decimal(p).isZero()`（脏值非免费——空串曾被
   Number 归零误盖 `explicitlyFree`；口径与全包 Decimal 一致）。
   回归：`__test__/billing-port-free-gate.test.ts`（复核批次红测转绿）。

## 增量：出口信任回归运营面（2026-08-25 ADR-0010）

撤销 §7 第 1 条的 env 白名单形态：删除 `GATEWAY_UPSTREAM_ALLOWED_HOSTS`
（schema / superRefine 生产必填门禁 / `GatewayConfig.upstreamAllowedHosts` /
装配注入），`guardUrl` 回归 `assertSafeUrl(url)` 机械基线（https-only +
私网与 IPv6 内嵌解包拒绝 + DNS 逐地址判定 + 重定向不跟随）。裁决依据：
上游 hostname 全部来自 admin 域渠道/provider 表，env 列表只能是 DB 镜像，
多云动态厂商集合使枚举不可运维；残余风险与回摆条件见 ADR-0010。
§7 第 2 条（免费闸 Decimal 口径）不受影响。
