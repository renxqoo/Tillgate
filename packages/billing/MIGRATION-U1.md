# U1 钱包垂直用例迁移文档

> 状态：已核销（U1a domain 定律 + U1b 动词/adapter/真 PG 测试；验收数字见 §7）
> 迁移单元：钱包账户的九个动词（credit/authorize/settle/release/refund/transfer/setCreditLimit/freeze + accounts/statement 读侧）——一个不可拆的账本事务族
> 旧实现：`/Users/wrr/work/ai-getway/packages/service/src/wallet/`（15 文件约 1070 行）+ `packages/repository/src/wallet.repo.ts`（约 450 行）+ `packages/domain/src/wallet/`（定律，480 行）+ `packages/db/src/schema/wallet.ts`（表，已在新仓）
> 目标位置：`packages/billing/src/domain/wallet/*`（U1a 已落）+ `application/wallet/*` + `adapters/postgres/*`（U1b）
> 关联：DESIGN §2/§4、IMPLEMENTATION §1.2 B1/B5 / §2 裁决表 / §3、ADR-0003 决策 2/5

## 1. 行为规格基线

旧测试清单（行为等价的判定标准；全部需真实 PostgreSQL）：

| 旧测试                                         | 用例数 | 覆盖                                                                                                                                   |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `service/__tests__/wallet.test.ts`             | 56     | credit 入账、authorize/settle/release 两阶段闭环、transfer/setCreditLimit、refund、风控冻结、复式守恒（DB 触发器同盟）、跨动词共享事务 |
| `service/__tests__/wallet-attack.test.ts`      | —      | 金额攻击面（四动词结构性拒绝）、引用键攻击面                                                                                           |
| `service/__tests__/wallet-coverage.test.ts`    | —      | statement 腿级游标分页、多币种并存、信用/现金双口径矩阵、expiresAt 结算权威截止                                                        |
| `service/__tests__/wallet-idempotency.test.ts` | —      | 并发同键竞态（唯一冲突兜底重放）、顺序重放首答全等                                                                                     |
| `domain/wallet/__tests__/posting.test.ts`      | 17     | 复式定律 ×6、敞口守卫 ×5、指纹规范化 ×2（指纹部分已随 U0 迁移并反转）                                                                  |

删除/改写的用例：

- posting.test.ts 的指纹两用例（undefined 丢弃同指纹）——随 B4 反转，已在 U0 fingerprint.test.ts 以新语义覆盖。
- 所有错误类 instanceof 断言——换目录码断言（D5；如 InsufficientBalanceError → `billing.insufficient_balance`）。
- 引擎包 25 个 PG 测试文件全部不搬运（D9）；其不变量断言清单（Σ腿=0、链恒等、in_flight 投影、账本不可变、冻结拒动）在 U1b 契约测试中逐项重现。

## 2. 审计结论引用

- B1（IMPLEMENTATION §1.2）：credit-line 幂等竞态兜底跳过指纹校验——U1b 修复，回归用例：并发同键异额，输家必须吃 `billing.idempotency_conflict` 而非拿自己的输入当回执。
- B5（同）：authorize 重放金额必须 normalizeAmount（旧仓活路径待对照）——U1b 以测试锁死：同一命令首调与重放的 amount 字符串全等。
- B7（同）：transfer 内部科目出账错误不得携带误导用户号——错误 context 用 code/币种，不带 `user 0`。
- D3/D4/D5（§1.4）：定律唯一住 domain（U1a 已落）；错误家谱进目录（U1a 已扩容 7 键）。

## 3. 逐模块裁决表

### U1a（已核销：domain 定律）

| 文件                                 | 裁决                | 审计状态                      | 动作                                                                                                                                                                       |
| ------------------------------------ | ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/src/wallet/posting.ts`       | 复制+微修           | 定律与引擎/服务三处同文（D3） | `validatePosting`/`legBalanceAfter`/`isAuditKind`/PostingSpec 原语义；`WalletInvariantError` → `DefectError`（码 `billing.wallet_invariant`——红灯不是业务拒绝）            |
| `domain/src/wallet/account.ts`       | 重构迁入（D4 收敛） | 与引擎 exposure.ts 逐行同     | 拆两文件：`accounts.ts`（OUTSIDE/REVENUE 常量 + AccountRef/AccountSnapshot）+ `exposure.ts`（availableToSpend/assertCanDebit/assertCreditLimitCoversExposure）；错误进目录 |
| `domain/src/wallet/authorization.ts` | 复制+微修           | 状态机与引擎一致              | assertSettleable/assertReleasable 原语义；错误进目录（authorization_not_active/settle_exceeds_hold）                                                                       |
| `domain/src/wallet/guards.ts`        | 复制+微修           | fail-closed 白名单            | 三断言 + assertRefId 原语义；`InvalidRefError(code)` → 目录 `invalid_ref`（reason 入 context）                                                                             |
| `domain/src/wallet/errors.ts`        | 不移植（D5）        | 12 类错误家谱                 | 收敛进 `billing` 目录（U1a 落 7 键；account_frozen/ref_key_conflict/idempotency_conflict/authorization_not_found 随 U1b 抛出点落地）；`WalletInvariantError` → DefectError |

### U1b（待续：application + adapters + PG 测试）

| 旧文件                                                                                                                                                                | 裁决               | 动作                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service/src/wallet/wallet.ts` + `env.ts`                                                                                                                             | 重写               | `application/wallet/wallet.ts`：createWallet 应用装配（guards/db 注入；TxInjection 收编为内部编排）                                                   |
| `service/src/wallet/credit.ts`/`refund.ts`/`authorize.ts`/`settle.ts`/`release.ts`/`transfer.ts`/`credit-line.ts`/`posting.ts`/`replay.ts`/`ref-key.ts`/`currency.ts` | 重写（动词一文件） | `application/wallet/*.ts`：幂等三段式 + 指纹 + 领域守卫编排；修 B1/B5/B7；`#over` 补扣语义（collectOverage，billing refType 域耦合）从 authorize 带入 |
| `service/src/wallet/{accounts,statement}.ts`                                                                                                                          | 重写               | 读侧动词（无户不建户、游标分页 newest-first）                                                                                                         |
| `repository/src/wallet.repo.ts`                                                                                                                                       | 重写               | `adapters/postgres/wallet-store.ts`：行锁 FOR UPDATE（id 定序）、CAS、唯一冲突探测、腿链读改写；shard 恒 0（B9 注释固化）                             |
| `service/__tests__/wallet*.test.ts` ×4                                                                                                                                | 改写迁移           | `__test__/wallet-contract.test.ts` 等（打真实 PG；含 B1/B5 回归与引擎不变量清单重现）                                                                 |

## 4. API 对照（U1b 落地时补全动词签名）

| 旧签名                                           | 新签名                                                   | 变化理由                                     |
| ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| `createWallet(env: WalletEnv)`（service）        | `wallet()` 子 facade（createBilling 内部装配）           | 单一 facade 装配（DESIGN §2.1）；DbTx 不外泄 |
| `InvalidAmountError`/`WalletError` 族 instanceof | `isBusinessError(e) && e.code === BillingErrors.code(…)` | D5/B6：捕获按码不按类                        |
| （新增）                                         | replayed 回执金额恒 normalizeAmount                      | B5 锁死                                      |

## 5. 测试迁移矩阵

| 旧测试                                                         | 新去处                                                   | 动作                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `domain/wallet/__tests__/posting.test.ts`（定律+敞口 11 用例） | `__test__/posting.test.ts` + `__test__/exposure.test.ts` | 已迁移（U1a）：断言换目录码；新增 freeze 回执、等额边界、isAuditKind 封闭性 |
| （无旧直测）                                                   | `__test__/authorization.test.ts`                         | 新增：状态机分岔直测（U1b CAS 依赖）                                        |
| （无旧直测）                                                   | `__test__/guards.test.ts`                                | 新增：fail-closed 表驱动矩阵                                                |
| （无旧直测）                                                   | `__test__/error-catalog.test.ts`                         | 新增：词表封闭性快照（§10.1）                                               |
| `service/__tests__/wallet*.test.ts` ×4                         | `__test__/wallet-*.test.ts`                              | U1b：改写迁移（真实 PG；B1/B5 回归；引擎不变量清单重现）                    |

## 6. 回滚方案

U1a 单提交可 revert（纯新增 domain，零调用方）。U1b 每 verb 族独立提交可 revert；
DDL 零变更（wallet 四表已在新仓 db 链），revert 不需要数据回滚。

## 7. 验收（已核销 2026-08-23）

- U1a：四门全绿 + 覆盖率 96.47/95.65/100/96.92（56 用例）。
- U1b：四门全绿；默认门禁 81 用例、覆盖率 95.12/86.57/98.46/97.66（adapters 由真 PG 门覆盖，
  分母按 accounts 包同约定排除）；真实 PG（test:real）13 用例全绿。
- 回归：B1（真并发同键异额 409 + 顺序 409）、B5（authorize/refund 重放金额形态全等）、
  B11（定序锁显式化 + 对向死锁竞速）、B12（refund 重放正号回执）、B13（冻结账户可释放预占）。
- 引擎不变量清单逐项核销：Σ腿=0 / 链恒等 / in_flight 投影 / 账本 append-only /
  冻结拒动（settle 拒、release 容忍）——真 PG 对账 SQL 断言（`assertLedgerCoherent`）。
- B5 结论回写：活路径 authorize 重放**已经** normalizeAmount（引擎侧缺陷不波及）；
  同型问题在 refund 重放存在（B12），已修。

## 4 补遗：U1b 实施中的语义修正

| 偏离旧活路径的点                                               | 理由                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `lockAccounts` 显式 `ORDER BY id`（B11）                       | 旧实现的「定序锁」依赖索引扫描顺序的实现细节；显式化后才成为可依赖的不变量                 |
| `joinTransaction` = SAVEPOINT + 瞬态重试（旧为裸加入外层事务） | 旧路径注入事务内撞 23505 会毒化外层事务（ doomed tx），SAVEPOINT 隔离修复                  |
| `replayLegged` 回执取命令金额（B12）                           | 旧版回读带符号腿金额，refund 重放与首笔回执不同形                                          |
| release 容忍冻结账户（B13）                                    | 旧活路径在风控冻结后无法归还 in_flight（永久占用）；引擎语义（释放预占不动资金）为正确基准 |
| credit-line 重放取存储回执 `creditLimitAfter`（而非输入）      | B1 修复的稳定回执原则：重放返回首笔事实，不返回本次输入                                    |
| freeze 动词不移植                                              | 旧仓活路径无 freeze 用例（生产无调用方，状态由管理面直置）；归属 admin 迁移单元裁决        |
