# Token 存储与续期机制（含服务端实现与 Nginx 配置）

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；以代码为准。
> 本文回答四个问题：本项目会话为什么**不用 refresh token**；四端（BFF / 纯 SPA / App /
> 本项目）各自的正确形态；服务端各机制的实现要点；Nginx 同域/跨域的落地配置。
> 会话代码事实源（v2）：`packages/identity`（签发/校验/吊销）、
> `packages/api-client/src/next/session.ts`（BFF cookie）、
> `apps/client` 与 `apps/admin` 的 server actions（BFF 会话动作）。

---

## 1. 本项目的会话形态（现状事实，v2）

| 项 | 实现 |
|---|---|
| Token | 单 JWT（HS256）。realm 参数化：用户面 `realm:'user'`、管理面 `realm:'admin'`，**每 realm 独立 issuer/密钥/TTL 装配注入**（v1 的 `JWT_SECRET`/`ADMIN_JWT_SECRET` 双密钥演化为 realm 配置；双身份物理隔离语义不变） |
| 验签隔离 | 三重校验：算法白名单（仅 HS256）+ issuer 强校验 + 载荷 realm 比对——同 numeric id 的 user/admin 互不串号，即使密钥巧合相同（`packages/identity/src/adapters/jwt/jose-tokens.ts`） |
| 有效期 | `SESSION_TTL_SECONDS`，client-api 与 admin-api 各自 config schema，默认 **86,400s = 24h 固定**（界 [60, 2_592_000] = `identity` 的 `SESSION_TTL_BOUNDS`）；cookie `maxAge` 与 JWT `exp` 对齐 |
| 存放 | Next.js **BFF 持有**：`ag_session` / `ag_admin_session` cookie（httpOnly / sameSite=lax / 生产 secure / path=/）——浏览器 JS 从头到尾碰不到 token；后端 API 是**无 Cookie 的 Bearer 面**，BFF 出站时以 `Authorization: Bearer` 头携带 |
| 吊销 | ① 每请求查库校验账号 status（client-api 装配层 `identity.sessions.validate` + `activeUserStatus`，封禁/注销即时生效）② jti 黑名单单会话强制下线（Redis SETEX 存活至令牌自然过期；查询 fail-open + warn，DB 侧锚点线兜底；登出即吊销 jti）③ **锚点线**：`identity_session_anchors` 表按 (realm, userId) 记 `invalid_before`，签发时间早于锚点即失效（改密/重置/管理员强制下线全走这条线） |
| 续期 | **无**——活跃用户 24h 整点登出（滑动续期方案见 §5.2，仍为设计备选未实施） |

v1→v2 结构变化：会话逻辑从「identity 包 + api-client session.ts」两处，收敛为
`packages/identity`（签发/校验/吊销/jose 适配）+ `packages/api-client/src/next/session.ts`
（BFF cookie 工具，仅 `./next` 子入口导出）+ 两个 Next app 的 server actions（动作编排）。

## 2. 为什么不用 refresh token（威胁模型论证，机制不变）

双 token 的两个核心收益是「**限制泄露窗口**」与「**集中吊销点**」。本项目形态下：

1. **泄露窗口已是零**：token 在 BFF 服务端域的 httpOnly cookie 里，XSS 偷不到本体；
   网络层 HTTPS 覆盖。短期 access 的「限制窗口」没有对象。
2. **吊销已集中**：每请求查库 + jti 黑名单 + 锚点线，不需要刷新端点充当吊销集中点。
3. **24h 固定过期 = 最长泄露窗口的硬约束**，兼任了 access TTL 的角色。
4. refresh 模型的成本是真实的：刷新端点成为高价值攻击面（rotation + 重用检测必配）、
   有状态凭证管理、并发刷新竞态、多端一致性——为偷不到 token 的系统引入这些是负收益。

**失效边界**（出现任一信号时为新通道引入 refresh，BFF 线不动）：
出移动 App；前端剥离 BFF 改纯静态 SPA；产品要求设备管理/多端会话列表
（`identity` 的 `identity_session_anchors` 表是现成地基）。

## 3. 四端对照总表（机制论证，不变）

| | Web BFF/nginx 同域 | Web 纯 SPA | 移动 App | **本项目** |
|---|---|---|---|---|
| Token 形态 | 短 access + refresh | 短 access + refresh | 短 access + refresh | 单 JWT 24h |
| 长期凭证存哪 | httpOnly cookie（Path 限定） | httpOnly cookie（跨域 SameSite=None） | Keychain / Keystore | 不存在长期凭证 |
| access 存哪 | 内存 | 内存 | 内存 | cookie（BFF 持有） |
| XSS 偷 token | 偷不到 | 偷不到 refresh | N/A（有逆向） | 偷不到 |
| 最长泄露窗口 | access TTL（5~15min） | 同左 | 同左 | 24h |
| 续期 | 刷新端点轮换 | 同左 + 单飞锁 | 同左 + 设备链轮换 | 无（可加滑动续期） |
| 吊销 | rotation + 重用检测 | 同左 | rotation + 设备级吊销 | status 查库 + jti 黑名单 + 锚点线 |
| CSRF | SameSite=Lax 覆盖 | None + 自定义请求头 | N/A | SameSite=lax 覆盖（BFF→后端是 Bearer 头，不经浏览器自动携带） |
| 适用前提 | 部署可控（能同域） | 前端域固定可白名单 | 原生 App | BFF + 浏览器端 |

**铁律**：任何形态下 refresh token 永不进 localStorage；access token 优先内存
（页面刷新用一次静默刷新买回，几十 ms）。

## 4. 各端标准方案（不变，供新通道选型参考）

### 4.1 纯 SPA + 同域反代（推荐：静态托管 ≠ 必须跨域）

Nginx 一段配置让静态 React 与 API 同域（完整配置见 §6.1），随后与 BFF 形态等价：
refresh 进 `Path=/api/v1/auth/refresh` 限定的 httpOnly cookie，access 走响应体进内存。

### 4.2 纯 SPA 真跨域

refresh 仍走 API 域 httpOnly cookie，`SameSite=None`（跨域必需）+ CSRF 封堵：

- 刷新端点只接受带自定义头（如 `X-Client: web`）的请求——跨站表单无法伪造自定义头，
  CORS 预检拦截非白名单来源
- CORS 精确白名单（`Access-Control-Allow-Origin: https://app.example.com` +
  `Allow-Credentials: true`，**禁止通配符**）

### 4.3 移动 App

- refresh → **iOS Keychain**（`ThisDeviceOnly`）/ **Android EncryptedSharedPreferences**
  （Keystore 硬件密钥）；access → 内存；明文 UserDefaults/SharedPreferences 存 token = 高危
- 服务端必配三件套：**rotation + 重用检测**（旧 refresh 重现 = 泄露，吊销设备整条会话链）、
  **设备绑定**（device_id 维度签发/吊销）、**App Attest / Play Integrity**（证明官方客户端）
- 传输层 **SSL Pinning** 防 Charles/Frida 抓包
- 客户端 secret 藏不住（逆向必得）——App 身份靠 Attest/Integrity + PKCE，不靠藏

## 5. 服务端实现要点（v2 代码事实）

### 5.1 本项目现状（供阅读入口）

- **签发**：`packages/identity/src/application/sign-session.ts` → facade 面
  `identity.sessions.sign({ realm, subjectId, ttlSec? })`；jose HS256 实现
  `adapters/jwt/jose-tokens.ts`：payload 含 `realm/sub/jti/iss/exp/iat`，另有 **`iatMs`
  毫秒精度自定义声明**——会话失效线需要亚秒级（标准 `iat` 只有秒分辨率，同一秒内
  「改密 vs 重新登录」无法区分）。
- **cookie 写入（BFF）**：`packages/api-client/src/next/session.ts` 的
  `setSessionToken` / `setAdminSessionToken`（httpOnly + sameSite lax + secure(生产) +
  maxAge=`SESSION_TTL_SECONDS`）；同文件 `getSessionToken` / `clearSessionCookie` 家族。
  BFF 出站由 `next/clients.ts` 装配的 getToken 把 cookie 值注入 `Authorization: Bearer` 头。
- **动作编排（BFF）**：`apps/client/src/server/actions/auth.ts`——登录/验码成功
  `setSessionToken(body.token)`（token 来自响应体）；`logoutAction` 先
  `POST /v1/auth/logout`（吊销服务端 jti，泄露副本即失效）再 `clearSessionCookie`，
  吊销 best-effort 不阻塞登出。`apps/admin/src/server/auth-actions.ts` 管理面同构
  （`ag_admin_session`）。
- **校验链**：`packages/identity/src/application/validate-session.ts`——验签 →
  jti 黑名单（读故障 fail-open + warn：吊销是增强层，主防线是属主回查与锚点线）→
  锚点线（`iatMs < invalid_before` 即失效；无锚点全有效）。属主回查与 status 检查不在
  identity 包（归 accounts 经 app 编排）：client-api 装配层组合
  `identity.sessions.validate(token, 'user')` + `accountRead.activeUserStatus(userId)`，
  非 ACTIVE 一律 null。
- **中间件**：`apps/client-api/src/http/middleware/session.ts`——Bearer 头取 token →
  校验（静默 null）→ 通过注入 userId/jti/exp；失败统一 401 不区分原因（防账号枚举）。
- **吊销动词**：`packages/identity/src/application/revocation.ts`——`advanceAnchor`
  （原语：改密/重置内部同事务调用）、`revokeSessions`（带审计的管理动作：推进锚点线）、
  `sessionValidAt`（读校验）；jti 黑名单 Redis 实现
  `adapters/redis/revocation-store.ts`（SETEX 存活至令牌自然过期，无需 GC）。
- **配置**：`SESSION_TTL_SECONDS`（client-api / admin-api 各自 config schema，默认
  86400，界 60–2,592,000 = `SESSION_TTL_BOUNDS`）；realm 配置（issuer/密钥/TTL）由
  assembly 注入 identity。

### 5.2 滑动续期（本项目可加，无需 refresh 机制；仍为设计备选）

语义：活跃用户不掉线；闲置 24h 照样登出；安全语义不变。实现要点（BFF 层）：

```ts
// BFF 会话读取处（apps/client 的 server 侧；工具来自 @tokenlens/api-client/next）：
import { decodeJwt } from 'jose';
import { getSessionToken, setSessionToken } from '@tokenlens/api-client/next';

const token = await getSessionToken();
const { exp, jti } = decodeJwt(token);
if (exp - now < TTL_S / 2) {              // 剩余寿命 < 一半 → 静默重签
  const fresh = await fetch(`${API}/v1/auth/renew`, {   // 假设端点：验旧签新（当前未实现）
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json());
  await setSessionToken(fresh.token);      // 覆盖 cookie（maxAge 重置）
  await revoke(oldJti);                    // 旧 jti 进黑名单（best-effort）
}
```

服务端 `/v1/auth/renew`：验签旧 token（未过期 + jti 未吊销 + 锚点线通过）→ 同 subject
签新 token（新 jti，`identity.sessions.sign` 即可）→ 旧 jti 入黑名单（TTL = 旧 token
剩余寿命）。admin 面建议**不加**（管理面短会话是最佳实践），仅 client 面启用。

### 5.3 刷新端点（未来 App/SPA 通道用，此时才实现）

```ts
POST /v1/auth/refresh  // 凭 httpOnly cookie 中的 refresh token
  1. 校验 refresh 签名/过期/未被吊销（有状态：refresh 表或 Redis）
  2. rotation：作废当前 refresh（写入已用集合）→ 签发新 refresh + 新 access
  3. 重用检测：已作废的 refresh 再次出现 ⇒ 判定泄露 ⇒ 吊销该设备/会话全部链条 + 告警
  4. 设备形态：refresh 绑 device_id，吊销按设备精确打击
// 并发竞态（多 tab）：同域 cookie 全 tab 共享，各 tab 独立 401→刷新→重放自洽
// （无状态 access 允许多个并存有效）；前端配单飞刷新锁防同 tab 并发风暴
```

## 6. Nginx 配置

### 6.1 同域反代（静态 SPA + API，refresh cookie 的最简形态）

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;

    # 静态 SPA
    location / {
        root /var/www/react-dist;
        try_files $uri /index.html;          # SPA 路由回退
    }

    # API 同域反代（跨域问题就此消失）
    location /api/ {
        proxy_pass http://127.0.0.1:8081/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }
}
# 后端登录响应下发（Path 限定是灵魂——其余路径请求根本不携带 refresh cookie）：
#   Set-Cookie: refresh=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/refresh
```

### 6.2 真跨域（SameSite=None + CSRF 封堵）

```nginx
location /v1/auth/refresh {
    if ($http_origin !~ ^https://(app\.example\.com)$) { return 403; }  # Origin 白名单
    add_header Access-Control-Allow-Origin  $http_origin always;
    add_header Access-Control-Allow-Credentials true always;
    add_header Access-Control-Allow-Headers  'content-type,x-client' always;
    proxy_pass http://auth_backend;
}
# 后端配套：Set-Cookie ... SameSite=None; Secure（跨域 None 必须配 Secure）
# 端点只接受含 X-Client 头的请求（跨站表单无法伪造自定义头）
```

### 6.3 SSE 流式（本网关生产实配，v2 `docker/nginx/nginx.conf`）

v2 实配要点：单公网入口按路径分流——`/v1/oauth/` 与 `/v1/payments/notify/*` 先行命中
client-api（OAuth provider 与支付平台只能访问公网入口，不能访问 Docker 内网服务名），
其余 `/v1/` 与 `/oauth/token` 进 gateway；两个 Next 面板（console-client / console-admin）
各挂独立 server 块的 `location /`。推理路径的流式配置不变：

```nginx
location /v1/ {
    proxy_pass http://gateway_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
    proxy_buffering off;        # 流式：不缓冲（否则 SSE 被攒包，TTFB 恶化）
    proxy_cache off;
    proxy_read_timeout 360s;    # 大于网关流式空闲阈值（5min）
    proxy_send_timeout 360s;
}
```

同域反代对会话的实际效果：Next 面板、client-api、gateway 同属一个公网域，
`ag_session`（sameSite=lax）在面板与 API 之间自然随行，不存在 §6.2 的跨域场景。

## 7. 决策速查

```
部署可控？     → Nginx 同域反代：refresh 进 Path 限定 httpOnly cookie，access 内存
真跨域？       → SameSite=None + Origin 白名单 + 自定义头防 CSRF
移动 App？     → Keychain/Keystore + rotation + 设备绑定 + Attest/Integrity
BFF 形态？     → 本项目：单 JWT + httpOnly + status 查库 + jti 吊销 + 锚点线，不需要 refresh
任何形态：     → refresh 永不进 localStorage；access 优先内存
```
