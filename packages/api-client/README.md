# `@ai-gateway/api-client`

**admin-api 客户端封装**（`apiFetch` / `ApiError` / 类型 / formatters / 会话工具），供 `apps/client` 和 `apps/admin` 共享。

## API

### 数据获取

```ts
import { apiFetch, getMe, ApiError } from "@ai-gateway/api-client";

// GET
const me = await apiFetch<MeInfo>("/v1/me");

// POST
const newKey = await apiFetch<{ key: string }>("/v1/keys", {
  method: "POST",
  body: { name: "prod" },
});

// 错误处理
try {
  await adminFetch("/v1/users/1", { method: "PATCH", body: { status: 1 } });
} catch (e) {
  if (e instanceof ApiError) {
    console.log(e.code, e.message);
  }
}

// 当前登录用户（返回 null 表示未登录）
const user = await getMe();
```

所有调用在 Server Component / Server Action 中执行。session 通过 HttpOnly Cookie `ag_session` 自动携带（`apiFetch` 内部读 `next/headers`）。

### Formatters

```ts
import {
  fmtBalance,   // 2dp：余额、流水
  fmtCost,      // 6dp：单次费用
  fmtPrice,     // 4dp：模型单价
  fmtInt,       // 整数
  fmtDateTime,  // ISO → yyyy-MM-dd HH:mm
  fmtDate,      // ISO → yyyy-MM-dd
  msToHuman,    // 毫秒 → ms / s
} from "@ai-gateway/api-client";
```

DB 现存「元」numeric 字符串（如 `"49.999990000000000000"`），formatters 都兼容 string / number 输入。

### 会话

```ts
import {
  hasSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
} from "@ai-gateway/api-client";
```

仅服务端使用，配合 `cookies()` + `redirect()` 实现守卫。

### 类型

- `MeInfo`：当前用户完整字段（含 `role: 0 | 1`）
- `Paginated<T>`：admin-api 分页结构 `{ list, total, page, page_size }`
- `ApiError`：服务端抛出的带 `code / status / details` 的错误
- `REDEEM_ERROR_MESSAGES`：充值错误码 → 中文映射

## 环境

```bash
ADMIN_API_BASE=http://localhost:8790   # 默认值；docker 内为 http://admin-api:8790
```

## 类型检查

```bash
pnpm --filter @ai-gateway/api-client typecheck
```
