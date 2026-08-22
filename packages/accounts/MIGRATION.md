# 账号能力迁移文档(MIGRATION.md)

> 状态:实施中
> 迁移单元:账号事实(用户资料/组织/成员邀请/API Key/Application/推荐/拉新参数)
> 旧实现:/Users/wrr/work/ai-getway —— repository 8 文件约 1.6k 行 + client-api/admin-api/gateway 路由层规则;行为由 18 个 app 层测试文件锁定(repository/domain 层零账号单测)
> 目标位置:packages/accounts
> 关联:DESIGN.md / IMPLEMENTATION.md / 总纲 §3.4、§5.2、§9 P4.4

---

## 1. 行为规格基线(老仓测试 → 必须保留的可观察行为)

### 1.1 用户与资料
1. 本地建号:issuer='local'、subject=规范化 email;displayName 兜底 email 前缀截 64;并发撞邮箱→`email_taken`(大小写归一)。
2. OAuth find-or-create:同 (issuer,subject) 二次不重复建号;displayName 兜底「用户{subject 前 6}」截 64;status≠0 由调用方拒绝(防枚举归 identity)。
3. getProfile:含费率卡名/限流列;无行→`user_not_found`。
4. updateDisplayName:trim 后 1..64;审计 `me.display_name_change`。
5. 管理列表:q 模糊命中 subject/email/displayName(ilike 转义);status/enterprise 过滤;排序白名单 + desc(id) 稳定序;分页钳制。
6. 管理补丁:freezeReason 只能随封禁;封禁缺省原因注入;解封清原因;email 变更同语句推进会话失效线;换卡守卫(不存在/停用两分);0 行→`user_not_found`;审计 `user.update`(全量 patch)。
7. 密码哈希任何响应形状零出现(多格式正则排查)。

### 1.2 组织/成员/邀请
1. createOrg:org + owner 成员行同事务;owner 占 1 席。
2. listMyOrgs:active 成员资格;仅组织事实(G1 富化拆出)。
3. getOrgDetail:非 active 成员→`org_not_found`;成员列表全员可见;待接受邀请仅 owner 可见且**永不回 token**。
4. invite:owner-only(`org_forbidden`);组织须有 active 订阅(`org_no_subscription`);席位满→`seats_full`;待接受上限 `min(max(剩余,1)×factor, cap)`→`invitations_full`;token 32hex 一次下发;TTL 注入(v1 等价 7 天);审计 `org.invite`。
5. revoke:owner-only;CAS 0→2;0 行→`invitation_not_found`(并入 `invitation_invalid` 族,见 §2 对照)。
6. accept:错误矩阵 `invitation_invalid`(404)/`invitation_revoked`/`invitation_already_accepted`/`invitation_expired`(410 归 face);email 不一致→`invitation_email_mismatch`;事务:FOR UPDATE 锁订阅→复检席位→insertOrRevive(被移除成员复活)→CAS 翻转(0 行回滚);审计 `org.invite_accept`。
7. setMemberLimits:owner-only;金额域校验;仅 active 成员(B5 回归);0 行→`member_not_found`。
8. removeMember:owner-only;owner 自身→`org_cannot_remove_owner`;CAS 0→1;审计 `org.member_remove`。
9. 订阅绑定守卫(findUsableSubscription):本人或所属组织 active 成员可绑;否则 `subscription_not_usable`(不泄漏存在性);被移除后既有绑定不删、仅新建被拒。

### 1.3 API Key
1. 明文 `{prefix}{40hex}`(160 bit);仅创建/轮换返回一次;SHA-256 落库与网关 resolve 同口径;preview `前3+****+末4`。
2. 列表/详情/管理投影结构上无 keyHash。
3. 吊销 CAS 0→1 + revokedAt(存储时钟);重复吊销/吊销后 patch/rotate→`key_already_revoked`;越权=not_found。
4. 轮换:同事务新行(继承 name/remark/rpm/tpm/dailySpendLimit/expiresAt 原样)+旧行吊销;订阅失格→新行 subscriptionId=null;审计 `key.rotate`。
5. 创建:限额域(十进制串、正、< 上界注入;rpm/tpm 正整数 ≤ 上界;expiresAt 未来);订阅守卫同 1.2.9;审计 `key.create`;吊销审计 `key.revoke`。
6. 管理面:q 命中 name/preview/userEmail/userDisplayName;status 翻转仅 {0,1};非法枚举拒绝;审计 `api_key.update`(v1 码 `api_key.update_limit` 归一)。

### 1.4 Application
1. appId 32hex、clientId `app_`+16hex、secret 48hex;secret 明文仅一次;哈希 SHA-256。
2. 订阅守卫同口径;scope.models 条数/长度上界、rpm/tpm 上界。
3. disable CAS 0→1 不可逆;重复→`app_already_disabled`;越权=not_found;审计 `app.disable`。
4. rotateSecret:FOR UPDATE 行锁;新明文一次;审计 `app.rotate_secret`。
5. 鉴权读模型:resolveAppByAppId(app status=0 + 属主 status=0);verifyAppClient(client_id+secretHash 双等值 + 双 status 守卫)。

### 1.5 推荐与拉新参数
1. aff 码 `u{base36(userId)}` 往返;畸形(空/无前缀/u0/非数字/超长)拒绝。
2. applyReferral:矩阵 `referral_invalid_code`/`referral_self_invite`/`referral_inviter_not_found`(含封禁,防枚举)/`referral_already_referred`(唯一索引兜底);bonus=0 建关系零入账;单事务「关系+双方奖励」同生共死(注入坏 wallet 验证回滚)。
3. grantSignupGift:`signup:{userId}` 自然键幂等;0=关闭不调用;失败不回滚建号(调用方语义,completeAccountOnboarding 吞错记结果)。
4. overview:enabled=bonus>0‖rate>0;affCode/inviteUrl(基址注入)/被邀名单(limit 注入);totalCommission 拆出(G2)。
5. settings:单行表;金额非负、比例∈[0,1]、精度(整数 ≤10 位、小数 ≤18 位);「下一动作生效、历史不重算」;审计 `marketing.settings.update`;upsert 单往返(B7)。
6. 关系管理:列表(双方账号投影+状态,无佣金列,B3/G3);封禁/恢复 0|1;0 行→`relation_not_found`;审计 `referral.relation.update`。
7. 佣金幂等键 `referral-commission:{inviterId}:{yyyyMMdd(UTC)}` 词表归本包 domain,worker/billing 复用。

### 1.6 横切
1. 越权与不存在统一 not_found;错误信封归 app。
2. 管理动作同库即时生效(无缓存承诺)。
3. 凭证哈希零出现于任何响应形状。
4. 审计动作与 v1 动词清单一致(§内逐条)。

## 2. API 对照(节选)

| 旧签名(repo/service) | 新签名(facade) | 变化理由 |
|---|---|---|
| userAccount.insertLocalUser({email,passwordHash,...}) | provisionLocalAccount({email,displayName?}) | G5:不保存认证秘密 |
| org.insertOrgWithOwner | createOrg({ownerUserId,name}) | 名字由调用方(billing)组合模板 |
| org.listMembershipsForUser + service 富化 | listMyOrgs | G1 |
| referral.service.overview(含 totalCommission) | referralOverview | G2 |
| marketing.listPayouts | 不迁 | G3(billing) |
| referral.sumInviteeSpendByInviter | 不迁 | G3(billing/worker) |
| apiKey.adminPatchKey → {id,keyHash} | adminPatchKey → 行投影 | B2 |
| patchMember(不过滤状态) | setMemberLimits(active-only) | B5 |
| marketing.updateSettings(两往返) | updateMarketingSettings(单语句 returning) | B7 |
| 老错误码 invitation_not_found | invitation_invalid | 词表归并(同族 not_found 语义) |
| api_key.update_limit | api_key.update | 归一(动作=管理补丁全义) |

## 3. 行为对照核销清单(实施完成时逐项打勾)

- [ ] 1.1.1–1.1.7 用户与资料
- [ ] 1.2.1–1.2.9 组织/成员/邀请(含席位串行化、复活、owner 保护)
- [ ] 1.3.1–1.3.6 API Key(含轮换降级、明文一次)
- [ ] 1.4.1–1.4.5 Application
- [ ] 1.5.1–1.5.7 推荐/拉新参数
- [ ] 1.6.1–1.6.4 横切
- [ ] B3/B5/B7/B12 回归用例绿
- [ ] 四门 + real 门绿

## 4. 显式待办(移交后续波次)

| 待办 | 波次 | 后果 |
|---|---|---|
| 注册/登录/会话编排、密码策略统一(B10)、set-password 副作用(B11) | identity | accounts 无凭据路径;调用方经 port 桥接 provision |
| 开户赠送/推荐奖励的实际入账实现(WalletCreditPort→billing) | billing(P4.3 先行) | 港内测试用替身;生产装配前 facade 不可用于入账 |
| 佣金日结、返利流水投影、组织订阅富化、totalCommission | billing + app(P5) | 管理面数字在 app 组合层恢复 |
| 组织随购买同事务诞生(G7) | billing | createOrg 已备,桥接形态由 billing 裁决 |
| users.password_hash 写入方 | identity | 建号后本地账号暂无密码(与 v1 并行期语义差异,已声明) |

## 5. 回滚方案

本单元在新仓新建包 + http 生成器搬迁,无生产调用方切换——revert 即整体还原;
老仓只读未动。DDL 零变更(B8 保留惰性过期即为此)。
