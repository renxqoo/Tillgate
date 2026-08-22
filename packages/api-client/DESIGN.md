# @tokenlens/api-client 设计基线

> 状态：定稿
> 定位：发布候选第一号（总纲 §3.1「外部产品候选」）；本阶段以私有内部包落地，
> 发布改造（dist 声明产物、tarball 冒烟）按总纲 P6 另行推进。
> 结构依据：`docs/project-structure-refactoring.md` §3 api-client 树、§5.1 依赖白名单、§7.2 发布形态。
> 关联：IMPLEMENTATION.md（施工图）/ MIGRATION.md（迁移单元核销）。

---

## 1. 外部契约

### 1.1 入口结构

```text
@tokenlens/api-client          # 根入口：框架无关，不得 import next/（§3 树注释）
@tokenlens/api-client/next     # BFF 子入口：next/headers 装配（session/locale/forwarded-ip）
```

- 根入口零 Next 依赖：`import '@tokenlens/api-client'` 在任意 runtime（Node/Bun/浏览器侧打包）
  可解析，不要求安装 Next。
- `./next` 子入口的 Next 以 peer dependency 声明（`^16.3.0`），由消费 app 提供；
  本包 devDependencies 自持同版本用于隔离 typecheck/test。

### 1.2 公共 API（参数平铺、结果判别联合、无隐藏默认）

```ts
// core：框架无关 transport
class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
}
interface ApiFetchOptions {
  // Omit<RequestInit,'body'|'headers'> 的扩展
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown; // JSON.stringify 序列化；undefined 不发
  bearerToken?: string | null; // 显式覆盖 getToken
  revalidate?: number | false; // false→cache:'no-store'；number→Next revalidate 透传
  headers?: Record<string, string>; // 覆盖层：最后合并
}
function createHttpClient(options: {
  baseUrl: string; // 必填（铁律 3：不藏 localhost 默认）
  fetch?: typeof fetch; // 注入，缺省 globalThis.fetch
  getToken?(): Promise<string | null | undefined> | string | null | undefined;
  getHeaders?(): Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
}): HttpClient; // request/get/post/patch/put/delete/list

// core：分页（总纲 §3.1 api-client 职责「错误和分页客户端」）
interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
}
interface ListFetchOptions {
  page?: number;
  pageSize: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
  extra?: Record<string, string | number | undefined>;
}
function buildListQuery(opts: ListFetchOptions): string; // page/limit/sort_by/order + extra（跳过 undefined/''）

// 两面 facade（根入口导出）
function createClientApiClient(options): ClientApiClient; // + getMe(): Promise<MeInfo|null>
function createAdminApiClient(options): AdminApiClient; // + getAdminMe(): Promise<AdminMeInfo|null>

// DTO：手写过渡态（dto/client-api.ts、dto/admin-api.ts）
//   生成链（总纲 P3 scripts/generate-openapi.ts → generated/）落地后整体替换并删除 dto/；
//   生成链建立前手写 DTO 是唯一事实源，禁止双轨（总纲 §2.2）。

// ./next 子入口
function createNextClientApiClient(options?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): ClientApiClient;
function createNextAdminApiClient(options?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): AdminApiClient;
function getClientApiBase(): string; // env CLIENT_API_BASE 惰性解析，dev 兜底 http://localhost:8081
function getAdminApiBase(): string; // env ADMIN_API_BASE 惰性解析，dev 兜底 http://localhost:8082
// + session cookie 工具（v1 session.ts 全量动词）
// + locale 内核（resolveLocale/parseAcceptLanguage/LOCALES/LOCALE_COOKIE/...）与 outgoingLocale()
// + XFF 信任解析 trustedClientIp 与 outgoingUserIpHeader()
```

调用封装不做路径翻译：只接受后端唯一正式路径 `/v1/*`，其余在客户端层抛
`Error: [api-client] Invalid API path ...`（v1 契约，回归测试锁定）。

### 1.3 错误形态

- 非 2xx → `ApiError`，字段取自后端统一错误信封 `{ error: { message, code, details } }`。
- 信封缺 message（或响应体非 JSON）→ 英文兜底 `Request failed (status)`（铁律 18：
  抛出 message 一律英文；中文渲染由消费方按 locale 处理，见 MIGRATION §4）。
- 响应体非 JSON → 尝试 `{ raw: text }` 保底解析；空体 → `null`。
- `getMe`/`getAdminMe` 吞掉一切错误返回 `null`（布局守卫语义，v1 行为等价）。

### 1.4 依赖闭包（总纲 §5.1：禁止任何私有 `@tokenlens/*` 运行时包）

- dependencies：无（零运行时第三方依赖；zod 在 v1 已无实际引用，删除）。
- peerDependencies：`next@^16.3.0`（仅 ./next 子入口需要）。
- devDependencies：next（自满足 peer 的隔离 typecheck/test）、@types/node、typescript、vitest。
- `@tokenlens/http` 的 `trustedClientIp` / locale 协商算法以**同语义副本**内联（§3.3），
  不建立依赖边——由架构测试禁止任何 `@tokenlens/*` import。

---

## 2. 问题域

### 2.1 处理

- 双后端（client-api/admin-api）REST 调用 transport：URL 拼接、Bearer 注入、
  accept-language / x-forwarded-for 出口头、JSON 编解码、错误信封 → ApiError。
- 分页查询构造与 `Paginated<T>` 信封解析。
- Next BFF 侧装配：HttpOnly cookie 会话持有（ag_session/ag_admin_session）、
  cookie→Accept-Language 语言协商出口、可信代理 IP 出站头、env 基地址惰性解析。
- 两面 wire DTO 的手写快照（过渡态，见 §1.2）。

### 2.2 不处理（写清归属）

- 展示格式化（formatMoney/fmt* 等）：**不迁移**，目标归属 `ui` 包 `formatting/`
  （总纲 §3 ui 树）；本次迁移不带入，ui 波次另行处理（MIGRATION §3 裁决表）。
- 列表页错误降级展示（v1 list.ts 的 `{rows,total,error}` 信封）：页面骨架 UX 契约，
  归 ui/ListPage 与 app 调用方；本包 `list()` 抛 ApiError 交调用方渲染。
- Server Action / Cookie 写入时机 / 路由守卫：归 apps（总纲 §7.2「Server Action 留在对应 app」）。
- OpenAPI 生成链与 generated/ 产物：总纲 P3/P6 交付；本阶段不创建空 generated/ 目录。
- tarball 安装冒烟 / dist 声明产物 / 发布白名单：总纲 P6/P8。
- 上游 API 的业务语义（状态码含义、字段校验）：DTO 仅描述 wire 形状，不校验。

### 2.3 词表

- Locale 词表闭集 `en | zh`（与 http 侧同一语义副本，§3.3）。
- 会话 cookie 名 `ag_session` / `ag_admin_session`（浏览器侧兼容不变）。
- 环境变量：`CLIENT_API_BASE` / `ADMIN_API_BASE`（./next 层）、`TRUSTED_PROXY_HOPS`
  （./next 层，逐调用读取）、`SESSION_TTL_SECONDS`（./next 层）。

---

## 3. 关键决策

### 3.1 框架无关根入口 + 显式 ./next 子入口（总纲 §3 树、§7.2 强制）

core 通过参数接收 `baseUrl`、`fetch`、token/headers 获取器；不读 Next Cookie、
不读环境变量、不持有可信代理配置。Next 三件（session/locale/forwarded-ip）只从
`./next` 出口。env 基地址读取与 dev 兜底属于 BFF 装配关切，放在 ./next 的
clients.ts（v1 开箱即用行为保留），根入口的 baseUrl 必填。

### 3.2 工厂闭包形态（铁律 5）

`createHttpClient` / `createClientApiClient` / `createAdminApiClient` /
`createNextClientApiClient` / `createNextAdminApiClient` 全部工厂闭包；无模块级
可变单例。v1 的 token 双面自动选择（isAdminBase 按基地址字符串比较挑选会话源，
见 IMPLEMENTATION B1）废除——每面工厂显式注入自己的 getToken。

### 3.3 http 包算法副本（依赖闭包裁决，总纲 §7.3 顺序一「移除内部依赖」）

`trustedClientIp`（XFF 右数第 N 跳信任模型）与 `parseAcceptLanguage/resolveLocale`
（en|zh 闭集协商）在 v2 `@tokenlens/http` 已逐字存在；api-client 受发布闭包约束
（§5.1）不得 import，故内联同语义副本于 `src/next/forwarded-ip.ts`、`src/next/locale.ts`，
文件头交叉引用 http 侧孪生实现，测试采用与 http 包相同的向量表（锁步约束）：
两侧任一改动语义必须同步另一侧并同步向量。接受的漂移风险在 IMPLEMENTATION §4
登记；这不是依赖白名单例外，无需 ADR。

### 3.4 手写 DTO 过渡态（总纲 §2.2「禁止双轨」）

生成链未建立，手写 DTO 是唯一事实源。落位 `src/dto/{client-api,admin-api}.ts`，
文件头标注过渡态与替换路径；**不**预建 `src/generated/` 空目录（§3.2 反空壳纪律）。
P6 落地时 facade 的 DTO import 切到 `generated/`，`dto/` 同提交删除。

### 3.5 Next fetch 扩展的透传口径

`revalidate` 选项在 core 保留（v1 行为等价）：`false → cache:'no-store'`、
`number → init.next.revalidate`（非标准字段，标准 fetch 忽略、Next patched fetch 消费）。
core 不 import next，该字段是无框架耦合的惰性透传，注释固定口径。

---

## 4. 并发与性能预算

- BFF 请求路径零额外缓冲：单次 `fetch` + `res.text()` + 一次 JSON.parse（v1 等价）。
- 工厂闭包无跨请求可变状态；./next 基地址惰性 memo 是进程内只读缓存（首次解析后不变），
  `unknown-*` 进程级兜底 IP 同 v1（跨 worker 不共享）。
- 无定时器、无后台任务、无连接池持有；传输资源全部由注入的 fetch 拥有。

---

## 5. 验收对照

- 四门全绿（typecheck/lint/test/build）；覆盖率 ≥ 90/85（§10.3）。
- 架构门禁测试（铁律 11）：根入口及其依赖闭包无 `next/` import；全包无 `@tokenlens/*`
  import；package.json 依赖闭包无私有 workspace 包；exports 恰为 `.` 与 `./next`。
- 词表封闭：根入口与 ./next 的运行时导出集合被测试逐一锁定（§10.1）。
- 行为等价：MIGRATION §7 对照清单逐项核销。
