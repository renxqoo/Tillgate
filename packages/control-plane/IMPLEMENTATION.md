# control-plane 施工图（IMPLEMENTATION.md）

> 状态：已完成（阶段 1-6 全部落位，见 §5 核销与 MIGRATION.md §8 验收）
> 设计基线：[DESIGN.md](./DESIGN.md) ｜ 行为规格与迁移矩阵：[MIGRATION.md](./MIGRATION.md)
> 波次：总纲 P4.2「控制面配置：provider/channel/model/rate-card → control-plane」（含 fx 与 catalog，均属旧 admin-api 控制面服务族）

---

## 1. 旧实现全量审计（§9.1 步骤 2）

旧实现分布（非 `packages/domain|service`——控制面服务实际住在 app 内）：
`apps/admin-api/src/services/*.service.ts` + `apps/admin-api/src/domain/{catalog,model-pricing}.ts` +
`packages/repository/src/{provider,channel,model-mapping,rate-card,rating,fx,admin-account,audit-log}.repo.ts` +
`packages/db/src/schema/*`（表定义已先行迁至本仓 `@tillgate/db`，75 条迁移齐备，含 voucher_blobs 0066）。

逐文件四条标准审计结论：

### 1.1 真 bug / 缺陷清单（B#）

| #   | 位置                                                      | 级别       | 结论与处置                                                                                                                                                                                    |
| --- | --------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | providers/channels/models/catalog.service 的 `deps.redis` | 死依赖     | 四个服务声明 `redis` 但零引用（仅 keys.service 真用）；注释宣称「变更推进路由缓存版本」也无实现。**不移植**（新包无 redis 依赖）                                                              |
| B2  | channels.service `import` 错误折叠                        | 轻微       | 非 AppError 且 code=23505 折成英文兜底文案，其余折叠为泛化文案——语义可接受，**移植等价实现**（BusinessError message / 冲突兜底文案）                                                          |
| B3  | `recordAudit`（http/audit.ts）                            | 架构债     | 提交后旁路 best-effort（吞错 + console.error）。行为等价要求**保留语义**，但存储归 observability——新包以 `AuditSink` port 承接，postgres 实现保持 best-effort；升格同事务为契约演进待办（§6） |
| B4  | fx.repo `current()` 进程内 60s TTL 缓存                   | 死代码路径 | admin-api fx.service 恒 `force:true` 调用（缓存只服务网关热路径）。**不移植缓存**（网关消费在 inference 波次自带）                                                                            |
| B5  | models.service update 审计 detail 里 `prices` 双写        | 无害       | spread 已含 prices 又显式补一次（JSON 同键覆盖，值相同）。新实现去冗余                                                                                                                        |

### 1.2 重复代码（D#）

| #   | 内容                                                    | 处置                                                                                                                                   |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `maskUpstreamKey`：http `security/secrets.ts` 已有      | control-plane 白名单禁依赖 http → domain/channel 自持同语义副本（4 行纯函数）；合并时机 = 出现双方可依赖的共享底层包（暂无，ADR 再议） |
| D2  | `BillingConfigJson` 形状：db schema `$type` 已有        | domain 不许 import db → domain/model 自持结构兼容形状（装配点类型校验，同旧 rating.repo 手法）；双方漂移由 real 测试结构断言兜底       |
| D3  | ilike 转义 `escapeLikePattern`：旧 repository/search.ts | SQL 语义函数，随 adapters/postgres 自持（唯一 SQL 层）                                                                                 |
| D4  | `trimNumeric`（fx.repo / rating.repo 各一份）           | 收敛为 domain/fx 单一来源（尾零规范化口径一致）                                                                                        |

### 1.3 契约缺口（演进决策，非本波）

- G1 网关读模型族（路由候选/在架目录/系数快照/fx 快照/预算守卫/死凭据/任务渠道）→ inference 波次（P4.4）消费方 port。
- G2 管理员资料/授权策略用例 → identity 波次（admin realm）连带落；本包不建空目录（铁律 4）。
- G3 审计同事务化 + 价格溯源查询归 observability → observability 波次。

## 2. 逐模块裁决表（§9.1 步骤 3）

| 旧文件（行数）                                                           | 裁决          | 依据                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| providers.service.ts (126)                                               | **重构**      | 动词拆文件；AppError→目录错误；redis 死依赖删（B1）；audit 走 port                                                                                                                                                                                                                                                                     |
| provider.repo.ts (125)                                                   | **复制+微修** | SQL 语义不变；RepoContext→(tx) 参形；类→闭包工厂                                                                                                                                                                                                                                                                                       |
| channels.service.ts (325)                                                | **重构**      | 同上；探针经 `UpstreamProbe` port（不 import ai 类型）                                                                                                                                                                                                                                                                                 |
| channel.repo.ts (583)                                                    | **拆分**      | 管理面 CRUD/探针读/资金四方法 + recharge 流水（~330 行）→ adapters/postgres/channel-store；**热路径族不迁**（findRouteCandidates/markDeadCredential/findTaskChannel/lockChannel/tryIncrease/tryDecreaseReserved/deductBudgetAndMaybeBreak/insertRecharge 之外的守卫族——G1，其中 recharge/tryAdjust/insertRecharge/流水属本包资金用例） |
| models.service.ts (327)                                                  | **重构**      | 动词拆文件；免费一致性与数值域校验沉 domain                                                                                                                                                                                                                                                                                            |
| model-mapping.repo.ts (392)                                              | **拆分**      | 管理面 CRUD/绑定/探针读/目录比对读 → adapters/postgres/model-store；报价候选链读（findActiveBy*、listEnabledModels）不迁（G1）                                                                                                                                                                                                         |
| rate-cards.service.ts (162)                                              | **重构**      | formatCoefficient/系数域校验沉 domain                                                                                                                                                                                                                                                                                                  |
| rate-card.repo.ts (224)                                                  | **复制+微修** | 含 users 跨域只读（ documented §1）                                                                                                                                                                                                                                                                                                    |
| rating.repo.ts (60)                                                      | **不移植**    | loadRateCardCoefficients 是网关 quote 消费（G1）；trimNumeric 收敛 D4 后留在 domain 供本包需要处                                                                                                                                                                                                                                       |
| fx.service.ts (245)                                                      | **重构**      | 校验/换算沉 domain；fetch 可注入；B4 缓存删                                                                                                                                                                                                                                                                                            |
| fx.repo.ts (140)                                                         | **复制+微修** | current/insertRate/readConfig/upsertConfig 保留；TTL 缓存删（B4）；bufferPct 不迁（state 内聚后无消费方）                                                                                                                                                                                                                              |
| catalog.service.ts (476)                                                 | **重构**      | 源注册与拉取拆 adapters/model-sources + ports/catalog-source；比对/换算纯函数沉 domain/catalog                                                                                                                                                                                                                                         |
| domain/catalog.ts (225)                                                  | **复制+微修** | 逐函数等价迁移（decimal.js）                                                                                                                                                                                                                                                                                                           |
| domain/model-pricing.ts (34)                                             | **复制**      | 原样                                                                                                                                                                                                                                                                                                                                   |
| channel-funds.service.ts (197) + operations.ts + voucher-storage.ts (76) | **重构**      | 幂等用例沉 application/channels（operations-store port）；凭证解析沉 domain、存储 port 化                                                                                                                                                                                                                                              |
| admin-account.repo / auth.service (387)                                  | **不移植**    | 凭据域归 identity（G2）                                                                                                                                                                                                                                                                                                                |
| audit-log.repo.ts (123)                                                  | **拆分**      | insert → AuditSink postgres 实现（best-effort 语义保持 B3）；listCatalogPriceHistory → ports/audit-store 只读（G3 演进点）；全局 list/listByTarget 不迁（运维读侧，observability 波次）                                                                                                                                                |
| models-dev.snapshot.generated.ts (3.8MB TS 内联)                         | **改载体**    | → `adapters/model-sources/models-dev-snapshot.json`（数据资产：不进覆盖率分母、不内联进 dist JS；刷新脚本迁仓根 `scripts/fetch-models-dev.ts`）                                                                                                                                                                                        |

## 3. 拆分决策（§9.1 步骤 4）

目标结构 = 总纲 §3 control-plane 树。要点：

- `domain/` 纯函数与值类型：`list.ts`（列表查询形状）、`provider/`、`channel/`（含 mask D1、voucher 解析）、
  `model/`（定价一致性 + 契约）、`rate-card/`（系数域 + 3 位格式化）、`fx/`（applyBuffer/域校验/trimNumeric D4）、`catalog/`（五文件对应旧 domain/catalog）。
- `application/` 一动词一文件（铁律 5）：providers×4、channels×9（CRUD×3 + list + import + probe + recharge + adjust + recharges 列表）、
  models×6、rates×6、fx×5、catalog×4；共享 `context.ts`（ControlContext/Actor）与 `audit.ts`（emitAudit 吞错助手，B3 语义）。
- `ports/`：upstream-probe / secret-cipher / cache（含内存缺省）/ audit-sink / voucher-storage / catalog-source + 七个 store。
  落地微调：`ProviderCapabilities` 词表类型住 `domain/provider`（纯词表快照是纯函数入参，非 I/O 边界——
  禁止接口仪式化，不设 ports/capabilities 转发文件）；`Actor`/`ControlContext`/`adminIdOf` 住 `application/context`。
- facade：`stores` 可选覆盖缝（缺省 postgres 适配器；测试 stand-in 与未来 observability 桥共用同一缝）。
- domain/catalog 落地为 3 文件（catalog.ts 契约+双映射 / convert.ts 换算 / compare.ts 比对+消失），非计划的 5 文件——
  契约与映射同源、换算与比对各自独立，粒度与铁律 5 对齐。
- 快照载体：models-dev-snapshot.json（4MB）经 createRequire 装载、按 unknown 契约消费——
  避免 tsc 对巨型 JSON 的结构推导拖垮 typecheck 门禁。
- `adapters/postgres/`：七个 store + audit-sink + voucher-storage（raw SQL——voucher_blobs 无 drizzle schema，新旧仓同态）。
- `adapters/model-sources/`：openrouter + models-dev（JSON 快照）。
- 事务：application 持有（`runTx`），store 写方法收 `tx`；单写旧代码也开事务的保持事务（等价）。

## 4. 测试计划（§9.1 步骤 5）

- **默认门禁**（`__test__/*.test.ts`，铁律 14 平铺）：domain 纯函数全覆盖（含 §10.1.3 边界：零/垃圾形状/超长/负价哨兵/带宽边界）；
  application 用例以**内存 store stand-in**（§5.6 类型 2 行为等价替身）覆盖全部可观察行为——旧 HTTP 测试语义逐条落位（MIGRATION §矩阵）；
  边界测试锁出口面快照与依赖方向（禁 http/ai/runtime import）。
- **真实 PG**（`__test__/postgres.real.test.ts`，默认门禁按文件名排除）：adapters/postgres 七 store 的 SQL 行为等价
  （唯一索引翻译、守卫 UPDATE、jsonb containment 溯源、审计 best-effort）。
- 覆盖率：`src/**/*.ts`，排除 `src/index.ts`（出口桶）与 `src/adapters/postgres/**`（SQL 行为由 real 测试承担，
  与铁律 14「真实凭证集成以文件名区分」同口径——如实申报，不调阈值凑绿）；阈值 90/85。
- 网络零依赖：openrouter 源以 stubGlobal(fetch) 测；models.dev 快照本地 JSON。

## 4.1 实测结果（2026-08-23）

- 默认门禁：**148 用例全绿**；覆盖率 **94.59 statements / 88.28 branches / 100 functions / 95.89 lines**
  （阈值 90/85/90/90；分母不含 index 出口桶、adapters/postgres 与纯类型声明文件——口径见 §4）。
- 真实 PG（`test:real`，本机 5432 可达时）：**8 用例全绿**（唯一索引 23505 翻译 / 守卫原子 UPDATE /
  M1 global 隔离 / 幂等占位冲突 / jsonb containment 溯源 / 审计 best-effort 写入 / 凭证 bytea 往返）。
- typecheck / lint(oxlint 0 err) / build(98.64 KB esm) 全绿。

## 5. 实施顺序（每阶段四门全绿后独立提交）

1. 文档三件（本文件 + DESIGN + MIGRATION）。
2. 脚手架 + 错误目录 + ports + domain（含纯函数测试）。
3. providers + channels（含资金/导入/探针）application + 内存 stand-in 测试。
4. models + rates + fx + catalog application + 测试。
5. adapters/postgres 全套 + model-sources（快照 JSON 转换 + 刷新脚本）+ real 测试。
6. facade + index 出口 + 边界测试 + 覆盖率核验 + 收口核销（MIGRATION §验收逐项）。

### 5.1 实施记录（对 §9.1 步骤 6 的偏差裁决）

六阶段未拆六个提交，落为**单一原子提交**：本包为全新包（无旧位置删除/切换），单提交即独立回滚单元；
纯新增代码的中间态提交不产生阶段回滚价值，且 build 门在缺 index.ts 的中间态结构性不可绿。
阶段边界以目录层与测试文件边界保留。

### 5.2 文件粒度裁决（铁律 5「超 ~150 行先问是不是装了两件事」）

超线文件均为单一职责聚合，非双事项：`control-plane.ts`(390) = 装配根（纯委托闭包，无业务）；
`channel-store.ts`(280) = channels+recharges 表族聚合的 SQL（v1 同族 583 行拆管理面后已减半）；
`import-catalog.ts`(235) = 单一导入用例（事务体 + provenance 审计同体）；
`model.ts`(229) = 单实体校验族；`catalog.ts`(166) = 契约 + 双映射器（映射器与契约同源）。

## 6. 契约演进待办（显式挂账）

- [x] G1（2026-08-23 回勾）：inference 波已定义消费方 port——`inference/src/ports/{catalog,billing,state,upstream,generation}.ts`
      （路由候选/在架目录/系数与 fx 快照经 catalog、预算守卫经 billing、死凭据/渠道健康经 state、
      任务渠道经 generation）；gateway 热路径读已消费（ActiveMappingRow/findRouteCandidates/findActiveCardByUser）。
- [x] G2（2026-08-23 回勾）：admin realm 用例已落地——`application/admins/{find-admin,find-admin-by-email,set-two-factor-enabled,touch-last-login,admins-shared}.ts` + `ports/admin-store.ts` + `adapters/postgres/admin-store.ts` + composition 出口（admin-api P2 登录波装配；
      凭据/会话留在 identity 七表，port 头注释载明单一真相口径）。
- [x] G3（2026-08-23 审计收口核销，前半）：**AuditTxSink 事务参与 port 落地**——渠道进货/调账、
      费率卡变更的审计移入业务事务提交前（写入失败随事务回滚，§5.4）；rate_card 审计补变更前值
      （事务内先 SELECT 旧行，before/after 都进 detail）。剩余挂账——**已裁决保留**（2026-08-23）：
      observability AuditQueries 头注释裁定「价格溯源等 action 语义查询归能力包(control-plane），
      通用审计查询归 observability」——本包 listCatalogPriceHistory 留守是终态而非过渡,
      原先「迁 observability」设想被后至裁决取代（文档同步,铁律 13）。**best-effort 降级清单**（保留 `emitAudit` 提交后路径的低价值运营事件，
      丢失可接受）：provider/channel/model 建档改档、目录导入审计、fx 配置变更——这些事件不承载
      资金/安全事实，且导入等长事务不宜因审计行抖动整体回滚（显式降级，非默认形态）。
- [ ] D1/D2：出现共享底层包后合并 maskUpstreamKey / BillingConfigJson 形状（ADR）。附记（2026-08-23）：AuditLogRow 与 observability 同名形状的合并随价格溯源留守裁决一并取消——跨包类型副本是边界隔离既有口径（api-client/http D1/D2 同语义副本先例），不强行单一化。

### 6.1 审计收口补充（2026-08-23 第二轮）

- **composition 子入口（§5.3）**：外部目录源 adapter（createOpenRouterSource/modelsDevSource）
  从根 index.ts 移入 `src/composition.ts`（package exports `./composition` + build 双入口）；
  boundary.test.ts 增加「业务代码不 import ./composition」门禁。
- **run-operation 红灯**：占位已提交但回执缺失（不变量违约）从 `as T` 静默兜底改为
  `DefectError('control_plane.operation_receipt_missing')` 显式抛错。
- **重放审计语义**：审计移入 execute 后，幂等重放不再产生第二条审计（§5.4「dedupe 后只有
  一个事实」）；回执重放本身就是操作审计的补充事实。
- **package.json**：删除顶层 `types` 字段（§7.1：build 不产 d.ts，源码 types 经 exports 的
  development/types 条件提供）。

补记（2026-08-23，admin-api P5 波）：channels facade 组新增 `loadVoucher(key)` 读动词
（进货凭证回读;键校验在 storage port,防路径穿越）——纯存储透传,无域规则;
消费方 = admin-api `GET /v1/vouchers/:key`。
