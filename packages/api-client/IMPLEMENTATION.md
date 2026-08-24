# @tillgate/api-client 施工图

> 状态：已完成（§5 单阶段原子落地收口；核销随 MIGRATION.md，最终核销待 apps 波次消费方切换）
> 设计基线：DESIGN.md；迁移单元核销：MIGRATION.md。
> 旧实现：`/Users/wrr/work/ai-getway/packages/api-client`（8 个源文件 1322 行 + 2 个测试文件 70 行）。

---

## 1. 旧实现全量审计（§9.1 步骤 2，逐文件四条标准）

| 文件                            | 行数 | 正确性                                                                    | 契约符合                                                                   | 实现质量                                                        | 依赖方向               | 结论                                      |
| ------------------------------- | ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- | ----------------------------------------- |
| `src/index.ts`                  | 206  | B1/B2（见下）                                                             | 违反目标态：根入口直接 import `next/headers` 与 `@ai-gateway/http/network` | doFetch 本体清晰；`ADMIN_API_BASE_URL` 伪造 string 对象是脏接口 | 双私有依赖 + Next 耦合 | 重构（拆 core/next）                      |
| `src/types.ts`                  | 735  | ✅（两处注释性坑位已标注：provider 无 updated_at、LogRow.requestSummary） | 手写 DTO 现状合法（生成链未建，总纲 §2.2）                                 | 单文件 35+ 接口聚合，可接受（control-plane §5.2 先例）          | 零依赖                 | 拆分复制（client/admin 两面）             |
| `src/session.ts`                | 76   | ✅                                                                        | Next 耦合合法（目标态归 ./next）                                           | ✅                                                              | 仅 next/headers        | 复制（迁 ./next/session.ts）              |
| `src/list.ts`                   | 65   | ✅                                                                        | run() 错误降级属页面 UX，非 transport 职责                                 | buildListQuery 纯函数 ✅                                        | 依赖 index 出口        | 拆分：buildListQuery → core；run() 不移植 |
| `src/formatters.ts`             | 165  | ✅                                                                        | 目标归属 ui/formatting（总纲 §3 ui 树），非 api-client 职责                | ✅（字符串十进制解析不过浮点）                                  | 零依赖                 | 不移植（挂待办，ui 波次）                 |
| `src/i18n.ts`                   | 5    | ✅                                                                        | 转发私有包 `@ai-gateway/http/locale`——发布闭包违规                         | 单一实现诉求正当                                                | 私有依赖               | 重写为同语义副本（D1）                    |
| `src/api-path-contract.test.ts` | 11   | ✅                                                                        | —                                                                          | —                                                               | —                      | 改写（架构测试收编）                      |
| `src/formatters.test.ts`        | 59   | ✅                                                                        | —                                                                          | —                                                               | —                      | 不随迁（与 formatters 同批）              |

`package.json` 审计：`zod` 声明未使用（无 import），删除；`next` 应从 dependencies 降为
peer（./next 专属）；exports 六个子路径按新入口收拢为 `.` 与 `./next`。

### 1.1 真 bug 清单（B#）

| #   | 位置                                               | 级别                                     | 症状                                                                                                                           | 处置                                                                                                                          |
| --- | -------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| B1  | v1 index.ts `isAdminBase` + doFetch token 选择     | 低（当前部署两面 base 不同，未实际触发） | 按基地址字符串相等比较挑选 user/admin 会话源：两面 base 配置相同或 base 缓存后 env 变化时，会把用户 token 发往管理面（或反之） | **重构修复**：每面工厂显式注入 getToken，比较逻辑整体废除；回归测试锁定「token 只来自本面注入」                               |
| B2  | v1 index.ts `baseOrDefault` dev 兜底 + 模块级 memo | 低                                       | 兜底 localhost 藏在共享层（铁律 3：零写死）；Next 构建期 collect page data 加载模块即触发解析                                  | **重构修复**：根入口 baseUrl 必填；env 读取+dev 兜底下沉 ./next/clients.ts 并文档化（生产 compose 显式注入，兜底仅 dev 直跑） |

### 1.2 重复代码（D#）

| #   | 内容                                                                                              | 处置                                                                                   |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | locale 协商内核：v2 `http/src/errors/locale.ts` ↔ api-client `next/locale.ts` 同语义副本          | 接受（发布闭包优先，总纲 §7.3 顺序一）；文件头交叉引用 + 同向量锁步测试（DESIGN §3.3） |
| D2  | `trustedClientIp`：v2 `http/src/network/trusted-client-ip.ts` ↔ api-client `next/forwarded-ip.ts` | 同 D1；hops 语义注释逐字保留                                                           |
| D3  | formatters（api-client ↔ 未来 ui/formatting）                                                     | 本次不迁移即不重复；ui 波次单点落位                                                    |

### 1.3 契约缺口（演进决策，非本次实施）

- C1：~~OpenAPI 生成链未建~~——**已兑现**（2026-08-23,DESIGN §3.4 定稿并落地）:
  admin-api `src/http/openapi/` registry（请求面引用 contracts zod 实例、响应面 wire
  zod 声明）→ `apps/admin-api/generated/openapi.json`（OpenAPI 3.1,产物入库）→
  本包 `scripts/generate-dto.ts` 生成 `src/dto/admin-api.generated.ts`（同路径覆盖换轨,44 个
  具名导出保名兼容,`__test__/generated-dto.test.ts` 锁头标记/逐字节重渲/导出集合快照）。
  类型差异清单见 DESIGN §3.4.5（响应面零差异;请求体面为 contracts 真相对手写快照
  欠账的修正,消费方零影响——apps/admin 不 import *Body 型）。
- C2：v1 README 声称导出 `REDEEM_ERROR_MESSAGES`，types.ts 并不存在——v1 文档漂移，
  新 README 按实际导出重写。
- C3：`pack/` tarball 冒烟测试（v1 树 test/pack）属发布改造，P6 交付（待办挂 MIGRATION §7）。

---

## 2. 逐模块裁决表（§9.1 步骤 3）

| v1 文件/符号                                             | 裁决           | 新去处                                                                          |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| doFetch 传输本体（URL 拼接/头合并/JSON 编解码/错误信封） | 重构           | `src/core/client.ts` createHttpClient                                           |
| ApiError / ApiErrorBody                                  | 复制           | `src/core/api-error.ts`                                                         |
| /v1/* 路径守卫                                           | 复制           | `src/core/client.ts`（回归测试保留 v1 断言口径）                                |
| Paginated / buildListQuery / ListFetchOptions            | 复制 + 拆分    | `src/core/pagination.ts`                                                        |
| list.ts run()/fetchAdminList/fetchUserList               | 不移植         | 页面层错误降级归调用方（MIGRATION §4）                                          |
| outgoingLocale                                           | 重构           | `src/next/locale.ts`（根入口不再导出）                                          |
| outgoingUserIpHeader / trustedClientIp                   | 复制（D2）     | `src/next/forwarded-ip.ts`                                                      |
| session.ts 全量                                          | 复制           | `src/next/session.ts`                                                           |
| i18n.ts（http/locale 转发）                              | 重写（D1）     | `src/next/locale.ts` 内联内核                                                   |
| baseOrDefault/惰性 memo/`*_API_BASE_URL` 伪造 string     | 重构（B2）     | `src/next/clients.ts` getClientApiBase/getAdminApiBase                          |
| isAdminBase token 双面挑选                               | 废除（B1）     | 每面工厂显式 getToken                                                           |
| types.ts                                                 | 拆分复制       | `src/dto/client-api.ts`（用户面 19 型）/ `src/dto/admin-api.ts`（管理面 33 型） |
| getMe / getAdminMe                                       | 复制（方法化） | 两面 facade                                                                     |
| formatters.ts + 其测试                                   | 不移植         | ui 波次（待办）                                                                 |
| api-path-contract.test.ts                                | 改写           | `__test__/architecture.test.ts` 路径守卫断言 + 边界门禁                         |

## 3. 拆分决策（§9.1 步骤 4，均引用审计证据）

1. **core / dto / facade / next 四段**：证据 = v1 单文件混合 Next、私有依赖与传输本体
   （§1 审计表 index.ts 行）；目标树（总纲 §3）已裁决该形状。
2. **AdminTransactionRow 跨面继承**：`extends TransactionRow` 保留 import（同一真相只定义
   一次，铁律 3），dto/admin-api.ts import dto/client-api.ts 仅此一处。
3. **>150 行文件审计**：`dto/client-api.ts`（~240 行）为
   纯声明聚合，单一职责 = 一面 wire 形状快照；`core/client.ts`、`next/locale.ts`、
   `next/forwarded-ip.ts` 接近上限但单一职责（transport / 语言协商 / XFF 信任）。
   control-plane §5.2 同口径。（换轨后 admin 面为生成物 admin-api.generated.ts——豁免口径见 DESIGN;原「AdminTransactionRow extends TransactionRow 跨面继承」随生成物独立声明而消亡,client 面零改动。）
4. **测试布局**：目标树 `test/{core,next,pack}/` 与铁律 14（包根 `__test__/` 平铺）冲突，
   按既有全部包先例执行铁律 14；`pack` 维度挂待办（C3）。偏差记 MIGRATION §6。

## 4. 测试计划（§9.1 步骤 5）

| 测试文件                                   | 覆盖                                                                                                                                                                                                                                                                                                       | 关键断言来源                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `architecture.test.ts`                     | 边界门禁：src/**（除 next/）无 `next/` import；全包无 `@tillgate/*`；package.json 依赖闭包；exports 恰 `.`+`./next`；根/next 出口运行时词表逐一锁定                                                                                                                                                       | 铁律 11、DESIGN §5；收编 v1 api-path-contract  |
| `client.test.ts`                           | 注入 fake fetch：URL 拼接、默认头集（content-type/accept-language/bearer/x-forwarded-for）、bearerToken 覆盖 getToken、headers 覆盖默认、body JSON/null/undefined、非 JSON→{raw}、空体→null、错误信封三字段、缺 message 英文兜底、revalidate→cache/next 透传、路径守卫英文报错、RequestInit 透传（signal） | v1 doFetch 行为 + B1 回归（token 只来自注入）  |
| `pagination.test.ts`                       | buildListQuery：默认 page=1、limit、sort_by+order 缺省 desc、extra 跳过 undefined/''、数字 0 保留；list() 信封解析                                                                                                                                                                                         | v1 list.ts 行为规格                            |
| `client-api.test.ts` / `admin-api.test.ts` | facade 工厂委托 core、getMe/getAdminMe 吞错返 null、DTO 再导出编译面                                                                                                                                                                                                                                       | v1 getMe/getAdminMe                            |
| `next-session.test.ts`                     | mock next/headers：读/写/清/has 双面、HttpOnly+sameSite+secure(NODE_ENV)+maxAge(SESSION_TTL_SECONDS 覆盖)                                                                                                                                                                                                  | v1 session.ts                                  |
| `next-locale.test.ts`                      | 内核向量表（与 http locale.test 同向量，D1 锁步）、outgoingLocale cookie→头→en、非请求上下文兜底 en                                                                                                                                                                                                        | v1 i18n/index.ts + http 侧向量                 |
| `next-forwarded-ip.test.ts`                | hops 语义矩阵（0 不信代理头 / N 右数第 N 跳 / 伪造丢弃 / socket 回落 / unknown-* 兜底，与 http network.test 同向量，D2 锁步）、outgoingUserIpHeader unknown-* 不带头、headers() 抛→{}                                                                                                                      | v1 index.ts outgoingUserIpHeader + http 侧向量 |
| `next-clients.test.ts`                     | env 基地址显式/惰性 memo/dev 兜底、TRUSTED_PROXY_HOPS 逐调用读、装配出的 client 端到端（mock next/headers + fake fetch）注入 accept-language/bearer/xff                                                                                                                                                    | v1 baseOrDefault 行为 + B2 回归                |

覆盖率口径（vitest.config exclude 如实申报）：`src/index.ts`、`src/next/index.ts`（纯再导出桶）、
`src/dto/**`（纯类型声明，零运行时语句）不计分母；其余全部计入，阈值 90/85。
B1/B2 回归用例名带编号与症状（§10.1）。

## 5. 实施顺序（§9.1 步骤 6）

单阶段原子落地（新包为 revert 单元，control-plane §9.1 步骤 6 裁决先例）：
package.json/tsconfig/vitest → core → dto → facade/根入口 → next 子入口 → 测试 →
四门 + 覆盖率 → README → oxfmt → 提交。

## 6. 待办（显式挂账，铁律 4）

- ~~ui 波次：formatters.ts + formatters.test.ts 迁 ui/formatting（D3）~~——**已兑现**
  （ui 波次落地 `packages/ui/src/formatting/{date,money,number}.ts` 并经根出口导出；
  本包 formatters.ts 未随迁，无双轨）。
- ~~P3/P6：OpenAPI 生成链替换 dto/（C1）~~——admin 面**已兑现**（§1.3 C1）;
  client 面 registry 归 client-api 后续波（DESIGN §3.4.6 挂账,dto/client-api.ts 仍是
  该面唯一事实源）。
- P6：pack tarball 冒烟（C3）；dist 声明产物与发布白名单评审（总纲 §7.2/§8）。
- apps 波次：apps/client、apps/admin 的 BFF 装配切换到 createNextClientApiClient/
  createNextAdminApiClient（本包无仓内消费方，属既有分波纪律，非本单元范围）。
