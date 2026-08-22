# @tokenlens/accounts 设计基线(DESIGN.md)

> 状态:定稿(实施中)
> 迁移单元:P4 第 4 波「上层消费者:用户/组织/API Key/Application → accounts」(总纲 §9 P4.4)
> 旧实现:/Users/wrr/work/ai-getway 的 repository(user/user-account/org/org-member/api-key/apps/referral/marketing)+ client-api/admin-api/gateway 路由层内嵌规则
> 关联:IMPLEMENTATION.md(审计/裁决/施工)、MIGRATION.md(行为规格基线)、AGENT.md、docs/project-structure-refactoring.md §3.4/§5.2

---

## 1. 问题域:处理什么、不处理什么

accounts 是**账号事实的唯一所有者**:用户资料行、组织/成员/邀请、API Key 生命周期、
Application 凭证、推荐关系与拉新参数。它只保存资料与账户关系,**不保存认证秘密**
(总纲 §3.4)。

### 1.1 处理(垂直用例清单)

| 组 | 用例(facade 动词) |
|---|---|
| 建号 | `provisionLocalAccount` / `provisionOAuthAccount`(find-or-create)/ `completeAccountOnboarding`(开户赠送+归因,尽力而为) |
| 资料 | `getProfile` / `updateDisplayName` |
| 管理面用户 | `adminListUsers` / `adminGetUser` / `adminPatchUser` |
| 凭证读模型 | `resolveKeyByHash`(网关鉴权)/ `resolveAppByAppId` / `verifyAppClient`(oauth token)/ `rebindSubscription`(续费换绑) |
| 跨能力探针 | `userExists` / `userIsEnterprise` / `userRateCardBinding` / `memberLimits`(供 billing/gateway 消费,只读) |
| API Key | `createKey` / `listKeys` / `patchKey` / `rotateKey` / `revokeKey` / `adminListKeys` / `adminPatchKey` |
| Application | `createApp` / `listApps` / `disableApp` / `rotateAppSecret` |
| 组织 | `createOrg` / `listMyOrgs` / `getOrgDetail` |
| 邀请与成员 | `inviteMember` / `revokeInvitation` / `acceptInvitation` / `setMemberLimits` / `removeMember` |
| 推荐 | `grantSignupGift` / `applyReferral` / `referralOverview` |
| 拉新参数 | `getMarketingSettings` / `updateMarketingSettings` / `listReferralRelations` / `setReferralRelationStatus` |

### 1.2 不处理(显式归属)

| 不处理 | 归属 | 交界形态 |
|---|---|---|
| 密码哈希/验证码挑战/会话 JWT/登录防枚举/改密与重置 | identity | identity 波次编排;accounts 建号用例**不收 passwordHash**(G5,users.password_hash 列写入方待 identity 波次裁决) |
| 钱包入账/余额/流水/佣金结算(worker 日结) | billing | 经 `WalletCreditPort`(本包定义 port,装配桥接 billing);结算任务读 `getMarketingSettings` + 关系状态后由 billing 侧聚合 usage(G3) |
| 管理员资料/角色/control-plane 授权 | control-plane | admin-account 不迁 |
| 费率卡内容/目录快照 | billing(control-plane 配置) | `users.rate_card_id` 绑定关系归 accounts,卡行存在/停用守卫经 store 只读探针 |
| 组织订阅富化(planName/quantity/remaining)、佣金总额(totalCommission)、返利流水投影(payouts) | app 组合(G1/G2/G3) | accounts 只出组织/关系事实;数字由 app 在 route 层组合 billing facade |
| wire schema/HTTP 状态码 | 各 app contracts | 错误只到 category;403/404/409/410 的最终映射归 app face |
| 审计存储/查询/保留 | observability | action/payload 语义归本包,经 `AuditPort` 同事务写 audit_logs(§5.4) |

### 1.3 防环承诺(总纲 §5.2)

- 不回查 billing 内部对象:钱包、订阅行只按标识与最小投影读(`findUsableSubscription`、
  `lockActiveOrgSubscription` 返回 `{id, quantity}`,不取金额/计划)。
- `identity` port 本单元不建:当前全部用例不需要身份包协作;identity 波次若需建号,
  经 identity 自己的 port 桥接本包 facade(消费方定义 port)。
- 接收 `userId/orgId/keyId` 等标识,不泄漏 `Db/DbTx` 到 facade 签名(§5.4)。

---

## 2. 外部契约

### 2.1 形态原则(与 ai/errors 包一致)

- 参数平铺不嵌套;可选参数全部有缺省或可空语义;
- 结果为数据(判别字段区分);**敏感值单向**:明文 Key/Secret 只出现在创建/轮换返回值,
  任何列表/详情/管理投影**结构上不含** `keyHash/passwordHash/clientSecretHash`(投影类型即证据);
- 越权与不存在统一 `not_found`(不泄漏资源存在性,老仓语义);
- 破坏性/状态翻转一律 CAS(单语句 `update ... where status=...`),0 行 → 判别错误。

### 2.2 facade

```ts
createAccounts({
  db, walletCredit, policy, txRetry, now,   // 必填
  store?, auditSink?,                        // 测试缝;省略时内部装配 postgres 适配器
}) → AccountsApi(冻结对象,全部动词只读)
```

`AccountsPolicy`(全部可变阈值必填注入,铁律 3;装配缺省值归 app config):

```ts
{
  keyPrefix,                 // Key 前缀,^[a-z][a-z0-9_-]{1,15}$;生成端与网关分派端同一 env
  invitationTtlMs,           // 邀请有效期(v1 等价 7 天)
  invitationPendingFactor,   // 待接受上限 = min(max(剩余席位,1) × factor, cap)(v1 等价 2)
  invitationPendingCap,      // 上限绝对封顶(v1 等价 20)
  amountLimitUpper,          // 金额类上限的十进制字符串上界(v1 等价 '1000000000000')
  rpmLimitMax, tpmLimitMax,  // 频率限额上界(v1 等价 1e6 / 1e8)
  scopeModelsMax,            // App scope.models 条数上界(v1 等价 100)
  referralInviteeLimit,      // 概览被邀名单长度(v1 等价 100)
  listPage: { page, limit, maxLimit }, // 列表缺省与上界(v1 等价 1 / 20 / 100)
  banDefaultReason,          // 封禁缺省原因(v1 等价「管理员封禁」)
}
```

字段宽度(displayName 64、email 255 等)是 DDL varchar 的契约镜像,以 db schema 为物理
真相,作为 domain 常量随迁移同拍变更,不作装配旋钮。

### 2.3 错误目录

`AccountsErrors = defineErrorCatalog('accounts', {...})`(§4 清单)。码表封闭性由测试
快照锁定;status 映射归 app face(`invitation_expired` 在 v1 是 410,face 按码覆盖)。

---

## 3. 领域模型与不变量

| 聚合 | 不变量(必须由测试锁定) |
|---|---|
| user | 本地账号 issuer='local'、subject=规范化 email(trim+lowercase);(issuer,subject) 唯一;本地 email 唯一(部分索引);status ∈{0,1,2};email 变更 = 身份事实变更,同语句推进 sessionInvalidBefore |
| org/member | owner 也是成员(占 1 席);active 成员数 ≤ 订阅 quantity(接受事务内 FOR UPDATE 串行化复检);成员可属多组织;owner 不可被移除;被移除成员经新邀请复活(同 (org,user) 行 status 1→0) |
| invitation | token 32hex 唯一、只在创建响应下发一次;状态机 pending(0)→accepted(1)/revoked(2),翻转原子(CAS + 未过期谓词);过期为**惰性判定**(expires_at 谓词,status=3 不写入,B8 裁决);接受者 email 须与邀请 email 一致 |
| api-key | 明文不落库;keyHash = SHA-256(明文) 唯一;吊销 CAS 0→1 不可逆(属主面);轮换 = 同事务「新行(继承设置)+旧行吊销」;订阅失格轮换降级个人余额(null);过期/expiresAt 仅未来可写 |
| app | appId 32hex 唯一、clientId 唯一;clientSecretHash = SHA-256,明文仅一次;禁用 CAS 0→1 不可逆;轮换 FOR UPDATE 行锁防并发孤儿化 |
| referral | 一人只能被邀一次(invitee 唯一索引);inviter≠invitee;归因单事务:关系 + 双方奖励同生共死;作弊封禁(1)停奖不停历史 |
| marketing | 单行表(id=1 CHECK);金额非负、比例 ∈[0,1];「下一动作生效、历史不重算」 |

幂等键单一真相(domain 构造器,修复 v1 前缀两处各写一份的漂移面):
`signup:{userId}`、`referral-signup:{inviteeId}:{inviter|invitee}`、
`referral-commission:{inviterId}:{yyyyMMdd}`(UTC)。

---

## 4. 错误目录(封闭词表)

| code | category | 语义(v1 出处) |
|---|---|---|
| user_not_found | not_found | 资料/管理单查无行(401/404 归 face) |
| email_taken | conflict | 本地邮箱已占用(23505 语义化) |
| email_invalid | invalid_input | email 形状/长度不合法 |
| display_name_invalid | invalid_input | displayName 空/超长 |
| user_patch_invalid | invalid_input | patch 组合非法(freezeReason 不随封禁等) |
| rate_card_not_found | not_found | 换卡目标不存在 |
| rate_card_disabled | conflict | 换卡目标已停用 |
| key_not_found | not_found | 属主单查无行(含越权,不泄漏存在性) |
| key_already_revoked | conflict | 已吊销 Key 的 patch/rotate/revoke |
| key_patch_invalid | invalid_input | Key 字段域违规 |
| subscription_not_usable | not_found | 订阅不存在/非本人/非所属组织(不泄漏) |
| app_not_found | not_found | 属主 App 无行 |
| app_already_disabled | conflict | 重复禁用/轮换已禁用 |
| app_patch_invalid | invalid_input | App 名称/描述域违规 |
| app_scope_invalid | invalid_input | scope 形状/上界违规 |
| org_not_found | not_found | 非成员访问组织 |
| org_forbidden | forbidden | 非 owner 操作 owner 专属动词 |
| org_no_subscription | conflict | 组织无有效订阅 |
| seats_full | conflict | active 成员数 ≥ quantity |
| invitations_full | conflict | 待接受邀请达上限 |
| invitation_invalid | not_found | token 无效/竞态翻转失败 |
| invitation_revoked | conflict | 已撤销 |
| invitation_already_accepted | conflict | 已接受 |
| invitation_expired | conflict | 已过期(face 覆盖 410) |
| invitation_email_mismatch | forbidden | 接受者 email 不匹配 |
| org_cannot_remove_owner | conflict | owner 不可移除 |
| member_not_found | not_found | 成员无行/已离开 |
| member_limits_invalid | invalid_input | 成员限额域违规 |
| relation_status_invalid | invalid_input | 推荐关系状态非法 |
| referral_invalid_code | invalid_input | aff 码畸形 |
| referral_self_invite | conflict | 自邀 |
| referral_inviter_not_found | not_found | 邀请人不存在或封禁(防枚举) |
| referral_already_referred | conflict | 已被归因 |
| marketing_settings_invalid | invalid_input | 参数域违规 |
| relation_not_found | not_found | 推荐关系无行 |
| org_name_invalid | invalid_input | 组织名空/超长 |

---

## 5. 事务、并发与时间语义

- **事务边界归发起用例**:application 内 `runTx`(重试策略必填注入);store/wallet/audit
  均接收同一 `DbLike` 句柄参与事务(§5.4 事务参与 port 形态)。
- **时间单一来源 = 存储时钟**:全部状态翻转/落库时间(revokedAt/rotatedAt/expiresAt/
  updatedAt/过期判定)由 postgres 适配器用 `clock_timestamp()` 表达;`now`(JS 时钟)
  仅用于创建前的输入预检(expiresAt 未来性),文档明示双界。
  (修复 v1 users 表 JS 时钟与 DB 时钟混用,B4/B6。)
- **CAS 单语句**:吊销/禁用/翻转/移除全部 `update ... where status = 期望值`,0 行判别;
  唯一索引是并发的最终兜底(23505 语义化为 email_taken/already_referred)。
- **席位串行化**:accept 事务内 `select ... for update` 锁组织 active 订阅行,再复检
  active 成员数——与 billing 侧数量变更(同锁)互斥。
- **明文单向**:Key/AppSecret 明文只在内存与返回值;投影类型结构性排除哈希列。
- **无鉴权缓存承诺**:resolveKeyByHash 每调用直查(v1 语义);吊销/限额修改即时生效。

---

## 6. 装配与测试策略

- 依赖白名单:`@tokenlens/errors`、`@tokenlens/db`(adapter SQL 与事务件)、`decimal.js`
  (domain 金额)、`node:crypto`/`node:assert` 内建。**零依赖 http/runtime**(密钥生成器
  随消费者迁入本包 domain/credentials,C5/D3)。
- 端口:`AccountStorePort`(持久化)、`WalletCreditPort`(入账,装配桥接 billing)、
  `AuditPort`(审计,同事务落 audit_logs)。纯只读探针并入 store port,不另设仪式化接口。
- 测试四层(§5.6):domain 纯函数直测;application 用内存 store 替身锁行为规格
  (v1 测试矩阵,见 MIGRATION.md);postgres 适配器以真实 PG 集成测试锁定
  (CAS/FOR UPDATE/唯一冲突/复活语义,`*.real.test.ts` 按 DB_TEST_URL skip);
  facade 装配缝测试(store 注入替身)。
- 覆盖率门禁:domain/application/ports/accounts.ts 计入 90/85;adapters 由 real 门
  单独覆盖(默认门禁分母排除,理由与阈值不变性见 IMPLEMENTATION.md §5)。
