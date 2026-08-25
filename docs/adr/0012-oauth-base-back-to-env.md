# ADR-0012：OAuth 基地址退回 env（取代 D9 的 oauth.base 入库裁决）

- 状态：已接受（2026-08-25，用户裁决）
- 取代：`docs/integration-settings/DESIGN.md` §D9 中「`oauth.base` 入 DB」的部分；
  D9 的其余内容（凭据类动态读、60s 收敛窗口）不变。

## 背景

D9 当初把 `OAUTH_FRONTEND_URL/OAUTH_API_BASE` 并入 `oauth.base` 集成行，动机是
「admin 配好 GitHub 凭据后不想再改 env 才能开登录」；代价是装配期读取一次、
变更需重启。复审发现该买卖不成立：

1. **生效语义错位**：DB 集成设置的卖点是「界面可改、即时生效、审计、step-up」
   ——对 oauth.base 一条都不成立（改了要重启）。卡片上保存成功但回调白名单
   仍是旧值，是「我明明改了为什么不生效」的认知陷阱。
2. **归属错位**：frontendUrl/apiBase 是部署拓扑（换域名 = DNS/证书/CORS/前端
   env 的部署变更），不是运营凭据；且同一信息部署层已存在（前端构建的 API
   地址、`CORS_ORIGINS`），管理台手填 = 同一真相两处定义，可漂移可抄错。
3. **D9 的动机不成立**：首次部署配 DATABASE_URL/Redis/密钥时顺手配两个 URL
   是常规动作，不存在「多一步 env」的摩擦；本地缺省回退已覆盖开发形态。

## 决策

`oauth.base` 从集成设置词表移除，两个地址退回 env（沿用 v1 键名）：

- `OAUTH_FRONTEND_URL`：前端根地址。可选；缺省回落 `http://localhost:3000`
  （OAuth 跳转落点），未显式配置时找回密码链接维持 fail-closed（不外发错误
  域名的链接——与原「无行」语义逐条对应）。
- `OAUTH_API_BASE`：API 根地址。生产必填（config fail-fast）；本地缺省
  `http://localhost:8081`（与 `CLIENT_API_PORT` 缺省一致）。
- 回调白名单（`{apiBase}/v1/oauth/{github,google}/callback`）仍为装配期
  契约——由 env 构建，与「改 env 需重启」的部署语义天然一致。
- DB 收口：migration 删 CHECK 词表中的 `oauth.base` 并清存量行（内部阶段，
  无兼容窗；存量部署把卡片值抄进 env 即完成迁移）。
- 快照结构：`oauth.base` 段删除；provider 的 `effective` 不再联动 base
  （base 有效性由装配期 env 保证——base 缺失则进程拒绝启动，不存在
  「base 未生效但 provider 生效」的中间态）。

## 后果

- 集成词表 7 → 6（oauth.github/oauth.google/smtp/captcha.turnstile/
  payment.epay/payment.stripe）；管理台「OAuth 基地址」卡消失，GitHub/Google
  卡保留独立。
- 换域名流程回到部署清单：改 env（两键 + CORS_ORIGINS + 前端构建地址）→
  重启 client-api；管理台不再提供该项编辑。
- `docs/configuration.md`、`.env.example` 增补两键；deployment-checklist
  的换域名段落同步。
