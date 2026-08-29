# @tillgate/accounts

> 账号能力:用户资料、组织/成员/邀请、API Key、Application、推荐与拉新参数——账号事实唯一所有者,不保存认证秘密。

一句话:用户/组织/凭证资料的**事实唯一所有者**;认证秘密在 `identity`,资金在 `billing`,
本包只保存资料与账户关系,并经 port 与两者桥接。

## 核心导出面

- `createAccounts(env)` facade → `AccountUseCases`:建号(`provisionLocalAccount` /
  `provisionOAuthAccount` / `completeAccountOnboarding`)、资料、管理面用户、凭证读模型
  (`resolveKeyByHash` 网关鉴权 / `resolveAppByAppId` / `verifyAppClient`)、跨能力只读探针
  (`userRateCardBinding` / `memberLimits` 等)、API Key 全生命周期、Application 凭证、
  组织/邀请/成员、推荐与拉新参数。
- 领域词表单一真相:referral 幂等键(`signupGiftRefId` / `commissionRefId` /
  `encodeAffCode`)与状态词表(`USER_STATUS` / `CREDENTIAL_STATUS` / `MEMBER_STATUS` /
  `INVITATION_STATUS` / `REFERRAL_STATUS`)——跨包消费(billing/worker)。
- 桥接 port(根入口导出类型):`WalletCreditPort`(入账 → billing)、`AuditPort`(审计 →
  observability 存储)。
- `AccountsErrors` 错误目录(face 装配消费)。
- `./composition` 子入口(仅 app assembly / 迁移脚本可引用):`AccountStorePort`、
  `SessionInvalidationPort`(会话失效线桥,owner = identity)、
  `createPgFundingSourceResolver`(billing 资金源解析桥)、`createPostgresAccountStore`
  (worker 佣金循环直取营销参数)。

## 目录结构

```
src/
├── accounts.ts        # createAccounts facade:policy fail-fast + 用例组装
├── application/       # 用例层:context + create-use-cases 分组用例
├── domain/            # 领域纯函数:referral/status/credentials/errors
├── adapters/          # postgres 适配器:account-store / audit-sink / funding-resolver
├── ports/             # 可替换契约:account-store / wallet-credit / audit / session-invalidation
├── testing/           # 测试替身/装置
├── composition.ts     # 装配子入口(存储 port + 桥,非公开 API)
└── index.ts           # 唯一公共出口(adapter 不出根入口)
```

## 装配

消费方:`apps/admin-api`、`apps/client-api`、`apps/gateway`、`apps/worker` 的
`src/assembly.ts`——gateway 用 `resolveKeyByHash`/`WalletCreditPort` 桥,worker 经
`@tillgate/accounts/composition` 直取 `marketing_settings`(不经完整 facade)。

## 开发

```bash
cd packages/accounts
bun run typecheck && bun run lint && bun run test
DB_TEST_URL=postgres://... bun run test:real   # postgres-store + funding-resolver 真库门(缺 env 整组 skip)
```
