# @tokenlens/accounts 施工图(IMPLEMENTATION.md)

> 状态:已完成(2026-08-23;实施记录见 §7)
> 前置:DESIGN.md(定稿)、三份老仓审计(2026-08-23,证据均带 文件:行号)
> 纪律:AGENT.md §9.1(七步流程);复制的前提是逐文件审计无可挑剔;实现推翻设计时先改文档。

---

## 1. 审计结论(老仓 ai-getway,只读审计 2026-08-23)

### 1.1 真 bug(B#,本单元处置)

| # | 症状 | 位置 | 处置 |
|---|---|---|---|
| B1 | 幻影配额闸:`countActiveByUser`/`advisoryLockKeyQuota`/`advisoryLockAppQuota` 及注释宣称的 Key/App 数量上限在 service 层无接线(死代码+文档撒谎) | api-key.repo.ts:120,324 / apps.repo.ts:137-151 / keys.service.ts / apps.service.ts | **不移植**(删除);MAX_KEYS/MAX_APPS_PER_USER 已在 v1 显式废弃 |
| B2 | 鉴权缓存残迹三件套:`listKeyHashesByUser` 零调用、`adminPatchKey` 返回 keyHash 后接空 `if(deps.redis){}`、admin users 清缓存空块——指向已废弃的网关缓存设计;现网关每请求直查 | user.repo.ts / api-key.repo.ts:301-320 / admin keys.service.ts:72-74 | **不移植**;adminPatchKey 投影不再返回 keyHash |
| B3 | `listRelations.commission_total` 把 `referral-signup:*`(注册奖励)算进累计佣金,与 C 端 `totalCommission`(只计 `referral-commission:`)口径不一致 | marketing.repo.ts:47-106 | 口径修正为**只计佣金前缀**;但资金聚合整体不迁(G3),accounts 关系列表不含金额列 |
| B4 | users 表时钟源混用:`patchUser` 用 JS `new Date()`,user-account/org 用 `clock_timestamp()` | user.repo.ts vs user-account.repo.ts | 修复:存储时钟统一(DESIGN §5) |
| B5 | `patchMember` 不过滤 status=0,owner 可给已离开成员设限额 | org.repo.ts | 修复:仅 active 成员可设限(`member_not_found`) |
| B6 | `findAdminUser` 投影含 identityProvider 但返回类型未声明 | user.repo.ts | 修复:投影类型对齐 |
| B7 | `updateSettings` upsert 后回读两次往返非原子 | marketing.repo.ts | 修复:`onConflictDoUpdate ... returning` 单语句 |
| B8 | `org_invitations.status=3(expired)` 无任何写入方(纯惰性过期) | org-invitations.ts:28 | 裁决:保留惰性过期,DDL 不动;词表注释标注 3 不可写 |
| B9 | 零调用死代码:`findDailySpendLimit`/`listKeyHashesByUser`/`findIdsBySubjects` | user.repo.ts | 不移植 |
| B10 | 用户面密码策略 10..128 ≠ 管理面重置 8..128 | auth.service.ts:41 / admin users.ts:53 | 不在本单元(密码不迁);挂 MIGRATION 待办给 identity |
| B11 | set-password 隐藏副作用:重置密码同时绑默认卡「标准」+回填系数 | admin users.service.ts:27,228-243 | 不在本单元(credential+费率交界);挂待办 |
| B12 | `listByUser` rows/count 串行两查(其余 repo 并行) | api-key.repo.ts | 修复:`Promise.all` |

### 1.2 重复提取(D#)

| # | 内容 | 处置 |
|---|---|---|
| D1 | `resolveParam(string|fn)` 营销参数解析三处逐字拷贝(auth/oauth/referral.service) | 收敛为 marketing settings 单一读取函数(本包内单点) |
| D2 | `escapeLikePattern`/排序白名单/分页钳制跨 repo 重复 | postgres 适配器内单点 helper |
| D3 | 密钥生成器与格式常量散落 http/secrets(v1 从 core 迁来即如此) | api-key/app 生成器**随消费者带走**迁入 `accounts/domain/credentials.ts`,http 同一变更删除(secrets.ts C5 注释即此预案);RC- 兑换码留待 billing 波次 |

### 1.3 契约缺口/演进(G#)

| # | 缺口 | 裁决 |
|---|---|---|
| G1 | 组织列表/详情的订阅富化(planName/quantity/remainingAmount)读 billing 表 | accounts 只出组织事实;富化由 app 组合(P5 恢复可观察行为) |
| G2 | referralOverview.totalCommission 读 wallet 聚合 | 同上,app 组合 |
| G3 | 返利流水投影(payouts,raw SQL 读 wallet 三表)与佣金日结聚合(读 usage_logs) | 归 billing 波次;accounts 提供 settings 与关系状态读模型 |
| G4 | 注册编排(挑战/验证码/会话/防枚举)与 login 链路 | identity 波次;经其自有 port 桥接本包 provision |
| G5 | users.password_hash 写入方 | identity 波次(§3.4 双写审计);本包建号不触碰该列 |
| G6 | 续费换绑(rebindCredentials)调用方 | 本包实现 `rebindSubscription`;billing 订阅续费用例经装配调用 |
| G7 | 组织创建在订阅购买事务内(ensureOrg) | 本包提供 `createOrg`(单事务 org+owner);购买编排归 billing,原子性经事务参与桥接(billing 波次定形态) |
| G8 | 席位不变量依赖 user_subscriptions(billing 拥有) | accounts 适配器只读最小投影并 FOR UPDATE 同锁串行化,交界注释双向声明 |

### 1.4 v1 已验证的行为规格(测试迁移的判定标准)

老仓账号行为全部由 app 层测试锁定(repository/domain 层零账号单测,结构性缺口):
client-api orgs/keys/apps/referrals/auth/app/frontend-contract、admin-api users/keys/marketing、
gateway oauth-appjwt/e2e-cross-app、worker referral。逐条清单见 MIGRATION.md §1。

---

## 2. 逐模块裁决表(老仓 → 新仓)

| 老仓模块 | 行数 | 裁决 | 依据 | 新去处 |
|---|---|---|---|---|
| user-account.repo.ts(建号/资料写侧) | 147 | 重构 | 规则散在 repo+service;password 列不迁(G5) | application/provision-*.ts、update-display-name.ts + store |
| user.repo.ts(读模型+管理 patch) | 277 | 重构 | B2/B4/B6/B9;钱包富化拆出(G1) | application/get-profile、admin-*.ts、reads.ts |
| org.repo.ts(组织/成员/邀请) | 369 | 重构 | 保持全部 CAS/FOR UPDATE/复活语义;订阅富化拆出 | application/orgs/邀请族 + store |
| org-member.repo.ts(memberLimits) | 27 | 合并 | 同表双读模型 | store.memberLimits |
| api-key.repo.ts | 327 | 重构 | B1/B2/B12;管理面收窄 | application/*-key.ts + store |
| apps.repo.ts | 152 | 重构 | B1;生成器迁 domain | application/*-app*.ts + domain/credentials |
| referral.repo.ts | 80 | 重构 | 佣金聚合不迁(G3);幂等键收敛 domain | application/apply-referral、referral-overview + domain/referral |
| marketing.repo.ts | 155 | 重构 | B3/B7;raw SQL 去 wallet 化(G3) | application/marketing 族 + store |
| credential.repo.ts(findActiveKeyByKeyHash/findActiveAppById/rebind) | — | 重构 | 鉴权读模型归账号事实所有者 | application/resolve-key-by-hash、resolve-app、verify-app-client、rebind-subscription |
| client-api auth/org/keys/apps/referral/marketing.service 的规则部分 | — | 重构下沉 | 硬编码规则清单(审计 §7.1/7.2)全部进 domain/application 或 policy | 对应用例 |
| http/secrets.ts(generateApiKey/ClientId/ClientSecret/maskKey/sha256Hex) | 82 | 迁移+删除 | D3/C5:随消费者带走 | accounts/domain/credentials.ts;http 同变更删除导出与用例 |
| v1 各 zod 路由校验 | — | 改写 | 表驱动进 domain 限额域;wire schema 归 app contracts(P5) | domain/limits 等 |

---

## 3. 目录与拆分

```text
packages/accounts/
├── DESIGN.md / IMPLEMENTATION.md / MIGRATION.md
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── domain/           # 纯函数:user org invitation limits credentials api-key app referral marketing errors
│   ├── application/      # 一动词一文件(DESIGN §1.1 清单)
│   ├── ports/            # account-store wallet-credit audit
│   ├── adapters/postgres/# account-store(全量 SQL,D2 helper 单点)+ audit-sink
│   ├── testing/          # in-memory-account-store + wallet/audit 替身(包内测试用,不入 exports)
│   ├── accounts.ts       # createAccounts facade
│   └── index.ts          # 仅 facade + 目录 + 类型 + policy 形状
└── __test__/             # 平铺(铁律 14);postgres-store.real.test.ts 按 DB_TEST_URL skip
```

## 4. 测试计划(先于实现定稿)

| 层 | 文件 | 锚点 |
|---|---|---|
| domain | domain-user/limits/credentials/referral/marketing/org(errors 词表快照) | 边界矩阵:金额科学计数法/22 位/NaN/超上界;aff 往返与畸形;refId 词表;key/app 材料形状与熵 |
| application | provision/profile/admin-users/keys/admin-keys/resolve-key/apps/orgs(邀请全矩阵+席位)/referral(归因+回滚)/overview/marketing/facade | v1 行为规格逐条(MIGRATION §1);B3/B5/B7 回归;越权=not_found;明文/哈希零泄漏(正则排查) |
| postgres(real 门) | postgres-store.real.test.ts | 唯一冲突翻译、CAS 竞态(并发 accept 单赢家、并发归因单赢家)、FOR UPDATE 席位串行化、复活语义、时钟写、like 转义、rebind |
| 覆盖率 | vitest thresholds 90/85 | 分母=src 除 index.ts 与 adapters/**(理由:adapters 仅可经真实 PG 语义验证,由 real 门覆盖;阈值不变) |

## 5. 实施顺序(每步四门全绿,独立提交)

1. docs:三份文档定稿(本提交)。
2. feat(accounts):domain + ports + testing 替身 + 单测。
3. feat(accounts):application + facade + adapters/postgres + 单测 + real 门。
4. refactor(http):密钥生成器随消费者迁走(D3),http 出口与用例同步收缩。

## 6. 行为对照清单(验收用,逐项核销于 MIGRATION §3)

见 MIGRATION.md;验收 = 四门 + real 门 + 对照清单全核销。

## 7. 实施记录(2026-08-23 收口)

1. **四门 + real 门**:typecheck/lint/build 绿;单测 208 绿(13 文件),覆盖率
   95.45/89.34/97.03/97.63(阈值 90/85/90/90);real 门 11/11(独立库
   `tokenlens_accounts_test`,`DB_TEST_URL` 约定)。
2. **实现期裁决补充**:
   - v1 client-api **不写任何审计**(grep 证实,审计报告初稿有误)——MIGRATION §1.6.4
     已按事实修正:audit_logs 仅管理面动作(user.update / api_key.update /
     marketing.settings.update / referral.relation.update),AuditPort 只承载这四个动词。
   - decimal.js `isPositive()` 对 0 返回 true(零为正号)——限额/赠送判定一律显式
     `greaterThan(0)`,由 domain 测试矩阵锁定。
   - real 门建库:drizzle 迁移链无法从空库装配(0055/0056/0058 等引用 identity-core/
     wallet/ledger provision 链的外部表),`drizzle-kit push` 亦在 ledger_operations
     的 FK 上失败——两处证据留档给 P3「空库升级」;账号域 DDL fixture 先行
     (与 db schema 同拍维护,退役条件已在 MIGRATION §4 挂待办)。
   - bun.lock 本次由并行会话混入 billing/control-plane/inference 条目——按铁律 15
     不随本单元提交,留待对方收口后统一入库。
3. **错误码增补**(DESIGN §4 同步):member_limits_invalid / relation_status_invalid /
   app_patch_invalid(实施中发现的语义缺口,均有对应测试)。
