# api-client 包迁移文档

> 状态：已完成
> 迁移单元：api-client 包整体（transport/错误/分页/DTO/Next BFF 装配），发布候选第一号的结构化落地
> 旧实现：`/Users/wrr/work/ai-getway/packages/api-client`（src 8 文件 1322 行；测试 2 文件 70 行，2 用例组）
> 目标位置：`/Users/wrr/work/Tillgate/packages/api-client`
> 关联：DESIGN.md（契约基线）/ IMPLEMENTATION.md（审计 B1-B2、D1-D3、C1-C3 与裁决表）

## 1. 行为规格基线

旧测试清单（文件 → 用例数）：

| 旧测试                          | 用例                                                                                             | 判定标准                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `src/formatters.test.ts`        | 8 断言组（formatMoney 截断/负零/浮点规避/科学计数法/三方法同口径/无效零展示；积分汇率/两位截断） | **不随迁**：formatters 整体不移植（裁决见 §3），ui 波次携带其测试迁移，行为规格不丢失 |
| `src/api-path-contract.test.ts` | 1（不存在 mapPath；守卫 `path.startsWith('/v1/')`）                                              | 改写进 `__test__/architecture.test.ts`（守卫口径不变）                                |

核心传输行为无旧测试覆盖，本次以 IMPLEMENTATION §4 测试计划补齐（v1 doFetch/session/
locale/ip 的行为规格以新测试首次固化——补测试缺口属本单元验收内容，非可选）。

## 2. 审计结论（引用 IMPLEMENTATION.md，不重复抄写）

- 真 bug：B1（token 双面按 base 字符串比较挑选）、B2（dev 兜底藏共享层）——均重构修复，回归用例锁定。
- 重复提取：D1（locale 内核副本）、D2（trustedClientIp 副本）——发布闭包裁决，锁步向量兜底；D3（formatters）不迁移即不重复。
- 契约缺口：C1（生成链）、C2（v1 README 幽灵导出）、C3（pack 冒烟）——挂 IMPLEMENTATION §6 待办。

## 3. 逐模块裁决表

| 文件                                         | 裁决       | 审计状态 | 动作                                                                                    |
| -------------------------------------------- | ---------- | -------- | --------------------------------------------------------------------------------------- |
| index.ts doFetch/ApiError/守卫               | 重构       | 实测确认 | 拆 `core/client.ts` + `core/api-error.ts`；头合并顺序与编解码语义逐项等价               |
| index.ts outgoingLocale                      | 重构       | 实测确认 | `next/locale.ts`；根入口不再导出                                                        |
| index.ts outgoingUserIpHeader                | 复制       | 实测确认 | `next/forwarded-ip.ts`（含 D2 副本）                                                    |
| index.ts baseOrDefault/memo/伪造 string 出口 | 重构（B2） | 实测确认 | `next/clients.ts` getClientApiBase/getAdminApiBase（函数形态出口，伪造 string 废除）    |
| index.ts isAdminBase                         | 废除（B1） | 实测确认 | 每面工厂显式 getToken                                                                   |
| index.ts getMe/getAdminMe                    | 复制       | 实测确认 | facade 方法（吞错返 null 语义不变）                                                     |
| session.ts                                   | 复制       | 实测确认 | `next/session.ts` 原样（cookie 名/TTL env/secure 口径不变）                             |
| i18n.ts                                      | 重写（D1） | 实测确认 | `next/locale.ts` 内联内核（向量锁步）                                                   |
| list.ts buildListQuery                       | 复制       | 实测确认 | `core/pagination.ts`（查询参数名与跳过规则不变）                                        |
| list.ts run/fetchAdminList/fetchUserList     | 不移植     | 实测确认 | 错误降级展示归页面层（§4）                                                              |
| formatters.ts                                | 不移植     | 实测确认 | 归 ui/formatting（总纲 §3 ui 树）；待办 IMPLEMENTATION §6                               |
| types.ts                                     | 拆分复制   | 实测确认 | `dto/client-api.ts` + `dto/admin-api.ts`；注释性坑位（provider.updatedAt 可缺省等）随迁 |
| package.json zod 依赖                        | 删除       | 实测确认 | 源码零引用                                                                              |

## 4. API 对照

| 旧签名（@ai-gateway/api-client）                                | 新签名（@tillgate/api-client）                                                      | 变化理由                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `apiFetch<T>(path, opts?)`                                      | `createClientApiClient({baseUrl, getToken, getHeaders, fetch}).request/get/post/...` | §7.2：核心经参数接收 baseUrl/fetch/token 获取器；调用方装配一次持 client                                                  |
| `adminFetch<T>(path, opts?)`                                    | `createAdminApiClient(...)...`                                                       | 同上；两面各自持有 token 源（B1 修复）                                                                                    |
| `getMe()` / `getAdminMe()`                                      | `client.getMe()` / `admin.getAdminMe()`                                              | 方法化；吞错返 null 语义不变                                                                                              |
| `ApiError` / `ApiErrorBody` / `ApiFetchOptions`                 | 同名（根入口）                                                                       | 等价；options 增 signal 等 RequestInit 透传，revalidate 口径不变                                                          |
| `outgoingLocale()`（根入口导出）                                | `import '@tillgate/api-client/next'` 的 `outgoingLocale()`                          | Next 耦合隔离至子入口（§3 树）                                                                                            |
| `ADMIN_API_BASE_URL` / `CLIENT_API_BASE_URL`（伪造 string）     | `getAdminApiBase()` / `getClientApiBase()`（./next）                                 | 伪造 string 是脏接口（审计 §1）；函数形态惰性语义保留（B2 口径）                                                          |
| `export * from './session'`（根入口）                           | `./next` 子入口全部 session 动词                                                     | 同 outgoingLocale                                                                                                         |
| `./i18n` 子入口                                                 | `./next`（LOCALES/Locale/resolveLocale/... 全量）                                    | D1 副本；子入口归并                                                                                                       |
| `./list` 子入口 buildListQuery/fetchAdminList/fetchUserList     | 根入口 `buildListQuery` + client `.list()`                                           | 纯函数留根入口；错误降级 run() 归页面层（调用方 catch ApiError 自行渲染，含中文文案——库内抛出 message 一律英文，铁律 18） |
| `./types` 子入口（35+ 接口单文件）                              | 根入口 `dto/client-api` + `dto/admin-api` 再导出                                     | 按面拆分；P6 生成链替换（C1）                                                                                             |
| `./formatters` 子入口                                           | 无（不移植）                                                                         | 归 ui/formatting（D3）                                                                                                    |
| 错误兜底文案 `请求失败 (s)` / `Request failed (s)`（随 locale） | 恒 `Request failed (s)`                                                              | 铁律 18；中文渲染由消费方按 ApiError 处理                                                                                 |
| dependencies `@ai-gateway/http` / `next` / `zod`                | 无运行时依赖；peer `next@^16.3.0`                                                    | 发布闭包（§5.1/§7.3）；zod 零引用删除                                                                                     |

消费面影响（v1 apps 101 文件引用：根 29 / formatters 20 / types 11 / list 10）：apps 波次
切换时按本表逐项替换；formatters 消费点切换到 ui/formatting（该包落地后）。

## 5. 测试迁移矩阵

| 旧测试                                                  | 新去处                          | 动作                                              |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| api-path-contract.test.ts（mapPath 不存在 + /v1/ 守卫） | `__test__/architecture.test.ts` | 改写（断言目标改为 core/client.ts；并入边界门禁） |
| formatters.test.ts                                      | ui 波次                         | 删除+理由（§3 裁决；规格随 formatters 整体移交）  |
| （无）doFetch/session/locale/ip                         | `client.test.ts` 等 8 个新文件  | 新增（IMPLEMENTATION §4；补 v1 测试缺口）         |

## 6. 与目标树/铁律的登记偏差

- 目标树 `test/{core,next,pack}/` → 实际包根 `__test__/` 平铺：铁律 14 后立，先例为全部
  已迁移包；`pack/` 维度挂 C3 待办。
- 目标树 `generated/{client-api,admin-api}/` → 本次不创建：生成链未建（总纲 §2.2/§3.2
  反空壳），手写 DTO 过渡态落 `src/dto/`，P6 整体替换后 `dto/` 同提交删除（C1）。
- 目标树 next/ 三文件 → 实际增补 `clients.ts`（BFF 装配工厂）与 `index.ts`（子出口桶）：
  装配关切无处安放则根入口必破框架无关约束；出口桶为 exports 解析必需。

## 7. 验收（全部满足才算完成）

- [x] 四门全绿：typecheck / lint / build / test（含覆盖率 ≥90/85，数字见提交信息）
- [x] 架构门禁：根入口闭包无 next/、全包无 @tillgate/*、依赖闭包无私有包、exports 恰 `.`+`./next`、双出口词表锁定
- [x] bug 回归：B1（token 只来自本面注入）、B2（baseUrl 必填 + env 装配只在 ./next）用例通过
- [x] 行为对照清单核销：
  - [x] /v1/* 守卫（非 /v1/* 英文报错；无 mapPath）
  - [x] 默认头集 content-type + accept-language + bearer（有 token 时）+ xff（解出时）；调用方 headers 覆盖默认
  - [x] body JSON 序列化（undefined 不发；null 发 "null"）
  - [x] 响应编解码：JSON / 非 JSON→{raw} / 空体→null
  - [x] 错误信封 {error:{message,code,details}} → ApiError(status,code,message,details)；缺 message 英文兜底
  - [x] revalidate：false→no-store；number→next.revalidate 透传
  - [x] getMe/getAdminMe 吞错返 null
  - [x] buildListQuery 参数名与跳过规则（page/limit/sort_by/order；undefined/'' 跳过、0 保留）
  - [x] session 双面 cookie 读写清 has、TTL env、secure=production、httpOnly/lax/path=/
  - [x] locale：cookie→Accept-Language→en；zh 系/en 系归并；q 值；非请求上下文 en（与 http 侧同向量）
  - [x] xff：hops=0 只 socket；hops=N 右数第 N 跳；伪造丢弃；unknown-* 不出站头；headers() 抛不炸（与 http 侧同向量）
  - [x] 基地址：env 优先、惰性 memo、dev 兜底 8081/8082（./next 层）
  - [x] ApiError 类形状（name/status/code/details）

## 8. 回滚方案

- 新包为单一原子提交（新增文件 + 仓库无既有消费方），revert 即整体还原；无 DDL、无数据迁移。
- bun.lock 若含并行会话条目则不随本提交（铁律 15），revert 不受影响。
- 旧仓只读不新增（迁移期纪律）；v1 api-client 在 apps 波次切换验证前保持原样。
