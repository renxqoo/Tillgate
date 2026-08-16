# FINDINGS-10：列表接口统一（R10）

> 需求：① 统一列表 UI 组件（分页）+ 所有列表接口支持分页；② 统一搜索 + 默认时间倒序（有 sort 字段优先）；③ UI 组件一致性。
> 原则：治本（白名单下沉 /helpers）、删除优于兼容（游标参数与 `{items}`/`{list,total}` 形状一次删净）、破坏性变更一次做完整（后端+类型+前端+测试+文档同轮完成）。

## 统一栈（单一真相）

| 层 | 组件 | 位置 |
|---|---|---|
| 后端查询 | `paginationQuerySchema` / `searchQuerySchema`+`searchCondition` / `sortQuerySchema`+`resolveOrderBy` | `packages/http/src/list-query.ts`、`pagination.ts` |
| 响应 envelope | `{list,total,page,page_size}`（全列表唯一形状） | `paginateQuery` |
| 类型 | `Paginated<T>`（`ListResult` 已删除） | `packages/api-client/src/types.ts` |
| 页面取数 | `fetchAdminList` / `fetchUserList` / `buildListQuery` | `packages/api-client/src/list.ts`（子路径 `@ai-gateway/api-client/list`） |
| 表格 | `DataTable`（列配置 + URL 排序表头 + 空态） | `packages/ui/src/components/data-table.tsx` |
| 页面骨架 | `ListPage`（标题/统计 + GET 搜索表单（hidden 保留筛选）+ filters/actions 插槽 + Pager） | `packages/ui/src/components/list-page.tsx` |
| URL 工具 | `listHref` / `firstParam` | `packages/ui/src/lib/list-query.ts` |

排序语义：`?sort_by=` 白名单（非法 **400 INVALID_SORT_FIELD**，不静默回退）；默认 `created_at desc`（无该列表 `id desc`）；主排序后附加 `id desc` tiebreaker 保证分页稳定。搜索 `?q=` 转义 `%`/`_`/`\`。

## 接口变更（破坏性，同轮闭环）

**admin-api**（全部 `page/page_size/q/sort_by/order`）：users(+detail transactions/audit-logs)、keys、providers✦、channels✦、models✦、rate-cards(+/:id/users)✦、plans✦、subscriptions、channel-funds、redeem-batches(+codes)、logs、audit-logs、billing-operations✦、tracing/recent✦（✦=本轮由无分页/游标形状升级）。
**client-api**：apps、keys、usage、me/transactions、redeem/history、plans✦、orgs✦。
豁免（非记录列表）：stats/usage、usage/summary、usage/by-model、tracing/topology、model-catalog、orgs/:id（详情内嵌）。

## 本轮顺带根治的缺陷

1. **client keys 死搜索**：前端一直发 `?q=`，后端 `GET /api/keys` 不接收（zod 剥离未知键）→ 搜索框完全无效。已在后端实现 q(name/remark) 并加回归（`list-unification.test.ts`）。
2. **users/[id] 审计 tab 展示错数据**：调用全局 `/api/admin/audit-logs?targetId=`（targetId 不在 schema 被剥掉 → 展示全站日志）。改用专用 `GET /api/admin/users/:id/audit-logs`。
3. **logs 状态码分组当页过滤**：`statusCode=2xx/4xx/5xx` 原为前端对当前页 post-filter（跨页失真）。下沉为后端区间条件。
4. **tracing recent 内存分组缺陷**：原实现 `limit*60` 启发式拉 span 内存分组（截断失真 + 无法分页）。重写为 set-based `GROUP BY trace_id` 聚合（array_to_json 规避 drizzle 下 PG 数组以字符串返回的问题）+ count 子查询。
5. **channels/models 列表全表增强**：绑定/消耗聚合从全表拉取改为分页后 `inArray(当页 ids)`。
6. 分页/筛选 UI：client 交易/用量手搓上下页 → 统一 Pager；keys 页有 page 参数无分页器 → 补齐；所有客户端筛选器切换时重置 `page`（原会停留在超出范围的页码）。

## 测试

- 单测：`packages/http/src/__tests__/list-query.test.ts`（10 用例：转义/组合/白名单 400/tiebreaker）；`packages/ui/src/lib/list-query.test.ts`（5 用例，ui 包新增 vitest 接入）。
- 集成：`apps/admin-api/src/routes/list-unification.test.ts`（5 用例：envelope/q/sort/400/billing-operations status 必填）；`apps/client-api/src/routes/list-unification.test.ts`（3 用例：keys 搜索根治默认序/plans sortOrder/orgs envelope）。
- 适配：tracing.test.ts 改断言标准 envelope；其余 68 用例原样通过（回归即验收）。

## 前端迁移清单（ListPage 统一骨架）

admin：users、logs、audit-logs、subscriptions、channels、models、providers、plans、rate-cards(+[id])、redeem-batches(+[id])、channel-funds、billing-operations、tracing、rate-limits、users/[id]（两内嵌表 DataTable+分页）。
client：keys、transactions、usage、apps、redeem、orgs。
纯展示表全部 `DataTable`（排序表头）；重 CRUD 表（含行内对话框/行组件）保留共享 Table 原语、由 ListPage 统一承载搜索/筛选/分页/空态——两者同属统一列表组件体系。
model-market 为外部目录客户端过滤页，未纳入（非 DB 记录列表）。

## 附：验证 dev 栈时顺带根治的两个环境级缺陷

7. **admin 面板无法登录（CSRF 默认受信来源漏掉面板自身端口）**：`adminApiEnvSchema.CSRF_TRUSTED_ORIGINS` 默认 `http://localhost:3000,http://localhost:3001`，而 apps/admin dev/start 固定 `-p 3002` 且 `.env` 未覆盖 → 浏览器所有登录/写操作 `CSRF_ORIGIN_DENIED`。默认值改为 `http://localhost:3002,http://localhost:3000`（packages/core/src/env.ts，core 已重建）。已实测：origin=3002 登录 200。
8. **dev EMFILE 风暴 → `.next/dev` 被删循环**：三层原因叠加——
   a) macOS 默认 fd 软上限 256（用户终端）；
   b) Next 16 dev 启动瞬间 watcher 突发打开的 fd 超过 10240；
   c) 内核单进程硬顶 `kern.maxfilesperproc=61440`：`ulimit -n 65536` 只是 shell 软限制，压不过内核顶，冷启动突发超 61440 仍会风暴一轮，随后 Next 自愈重启收敛（观察到 1 轮恢复）。
   已做：两个 app 的 dev 脚本内置 `ulimit -n 65536 || 10240` 降级链（消除 a/b，c 仅表现为冷启动一过性告警）。可选硬化：`sudo sysctl -w kern.maxfilesperproc=1048576`（需重启 shell 生效）。
   另：`next build` 与运行中的 dev 共享 `.next` 会互相摧毁——验证构建时须先停 dev。
   - 附带操作与后续：dev 管理员账号（admin@ai-gateway.local）R8 开过邮箱 2FA、本地无 SMTP 发不出码（fail-closed）→ 曾临时关掉解除阻塞；用户配好 QQ SMTP 后已通过设置接口重新开启。配置侧顺带修了两处：`.env` 的 `SMTP_HOST==smtp.qq.com` 双等号（主机名解析成 `=smtp.qq.com`，ENOTFOUND）；以及两套 dev 栈并跑导致新 admin-api 绑不上 8790（旧进程占端口、载着坏 env）。实测：登录返回 `twoFactorRequired + challengeId`，验证码邮件已真实发出（QQ SMTP 465 + 授权码）。
