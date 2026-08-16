# FINDINGS-14：C 端 GitHub / Google OAuth 登录

日期：2026-08-16　分支：feat/gateway-production-hardening　前置：FINDINGS-12/13（邮箱登录体系）

## 需求
C 端支持 GitHub 登录、Google 登录。

## 设计

Authorization Code 流（服务端机密客户端），复用 users 表既有的多身份源结构
（`issuer + subject` 唯一键从 day-1 就是为此设计的）：

```
GET /api/auth/oauth/:provider/authorize?next=/path
  → state 双提交：ag_oauth_state HttpOnly cookie + Redis 单次记录(10min, 含 provider+next)
  → 302 GitHub/Google 授权页

GET /api/auth/oauth/:provider/callback?code&state
  → cookie state == query state 且 Redis 记录存在（防 login-CSRF / 伪造，单次消费）
  → 授权码换 token → 取 profile（GitHub: /user + /user/emails 主邮箱；Google: userinfo sub/email）
  → find-or-create：issuer='github'|'google'，subject=平台用户 id
  → ag_session + 赠额（幂等）+ 302 前端（next 仅站内相对路径，防 open redirect）
```

### 关键决策
- **不与本地邮箱账号自动合并**：GitHub 邮箱与本地账号邮箱相同也是两个账号
  （issuer 不同）。自动按邮箱合并 = 劫持向量（伪造邮箱所有权的第三方账号直接接管本地账号）。
- **OAuth 登录不再发邮箱验证码**：邮箱真实性由平台（GitHub 精选主邮箱 / Google email_verified）背书。
- **按钮显隐的单一真相在 client-api**：`GET /oauth/providers` 返回已配置方式，前端
  登录/注册页服务端拉取渲染——不在两个应用里各配一份 env。
- **端点可覆盖**（config 层 `oauth.endpoints`）：测试接假 provider，同时天然支持
  GitHub Enterprise 等私有化网关扩展；env 不暴露。
- **未配置即关**：端点 404 OAUTH_NOT_CONFIGURED、按钮隐藏；fail-closed 无降级路径。

## 防护
| 攻击面 | 防护 |
|---|---|
| login-CSRF（诱导受害者登入攻击者账号） | state 双提交（cookie + Redis 单次）+ provider 绑定校验 |
| 授权码重放 | code 一次性（平台保证）+ state 单次消费 |
| open redirect | next 仅接受站内相对路径（// 开头拒绝） |
| 账号劫持 | 不按邮箱跨 issuer 合并；subject=平台 id 不可伪造 |
| 并发同号首登 | users_issuer_subject_uq 唯一键兜底 → 回查 |

## 变更清单
- packages/core：OAUTH_GITHUB_*/OAUTH_GOOGLE_*（可选）、OAUTH_API_BASE、OAUTH_FRONTEND_URL
- apps/client-api：services/oauth.ts（适配器换 token/取 profile/find-or-create）+ routes/oauth.ts
  （providers/authorize/callback）；services/auth.ts 导出 issueSession（登录/注册/OAuth 三处共用）
- apps/client：oauth-buttons 组件（内联品牌 SVG）；登录/注册页拉取 providers 渲染
- .env.example：OAuth 段（含两端回调 URL 填写指引，默认注释=关）

## 验证（四关）
- 测试：client-api 38（新增 auth-oauth 3 例，假 provider 本地服务器，不打外网）；
  全仓 18 包全绿；typecheck 0 错；lint 全绿
- dev 实测：未配置 → providers `[]`、authorize 404、两页按钮隐藏、注册表单不受影响

## 上线前需要用户做（真实开通）
1. GitHub：Settings → Developer settings → OAuth Apps → New，回调填
   `{OAUTH_API_BASE}/api/auth/oauth/github/callback`，把 Client ID/Secret 写入 .env
2. Google：Cloud Console → 凭据 → OAuth 客户端（Web），重定向 URI 填
   `{OAUTH_API_BASE}/api/auth/oauth/google/callback`
3. 重启 client-api（tsx watch 触发一次重启即可），按钮自动出现

## 续：显示名称（R15 同日）
- 新用户默认显示名 `rx`+6 位随机（去易混字符）；OAuth 仅认平台真实姓名字段（GitHub login 不再兜底）
- PATCH /api/me/display-name 自助修改（1-32 字符、trim、审计）；设置页账户卡「修改名称」弹窗
