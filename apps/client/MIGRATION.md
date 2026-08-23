# apps/client 迁移文档（MIGRATION）

> 状态：已完成（行为清单逐项见 §1；渲染/e2e 切片挂 §8）
> 迁移单元：用户控制台全旅程（注册/登录/OAuth → 仪表盘/Key/应用/用量/钱包/订阅/组织/设置 → 登出）这一组可观察行为，不是「一个包」。
> 旧实现：`/Users/wrr/work/ai-getway/apps/client`（63 文件 / 7091 行 / 0 测试）。
> 目标位置：`/Users/wrr/work/TokenLens-v2/apps/client`。
> 关联：DESIGN.md（契约裁决 D-A..F）/ IMPLEMENTATION.md §1（B# 审计）/ 总纲 §3、§9 P5。

## 1. 行为规格基线（可观察行为对照清单）

旧仓无测试——行为等价判定标准 = 下列清单（源自逐文件审计的消费面）＋新仓 `__test__/` 用例。逐项核销状态：✅ 已核销 / ⚠️ 有意变化（见 §4） / ⬜ 待核销。

**认证旅程**
- ✅ 注册：邮箱+密码（+可选 aff 码 `u[0-9a-z]+`）→ Turnstile（CAPTCHA_REQUIRED/INVALID 时自动换票重渲染）→ 两步验证码（6 位）→ 建号自动登录落 cookie → /dashboard；探测失败按开启渲染
- ✅ 登录：密码步 → `{kind:'code_required'}` 进验证码步 / 单步直接落 cookie；`next` 白名单回跳
- ✅ OAuth：providers 发现 → 授权跳转 → 回调页 fragment 取 token → server action 落 cookie → replace 到 next
- ✅ 登出：best-effort 吊销 jti + 清 cookie → /login；改密：成功返回新 token 轮换 cookie
- ✅ 未登录访问 /dashboard/* → 307 /login?next=…（middleware）；会话失效 → requireMe redirect

**控制台读取面**
- ✅ dashboard：余额/今日费用/Key 数/RPM-TPM 四 KPI + 近 14 日费用面积图 + Top10 模型条图（费用/Token/次数/缓存率切换）；后端不可达各卡独立兜底不互炸
- ✅ keys 列表/创建（一次性明文）/编辑（name/remark/RPM/TPM/日限额）/吊销；计费来源徽章（余额 vs 订阅）
- ✅ apps 列表/创建（client_secret 一次性明文）/轮换/停用
- ⚠️ usage 明细分页（from/to/model 过滤）；9 列口径（单位计价分支、plan/payg 双计费、TTFT）
- ⚠️ 钱包流水（⚠️ 游标加载更多，§4-A）；充值（10/50/100/500 预设+自定义、1 元–10 万元、渠道、跳 payUrl）；订单表（状态 0-4 pill）
- ✅ 兑换码：兑换 + 到账额/余额反馈 + 历史
- ⚠️ 订阅：当前卡（额度进度/续费预览/席位扩容）+ 套餐卡（购买/升级差价=总价−剩余价值）+ 组织订阅卡
- ✅ 组织：卡列表（席位/额度进度）+ 成员限额编辑 + 邀请（一次性链接）+ 撤销邀请 + 移除成员 + accept?token=
- ✅ 邀请返佣：邀请码/链接/已邀名单/佣金；功能开关关闭态渲染
- ✅ 设置：账户卡（显示名/邮箱/余额/费率卡/类型/限速/最近登录）+ 改显示名（1-32）+ 改密（8-128）
- ✅ playground：BYOK Key（sessionStorage）同域流式对话、可中止；模型下拉来自公开定价
- ✅ 公开：首页（免费模型广场前 9）/ 定价表（q/free 搜索+分页）/ api-guide（16 端点速查+多语言样例，shiki 高亮，base URL 按请求头推导）
- ✅ i18n：en/zh 无闪变切换；主题 light/dark/system 无 FOUC；品牌/页脚 TokenLens Console

**写入动作**（22 个 server action 全量）：见 IMPLEMENTATION §1 行为规格与 §2 裁决表——逐 action 对应新 `server/actions/*`。

## 2. 审计结论（引用 IMPLEMENTATION.md §1，不重复抄写）

影响本单元：B2/B4/B5/B7/B8/B11/B12/B13/B14/B15/B17 修复或清理（各有回归用例或结构性消除）；B1/B6/B9/B10/B18/B19/B20 保留取舍；D1–D4 提取；G1–G4 契约缺口挂 client-api。

## 3. 逐模块裁决表

见 IMPLEMENTATION.md §2（63 文件分组裁决，含审计状态列）。

## 4. API 对照（旧签名 → 新签名，含行为变化）

| 旧 | 新 | 变化理由 |
|---|---|---|
| `apiFetch(path, {method, body, bearerToken?, revalidate?})` | `createNextClientApiClient()` → `client.{get,post,patch,delete,request}` | facade 显式 token 注入（B1 回归设计）；B7 出站头结构性修复 |
| `fetchUserList<T>(path, {page,pageSize,sortBy,order,extra})` | `client.list<T>(path, {page,pageSize,sortBy,order,extra})` | 同构平移（buildListQuery 语义等价：page/limit 恒有、sort_by+order 成对、extra 跳 undefined/''） |
| `getMe()`（旧包） | `client.getMe()`（facade，吞错返 null） | 布局守卫语义 v1 等价 |
| `{set,get,clear}SessionToken{,Cookie}` / `SESSION_COOKIE` | `@tokenlens/api-client/next` 同名 | cookie 名/TTL/属性 v1 等价 |
| `formatters.{fmtBalance,fmtCost,fmtPrice,formatMoney}`（4 位**截断**） | `features/shared/format.ts formatMoney(v, {locale, currency})`（Intl 2–4 位**四舍五入**） | ui 设计系统口径（D-D）；信息量保留 |
| `formatters.{fmtInt,msToHuman,fmtDateTime,fmtDate}` | `createNumberFormatter` / app `formatDateTime`（DISPLAY_TZ 注入） | B8 时区显式化 |
| `formatters.formatPoints`（元×100） | 移除 | 新契约无积分（D-E） |
| `formatters.unitWord` | `features/usage/unit-word.ts`（app 内表驱动） | 展示词表属 app |
| 旧 types.* | `dto/client-api`（KeyRow/KeyCreated/…） | 单一 DTO 源 |
| `GET /v1/wallet/statement?page&limit&sort_by&order&q`（页码） | `GET ?limit=&beforeLegId=`（游标） | client-api 契约演进（D-A） |
| `GET /v1/usage?…&q&sort_by…` / `GET /v1/keys?…&q` | `?page&limit(±from/to/model)` | strict 契约（D-B，G1） |
| `GET /v1/plans?sort_by=sortOrder&order=asc&page_size=100` | `GET /v1/plans?page=1&limit=100` | B2+G4 |
| `GET /v1/payments/orders`（含 total 页码条） | 同路径，UI 去页码改加载更多 | G3（响应只 rows） |
| 登录/注册响应按 challengeId 存在性判两步 | 按 `kind` 判别联合判两步 | 新契约显式判别（v1 末期已兼容） |
| 旧 ui `lib/list-query`、`lib/auth-url`、`lib/money-tone`、`getInitials`、`ListPage`、`useActionResult`、`ConfirmAction`、`NavMain`、header switchers、theme-boot、ui server action `setValueToCookie` | `server/list-query.ts`、`features/shared/*`、`features/shell/*`、`server/actions/locale.ts`（app 内实现） | P7 ui 纯净化后业务装配归 app（D1） |
| KPI「活跃 Key」=首页 100 条内计数 | KPI「Key 总数」=信封 total | B4（诚实计数） |

## 5. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
|---|---|---|
| （无——旧仓 0 测试） | `__test__/*.test.ts` 17 件（IMPLEMENTATION §4） | 全部新建；行为规格以本文 §1 清单为判定基线 |

## 6. 回滚方案

- 本 app 为纯新增目录 + 根 workspaces 通配（`apps/*`）自动纳入，无共享文件改动；revert 整个提交即完全回滚，不影响后端与包。
- 旧仓 `ai-getway/apps/client` 切换验证前只读不新增。

## 7. 验收（全部满足才算完成）

- 四门全绿：typecheck / lint / test（96 用例；覆盖率 94.36/86.62/98.61/97.38，口径见 IMPLEMENTATION §4/§6）/ build（next standalone）。
- §1 行为清单逐项核销（✅ 或 ⚠️ 带裁决出处）。
- B2/B7 回归用例通过；架构门禁（依赖白名单/词表/env 纪律）通过。
- 生产可部署：`next build` standalone 产物（19 路由 ✓）+ env 词表（CLIENT_API_BASE / GATEWAY_BASE / TRUSTED_PROXY_HOPS / SESSION_TTL_SECONDS / NEXT_PUBLIC_DISPLAY_TZ / DEV_FAKE_ME）在案（apps/client/README.md）。

## 7.1 本次验证边界（如实申报）

- 四门 + 覆盖率 + 边界门禁全绿（数字见 §7）；B2/B7/B12/B8 回归用例通过。
- 浏览器级端到端（真实 client-api + 前端全旅程渲染）属 §8 e2e 切片，本次未执行——
  §1 的 ✅/⚠️ 表示「已实现且经单元/类型/构建验证」，浏览器行为核销随 e2e 切片完成。

## 8. 后续切片（独立跟进，不阻塞本次收口）

- 组件渲染测试（jsdom + testing-library，覆盖表单/弹窗交互）；
- 真实链路 e2e（起 client-api + client 前端做浏览器旅程，归组根 `e2e/client-journey`——注意 spawn 需 `--conditions=development`）；
- G1/G2/G3/G4 契约扩展后的 UI 回补；B18 导出增强；
- Dockerfile/部署编排（等部署 ADR）。
