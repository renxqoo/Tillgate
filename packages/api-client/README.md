# `@tokenlens/api-client`

**发布候选第一号**(当前私有;发布改造见总纲 P6)。client-api / admin-api 调用封装:
框架无关 transport / 错误 / 分页客户端 + 手写 DTO 快照 + `./next` BFF 装配子入口。

设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 迁移核销 [MIGRATION.md](./MIGRATION.md)

## 入口

| 入口                         | 内容                                                                                                                           | 依赖                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `@tokenlens/api-client`      | `createHttpClient` / `createClientApiClient` / `createAdminApiClient` / `ApiError` / `buildListQuery` / `Paginated` / 两面 DTO | 零运行时依赖,不需要 Next |
| `@tokenlens/api-client/next` | `createNextClientApiClient` / `createNextAdminApiClient` / session cookie 工具 / locale 协商 / `trustedClientIp`               | peer `next@^16`          |

## 用法

### 框架无关(任意 runtime)

```ts
import { createClientApiClient, ApiError } from '@tokenlens/api-client';

const client = createClientApiClient({
  baseUrl: 'http://client-api:8081',
  getToken: () => loadBearerToken(), // 可选;返回空值则不带会话
  getHeaders: () => ({ 'accept-language': 'zh' }), // 可选出站附加头
});

// GET / POST / PATCH / PUT / DELETE / list
const me = await client.get<MeInfo>('/v1/me');
await client.post<KeyCreated>('/v1/keys', { name: 'prod' });
const page = await client.list<KeyRow>('/v1/keys', { page: 1, pageSize: 20 });

try {
  await client.request('/v1/keys', { method: 'POST', body: {} });
} catch (e) {
  if (e instanceof ApiError) console.log(e.status, e.code, e.details);
}

// 布局守卫:任何失败(含未登录)返回 null
const user = await client.getMe();
```

调用封装不做路径翻译,只接受后端唯一正式路径 `/v1/*`。

### Next BFF(Server Component / Server Action)

```ts
import {
  createNextAdminApiClient,
  setSessionToken,
  hasSessionCookie,
} from '@tokenlens/api-client/next';

// env CLIENT_API_BASE / ADMIN_API_BASE(缺省回落 dev 端口 8081/8082)
const admin = createNextAdminApiClient();
const rows = await admin.list<AdminUserRow>('/v1/users', { pageSize: 20 });

// 会话:ag_session / ag_admin_session HttpOnly cookie(BFF 持有 Bearer JWT)
await setSessionToken(tokenFromLoginResponse);
```

`./next` 装配自动注入:`authorization`(会话 cookie)、`accept-language`(cookie →
浏览器头 → en)、`x-forwarded-for`(`TRUSTED_PROXY_HOPS` 右数第 N 跳信任模型)。

## 环境变量(仅 ./next 层读取)

```bash
CLIENT_API_BASE=http://localhost:8081     # 用户面基地址
ADMIN_API_BASE=http://localhost:8082      # 管理面内网地址
TRUSTED_PROXY_HOPS=0                      # 前置反向代理层数(0=不信任 XFF)
SESSION_TTL_SECONDS=86400                 # 会话 cookie maxAge
```

## 约束

- 根入口不得 import `next/`(架构测试门禁);发布闭包禁止任何私有 `@tokenlens/*` 依赖。
- `src/dto/` 为手写过渡态;OpenAPI 生成链落地后由 `generated/` 整体替换(总纲 §2.2/P6)。
- 抛出的错误 message 一律英文;中文渲染由消费方处理。

## 本地门禁

```bash
bun run typecheck && bun run lint && bun run test && bun run build
bun run test:coverage   # 阈值 90/85
```
