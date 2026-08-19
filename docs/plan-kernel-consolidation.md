# 计划:三内核收敛(money→wallet、identity→identity-core、ledger→ledger-core+wallet)

> 状态:P1 已完成(money 并入 `wallet/metering` 并删除包);P2 已完成(密码收敛 identity-core、
> 会话吊销迁锚点表(realm 隔离双身份)、验证码迁 PG 挑战表);P3 已完成(13 处 fund_operations
> 内联幂等样板收敛为 ledger-core.run,指纹统一 canonical,fund_operations 已回填 11946 行至
> ledger_operations,payment_orders 外键改指新表;旧表保留只读观察)。
> **P4/P5 已被 docs/plan-ledger-rewrite.md 取代**(ledger 解体重写:wallet 单一资金事实源)。
> 原则:治本不治标 / 删除优于兼容 / 破坏性变更一次做完整 / 错误语义分级 / 资金迁移必须可校验可回退

## 1. 背景与现状

- 已建成三个业务无关内核(零 workspace 依赖、自带 schema、契约测试打真 PG):
  `wallet`(复式账本 + 两阶段)、`ledger-core`(幂等操作内核)、`identity-core`(身份事实内核)。
- **三个内核目前零消费**:apps 仍全量依赖老 `ledger`(5229 行,4 app / 38 导出)、
  老 `identity`(1075 行,3 app / 21 导出)、`money`(183 行,4 app + ledger 内部 20+ 文件)。
- 三处实质重复:
  1. ledger.ts 的 fund_operations 幂等样板(约 40 行 × 10 处)与 ledger-core 同构,表列几乎相同;
  2. identity/password.ts 与 identity-core/password.ts 近乎复制(scrypt 格式逐字兼容);
  3. 指纹逻辑三份(ledger.ts、billing/quote.ts、wallet/idempotency.ts)。
- 用户决策:**老包删除,业务代码改用三个内核;money 并入 wallet(wallet 管钱)**。
  直接删不可行(老包含内核没有的业务层与会话层),故分五阶段:先并钱、再接线、
  最后大手术(billing 两阶段迁 wallet),死代码随阶段删除。

## 2. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| 1 | money 归宿 | 并入 wallet 作**子导出 `@ai-gateway/wallet/metering`**(calcAmount / estimateMaxCost / requiredReservation / PRICE_PER_MILLION / toDecimal);Decimal 统一用 wallet 的 clone(precision 40、禁科学计数法)。根导出不收计费公式——保住「整目录拎出独立仓」的内核契约 |
| 2 | Decimal 精度 | money 现用全局默认 precision 20 → 统一 40。方向是**变精不会变粗**,DB numeric(38,18) 不变,无舍入回退风险;wallet 既有测试锁精度行为 |
| 3 | identity 长期定位 | app 适配层永驻:JWT 签验 / 双身份 Cookie / Hono 中间件 / 登录限流 / Turnstile / SMTP mailer 留在 identity(内核有意不收);password 与登录验证码下沉 identity-core |
| 4 | 会话失效线 | 从 users.sessionInvalidBefore 列迁到 identity-core 的 `identity_session_anchors`(advanceAnchor / sessionValidAt);一次性迁移(数据量小、语义单调),中间件验签后追加锚点检查 |
| 5 | ledger 长期定位 | 保留包名与多数导出,重写为**业务编排层**:依赖 db + ledger-core + wallet;订阅/兑换码/支付/渠道/对账/worker 管线的业务语义不动,内核机制换掉 |
| 6 | billing_requests | 保留为业务状态机(8 态),**不**复用 wallet 冻结单状态机;只把「钱的事实」(余额/预扣/实扣)移交 wallet |
| 7 | 订阅额度/成员配额 | 非钱维度(额度不是余额),留在业务表,不进 wallet |
| 8 | 渠道进货敞口 | 进 wallet 内部科目(`channel_cost`,正好用 v4 分片消热点);channels 表投影列退役 |
| 9 | 老 transactions 流水 | **只读封存,不迁移成 wallet_legs**(历史数据不改写);报表查询保留直读老表,新流水落 wallet |
| 10 | 数据迁移方式 | 停机窗口 + 开账幂等交易 + 全量校验(Σ 相等才切流);**不做在线双写**(资金幂等表双写会分叉) |
| 11 | money 包删除时机 | 所有 import 改指 wallet/metering 后即删(P1 内完成);wallet 的私有 money.ts 与 metering 并存,前者是内核规范、后者是计费策略 |

## 3. 目标架构

```
packages/
  wallet            资金内核:复式账本 + 两阶段 + money 规范 + metering(计费公式)
  ledger-core       幂等内核:operationId + 指纹 + 回执重放
  identity-core     身份内核:凭据/挑战/OAuth/TOTP/吊销锚点(七表)
  ledger            业务编排层(重写后):订阅/兑换码/支付/渠道/对账/结算编排
                     ├─ 幂等动词 → ledger-core.run()
                     ├─ 钱的事实 → wallet 动词
                     └─ 业务状态机/配额 → db 业务表(不动)
  identity          app 适配层(瘦身后):JWT/Cookie/中间件/限流/captcha/mailer
                     ├─ password 哈希 → identity-core(re-export)
                     ├─ 登录验证码 → identity-core challenge + effects.deliver=mailer
                     └─ 会话失效 → identity-core anchors
  core/db/http/tracing/ui/api-client/ai   不变
删除:money(P1 末)、identity/password.ts + login-code.ts(P2 末)、
     db 老投影列 + fund_operations 表(P3 观察期后 / P4 切流后)
```

依赖方向不变式:**内核零 workspace 依赖;业务层/适配层可依赖内核;内核永不反向依赖**。

## 4. 分阶段实施

### P1 money → wallet 合并(独立,先做)

改动:
1. `wallet/src/metering.ts`:迁入 amount.ts / reservation.ts(Decimal 改用 wallet clone,
   PRICE_PER_MILLION / toDecimal / calcAmount / estimateMaxCost / requiredReservation /
   ReservationError 原样);`package.json` 增 `./metering` 子导出;tsup 入口加 metering。
2. money 的 3 个测试文件迁入 wallet `src/__tests__/`(全精度断言不改)。
3. 全仓 import 替换:`@ai-gateway/money` → `@ai-gateway/wallet`(Decimal/toStorage)
   或 `@ai-gateway/wallet/metering`(其余);涉及 ledger 20+ 文件、gateway、worker、
   admin-api、client-api。
4. 删 `packages/money`。

验收:全 workspace typecheck/lint/test/build 绿;metering 回归测试全绿;DB 零变更。
回滚:git revert(纯代码,无 DB)。

### P2 identity 接线 identity-core(密码去重 + 验证码迁移 + 吊销锚点)

改动:
1. identity 依赖 identity-core;删 `password.ts`,改 re-export identity-core 的
   hashPassword/verifyPassword/assertPasswordPolicy(存储格式逐字兼容,存量哈希不动;
   哑哈希常量不同不影响——仅时序掩护用)。
2. 删 `login-code.ts`:identity 内新建薄封装 beginLoginChallenge / verifyLoginChallenge /
   abortLoginChallenge → identity-core beginChallenge/verifyChallenge/abortChallenge,
   `effects.deliver` 注入 mailerFromEnv 发码;冷却/计错/一次性消费由 DB 不变量保证,
   Redis keyspace 退役(键自然过期)。
3. 会话吊销锚点迁移:
   - provision identity-core 七表(接入 docker/Dockerfile.migrate,同 wallet 先例);
   - 回填:`identity_session_anchors` ← users.sessionInvalidBefore / admins.sessionInvalidBefore
     中大于 epoch 的行;
   - 两个中间件验签后追加 `sessionValidAt(userId, iatMs)`;改密/重置走 advanceAnchor;
   - 一个版本后删老列读取。
4. 双身份隔离(identity-core 不处理):沿用 identifier 归一化维度区分——
   admin/user 各自的白名单 scope 与 effects 元数据,**实施首日以 identity-core
   README 的挑战配置为准落位**(见 §6 待确认 Q1)。

验收:identity 6 测试文件 + identity-core 13 文件全绿;登录/验证码/改密全链路冒烟;
存量会话不失效(锚点回填等于原失效线)。
回滚:re-export 层直接 revert;挑战迁移 revert 后重发验证码即可(Redis 本就易失)。

### P3 ledger 幂等接线 ledger-core

改动:
1. ledger 依赖 ledger-core;ledger.ts 的 fund_operations 样板(约 10 处)改为
   `ledger-core.run({ operationId, kind, fingerprint, execute })`;kinds 白名单 =
   现有 operation kinds。
2. 指纹统一:删 ledger.ts 与 billing/quote.ts 两份 sha256,改用 ledger-core 的
   canonicalJson / fingerprintOf(billing_requests 的 authorization_fingerprint 值域
   随之变化——新旧指纹不比对历史,重放语义不变)。
3. 表迁移:provision `ledger_operations`;低流量窗口单事务
   `INSERT...SELECT`(operation_id/kind/fingerprint/result→receipt 映射)回填
   fund_operations;代码切读新表;**观察期(≥1 个结算周期)后 DROP fund_operations**
   与 `db/src/schema/fund-operations.ts`。

验收:ledger 27 测试文件全绿;operationId 重放回归用例(同键同参/同键异参/并发);
对账 reconcile 四组等式通过。
回滚:观察期内 fund_operations 未动,revert 代码即回老表;新表数据可弃
(回执已在 result 兼容格式)。

### P4 billing 两阶段迁 wallet(大手术,实施前需再出细化设计)

骨架(细化设计另立文档,含接口映射表/迁移脚本/回滚演练):
1. 钱的事实移交:
   - users.balance/credit_limit → wallet_accounts(kind=user)+ credit / credit_line;
   - users.reserved_balance → 每张活跃 billing_requests 一张 wallet authorization
     (refType='billing',refId=requestId,expiresAt=租约到期);
   - 渠道进货 → `channel_cost` 内部科目(shard 化);
   - settle:worker settleClaim 的扣费段 → wallet.settle(实际金额,counterparty=
     platform_revenue),usage_logs/套餐/渠道收尾留业务层同事务;
   - release/超时 → wallet.release / maintenance.releaseExpired。
2. 停机窗口数据迁移(单事务或分批):
   1) 每用户 credit(balance) 开账,幂等键 `migration/opening/{userId}`;
   2) credit_line(credit_limit);
   3) 活跃 request 逐张 authorize 重建在途;
   4) 渠道科目 transfer 开账;
   5) 校验:wallet.verifyInvariants + 每用户 wallet 余额 == 老 users.balance、
      Σ 在途 == 老 reserved_balance,全等才切流;
   6) 老列保留只读一个版本后 DROP。
3. gateway(59 测试文件)authorize 路径与对账公式改 wallet 口径;billing 三重闸
   (admission/订阅/余额)语义不动,只有「预占动作」换 wallet.authorize。

验收:gateway/worker 全量测试;对账新口径连续 N 天零差异;verifyInvariants 常绿。
回滚:老列只读期可反向回填开账(开账交易不可逆,但老列仍在 = 数值可回退)。

### P5 清理收尾

- DROP:users.balance / reserved_balance / credit_limit / sessionInvalidBefore、
  admins.sessionInvalidBefore、channels.upstream_reserved(+balance 若已入科目)、
  fund_operations(P3 观察期后)。
- transactions 老表标记封存(只读),报表查询保留。
- 根 README / docs/architecture.md 收录目标架构;删除过时引用。

## 5. 依赖与顺序

```
P1(money)──┐
P2(identity)┴→ P3(ledger-core) → P4(wallet 大手术) → P5(清理)
```
P1、P2 相互独立可并行;P4 必须在 P3 之后(幂等先行);每阶段全量验收后再进下一阶段。

## 6. 待确认问题(评审时拍板)

| # | 问题 | 影响 |
|---|---|---|
| Q1 | identity-core 挑战域如何映射 admin/user 双身份(identifier 归一化 + scope 配置的准确落位) | P2 实施首日核对,不改架构 |
| Q2 | P4 停机窗口可接受时长(全量用户开账 + 校验,量级取决于 users 行数;可分批预演) | P4 细化设计输入 |
| Q3 | 老 transactions 报表(admin 统计/用户用量页)是否直读老表即可,还是需要统一视图 | P5 是否要建视图 |
| Q4 | authorization_fingerprint 值域变化(P3.2)是否有外部系统依赖旧指纹 | 若有,保留旧算法读路径 |

## 7. 风险清单

| 风险 | 缓解 |
|---|---|
| Decimal 精度统一(20→40)改变 calcAmount 边界值 | 只会更精;metering 测试断言锁行为 |
| 挑战从 Redis 迁 PG 后冷却语义漂移 | identity-core 挑战有契约测试;冒烟覆盖发码→错码→重发 |
| fund_operations 切换期间 operationId 重放 | 单事务切换 + 观察期双表并存(老表只读可回) |
| P4 开账后 wallet 与老列不一致 | 全量校验门禁:不全等不切流;老列只读期兜底 |
| gateway 测试面大(59 文件) | P4 细化设计先出接口映射表,测试随迁移口径重写 |
