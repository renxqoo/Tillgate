# e2e/client-journey — client-api 跨进程用户旅程

> 总纲 §3：`e2e/` 是跨进程系统测试，**不是 workspace 包**（无 workspaces 成员身份，
> 自带最小生命周期：package.json + tsconfig + vitest 配置）。
> 运行：`bun install && bun x vitest run`（需真实 PG/Redis——vitest 配置自载根 `.env`，
> 只补缺不覆盖；基础设施不可达时整套 skip，不误报）。

## 套件与老仓对照（完整度矩阵）

| 老仓 e2e（用例数） | 本目录套件 | 核销范围 |
|---|---|---|
| e2e-user-journey（11） | `user-journey.e2e.ts` | **全量+扩展**：注册两步制（capture mailer）→ 挑战单次消费 → me/改显 → Key 生命周期（轮换吊销旧钥）→ 兑换失败 404 + 成功入账 → epay 充值（payUrl 签名参数 / 签名回调入账 status=2 / 重复回调幂等 / 金额篡改验签拒绝）→ 订阅购买 + 幂等重放 replayed → 钱包对账（余额分文不差 + 四域腿）→ 登出 jti 即时吊销 → 错密码 401 防枚举 → 两级登录 → 改密全网下线 → 复登 |
| e2e-oauth（12） | `oauth.e2e.ts` | providers 目录 / 未配置+未知 provider 404 / authorize 302（mock 上游端点参数 + state cookie 双提交）/ callback find-or-create + `#token=` fragment 回传 / fragment token 可用 / state 单次消费重放 410 / cookie 不符 403 / 上游换码故障 502 / 同 subject 二次登录复用账号 |
| e2e-org-team（3） | `org-team.e2e.ts` | 企业用户团队档购买（ensureOrg 组织诞生、额度=档×席位）→ 组织列表订阅富化 → 邀请 token 一次下发 → 被邀人注册+接受 → 成员限额 → 成员 Key 绑组织订阅 → 移除成员 / owner 不可自移 409 |
| e2e-cross-app（3） | **暂缓** | 依赖 apps/gateway（未建成）与真实上游模型——总纲 §9 P5 收尾搬迁时落地（client-api↔gateway 双服务：注册→充值→Key→网关调用→结算→吊销） |

## 装置要点（harness.ts）

- **固定端口**：identity 回调白名单要求装配前已知 apiBase → 先 reservePort 再装配。
- **mock GitHub**：本地 HTTP 服务实现 token/user/emails 端点（`fail-code` 触发 500 模拟上游故障）；
  经 `OAUTH_GITHUB_ENDPOINTS_JSON` 注入 identity provider。
- **epay**：下单纯本地计算（无需 mock 网关）；回调用 `epaySign` 伪造合法签名
  （金额篡改即验签失败——签名只证来源，金额闸防篡改获利）。
- **capture mailer**：`assembleClientApi(config, { mailer })` 覆盖缝（v1 同款）收验证码。
- **rawGet**：断言 302 时不跟随重定向（fetch `redirect:'manual'` 是 opaqueredirect，
  拿不到 Location——用 node:http 直连）。
- **数据自清理**：钱包按用户账户反查交易集合（DO 块：腿→交易→账户，镜像内部腿一并）；
  其余 FK 逆序 best-effort；播种物（plans/redeem 批次/管理员行）套件级回收。

## 已知形态差异（如实记录）

- 金额断言按 Decimal 归一比较——存储层 numeric 返回全精度串（`10.000…`，v1 同形）。
- `google` 未配凭证时 authorize 返回 `client.oauth_unknown`（providers 目录即凭证派生，
  identity 的 `oauth_provider_unconfigured` 在本 app 不可达）。
