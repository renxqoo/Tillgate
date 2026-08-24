# control-plane 迁移文档（MIGRATION.md）

> 状态：已核销（行为对照逐项落位于 **test**/*.test.ts；验收数字见 §8）
> 迁移单元：控制面配置管理（provider/channel/model/rate-card/fx/catalog 六个垂直用例组，共享装配、审计与密钥面——单元矩阵分节如下）
> 旧实现：/Users/wrr/work/ai-getway（admin-api 服务族 + repository + app 域层，~4.6k 行源 / 65 个旧测试用例）
> 目标位置：packages/control-plane
> 关联：DESIGN.md / IMPLEMENTATION.md（审计 B#/D#/G# 引用彼处，不重复抄写）

## 0. 测试迁移总矩阵（旧文件 → 新去处）

| 旧测试（用例数）                                                                               | 新去处                                                         | 动作                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `__tests__/providers.test.ts` (8)                                                              | `__test__/providers.test.ts`                                   | 改写：HTTP 断言→facade 断言；协议/档案词表经注入 capabilities      |
| `__tests__/channels.test.ts` (10)                                                              | `__test__/channels.test.ts`                                    | 改写：密文/换 Key 复位/导入 best-effort/探针脱敏逐条落位           |
| `__tests__/channel-funds.test.ts` (5)                                                          | `__test__/channel-funds.test.ts`                               | 改写：幂等重放/异参冲突/调账守卫                                   |
| `__tests__/models.test.ts` (16)                                                                | `__test__/models.test.ts`                                      | 改写：免费一致性（直判+合并判）/数值域铁三角/绑定全量替换/探针形状 |
| `__tests__/rate-cards.test.ts` (5)                                                             | `__test__/rate-cards.test.ts`                                  | 改写：含 M1 回归（global 行不抹 model 覆写行）                     |
| `__tests__/fx.test.ts` (4)                                                                     | `__test__/fx.test.ts`                                          | 改写：懒拉/TTL/覆盖冻结/点差/校验（fetch 注入，无真 ECB）          |
| `__tests__/catalog.test.ts` (17)                                                               | `__test__/domain-catalog.test.ts` + `__test__/catalog.test.ts` | 拆分：纯函数原样移植；服务行为改写（mock 源注入）                  |
| `packages/core/__tests__/crypto.test.ts` (5)                                                   | 不迁                                                           | cipher 归 `@tillgate/runtime`（已覆盖，44 用例绿）                |
| `__tests__/coverage-gaps.test.ts` / `security.test.ts` / `e2e-crud-sweep.test.ts` 中控制面部分 | 并入上述各文件                                                 | 改写为对应单元边界用例                                             |

**删除的旧用例**：无（全部行为有落位）。**未移植旧能力**：网关读模型族/管理员凭据/运维审计列表——裁决 G1/G2/G3（IMPLEMENTATION §1.3），非本单元范围。

## 1. providers

**行为规格基线**：非法协议/档案 400 不触库；合法协议原样入库；重名 409；更新/退役 miss 404；软退役 status=1；vendor=null 清除档案；列表 q 命中 name/baseUrl、白名单排序 + id 决胜。
**API 对照**：`service.create(ctx,{adminId,...})` → `controlPlane.providers.create({ctx, ...})`（adminId 改由 ctx.actor 派生）；泛化 409 → `provider_exists`；AppError→目录错误。审计动作名不变（provider.create/update/retire）。

## 2. channels（含资金与探针）

**行为规格基线**：models 白名单 string[] 落库；apiKey 落库即 enc:v1 密文、返回体无密文明文；换 Key 重加密 + 复位运行态；批量导入 best-effort（空/超限 400，供应商 miss 单条失败、同目录名映射绑定、全败 400）；探针真解密、回显仅 keyPreview、异常也是探针结果非 500；列表富化 providerName/boundModels/upstreamConsumed；进货熔断复活 + 幂等重放；调账守卫非负 + 0 行二义消解；凭证 data-URL 白名单与大小限。
**API 对照**：`deps.createTester().probe(...)` → `ports.UpstreamProbe.probeChannel`；`ai.chat` 最小请求 → `UpstreamProbe.probeModel`；`createOperationsUseCase` → application/channels 幂等壳（operations-store port）；422 insufficient_budget → category quota_exhausted。

## 3. models

**行为规格基线**：isFree 全零价（创建直判/更新「旧值∪新值」合并判，部分补丁造不出矛盾态）；数值域铁三角（'1e999'/'1e21'/contextLength 1e30）包边界拒绝不触库；pricingUnit 词表；billingConfig variant 形状（缺 selector/prices 拒绝；null=清除回 {}）；重名 409 带 id 与状态；绑定全量替换/空数组解绑/channelIds 回显缺 [];探针 = 1 条 "1" + max_tokens 1 + maxRetries 0 + 解密密钥 + tokens 汇总；上游失败错误码透传。
**API 对照**：`MappingAdminRow` → domain/model `ModelRecord`（不泄漏 db 行类型）；价格字段平铺不变。

## 4. rates（费率卡）

**行为规格基线**：系数只收精确十进制字符串（0.001–9.999、≤3 位小数；拒 number/'0'/'1.0001'）；建卡同拍落 global 行、回显恒 3 位小数；PATCH coefficient 只碰 global 行（M1）；删除前置无绑定（409 rate_card_in_use）；卡内用户列表；health 自检；列表 global 系数缺行按 '1.000' 兜底回显。
**API 对照**：zod coefficient 规则沉 domain（同一正则与 refine 语义）；`Decimal.toFixed(3)` 格式化沉 domain。

## 5. fx

**行为规格基线**：冷启动懒拉（表无行 force；有行但 TTL 过 4h 非 force）；TTL 内 state/refresh(false) 不重复拉；force 绕过；点差 effective = base×(1+b/100)（覆盖态不叠）；覆盖冻结 base=manual 行、清除后立即补 auto 行（失败容忍显示 null）；汇率/点差越界 400；拉取失败降级 null 不抛；operatorAdminId 落 manual 行。
**API 对照**：`fetchImpl` 注入保留；`FX_SOURCE_ECB/FX_AUTO_TTL_MS` 常量→装配注入参数（铁律 3）；repo 缓存删（B4）。

## 6. catalog

**行为规格基线**：suggestExternalName 去 vendor 前缀与 :free；OpenAI 兼容全量映射（每 token→每百万 ×1e6、负价哨兵剔除、缓存价透传、垃圾形状返回 []）；models.dev 映射（provider/id 唯一化、__meta/$schema 跳过、负价哨兵）；toCny 唯一换算点（CNY 原样、无汇率 null）；三态 diff ±5% 带宽、汇率缺失退化 same、免费口径与亏钱警告；消失检测；comparison 载荷（fx 快照/channelReady/gone）；channel 导入 find-or-create provider/channel（首次缺 key 400、复用不覆盖 key）、重复导入=价格更新确认、外部名被异真实模型占用整体回滚；reference 导入草稿 status=1 不建渠道、重复 skip；价格必填；provenance（目录价×fx→预填→提交）全链审计；TTL 源缓存。
**API 对照**：`CatalogSource` 契约 → ports/catalog-source（fetch/map/护栏）；OpenRouter/models.dev 实例 → adapters/model-sources；快照 TS 内联 → JSON 资产。

## 7. 回滚方案

- 提交形态裁决（对 §9.1 步骤 6 的显式偏差）：本包为**全新包**（旧仓只读不动、无旧位置删除），
  六阶段施工在**单一原子提交**内完成——单提交即回滚单元（revert 整体还原到包前状态），
  中间态拆分提交对纯新增代码不产生独立回滚价值，且无法在缺 index.ts 的中间态保持 build 门绿。
  阶段边界以目录层（domain/ports/application/adapters/facade）与测试文件边界保留。
- 无 DDL 变更（75 条迁移已在 `@tillgate/db` 先行合入；voucher_blobs 表已存在）。
- bun.lock 为多会话共写文件：本包依赖条目落 lock 但**不随本波提交**（并行会话混入，ironlaw 15——协调后收口）。

## 8. 验收（全部满足才算完成）

- [x] 四门全绿（typecheck / oxlint 0 err / 148 用例 / build 98.64 KB）＋ 覆盖率 94.59/88.28/100/95.89 ≥ 90/85/90/90
- [x] 上方 §0–§6 行为对照逐项落位（providers 11 / channels 12 / funds 11 / models 9 / rate-cards 5 /
      fx 5 / domain 54+12 / catalog 13 / sources 3 / facade 4 / gaps 8；真实 PG 另 8）
- [x] 边界测试锁死：出口面 25 值导出快照、依赖方向扫描（禁 http/ai/runtime/app；domain 禁 db；application 禁 adapters）、码表 30 项封闭
- [x] IMPLEMENTATION §6 待办挂账（G1/G2/G3 + D1/D2 合并候选）
