# ADR-0001：errors 注册表归属与根契约词表

> 状态：Accepted（2026-08-23）
> 关联：[project-structure-refactoring.md](../project-structure-refactoring.md) §3.1/§3.3/§3.5-2/§5.1、[packages/errors/DESIGN.md](../../packages/errors/DESIGN.md)、[packages/errors/IMPLEMENTATION.md](../../packages/errors/IMPLEMENTATION.md)
> 前置：旧仓 `ai-getway/docs/error-system-design.md`（v1 设计定稿，2026-08-22）

## 1. 背景

结构方案 §3.3 要求：实施 `errors` 前必须调整 v1 错误体系方案中的注册表归属——v1 把
151 码的集中注册表放在 `packages/http/src/error-codes.ts`，自称"单一真相"，但 v2 结构下
`http` 认识全部业务码等于反向依赖业务能力，违反 §5.1 依赖白名单（`http` 只依赖 `errors`）。

v1 全量审计（2026-08-23，三份审计报告结论落档 `packages/errors/IMPLEMENTATION.md §2`）
进一步证明集中注册表在 v1 已经双轨失守：三个 app 各自的 `error-map.ts` 合计携带
25+ 个**未登记**的出站自由字符串码；client-api 与 admin-api 的同名表存在六处映射漂移；
注册表内 4 组大小写同码不同义。集中注册表没有能力阻止这些漂移——它只对 `HttpError`
编译期强制，而生产主路径根本不走 `HttpError`。

## 2. 决策

### D1 注册表归属：能力包自有目录 + face 装配（本 ADR 的核心裁决）

- v1「http 集中注册表（全量业务码 + status + 双语文案）」**不移植**。
- 业务错误定义（码、category、双语文案）由各**能力包**自有（`defineErrorCatalog` 目录契约），
  随包分发；app face 在装配期用 `composeErrorCatalogs` 合成全量目录。
- `http` 包只提供 **category → 默认渲染**（默认 status、信封形状、通用文案），并通过
  face override 表表达个别码的出站差异；`http` 永不 import 业务包。
- 根契约包 `errors` 只定义三性、category 闭集、目录**契约**（类型 + 工厂函数），不包含
  任何业务条目。

### D2 身份码：点分命名空间 + 单段小写蛇形，废除大小写双轨

- 身份码形如 `billing.insufficient_cash`：命名空间与 key 均为单段小写蛇形
  （`/^[a-z][a-z0-9_]*$/`），装配期校验。
- v1 的「注册键大写蛇形 === code，wire 输出小写，转换只在 render」**废除**——大小写
  双轨是 4 组同码不同义冲突（E7）与 `toUpperCase()` 回退误命中的直接来源。
- wire 投影（gateway OpenAI 面的蛇形码等）归 face 的 override/渲染表，身份码保持唯一。

### D3 目录定义双语文案必填

`ErrorDefinition` 的 `message`（en）与 `zh` 均为必填字段。结构性消灭 v1「登记缺中文则
静默英文」（E8）与「message 即 code 直达用户」（E9）两类缺陷。语言选择、Accept-Language
解析仍归 face，本包只要求文案存在。

### D4 category 闭集七项：增补 `quota_exhausted`

v1 方案的六项闭集（invalid_input / not_found / conflict / forbidden / rate_limited /
unavailable）无法安放资金族拒绝。审计证据：v1 注册表中 **8 个 402 码**（insufficient_balance、
daily_spend_limit_exceeded、member_daily_limit、member_quota_exceeded、subscription_required、
subscription_quota_exhausted、subscription_forbidden、insufficient_cash）塞进 403 forbidden 或
400 invalid_input 都会误导调用方处理策略。增补：

```text
quota_exhausted   # 资金/额度维度不允许 → 402 语义；不可重试，需充值/换渠道/换计划
```

闭集仍是唯一处理契约；消费方按 category 分派，不按错误类、不按层、不按 status。

### D5 定义不含 status、不逐例覆盖 retryable

- `ErrorDefinition` **不携带 HTTP status**——根契约零协议依赖（结构方案 §3.1 对 `errors`
  的禁止清单），status 默认由 http 的 category 默认渲染给出，face 可 override。
- **不提供** v1 `ErrorSpec.retryable?` 式的逐例覆盖：处理语义由 `handlingOf`
  （nature + category）单点派生。与 `ai` 包 `KIND_MECHANICS` 派生表同构——机制位逐例声明
  是 v1 B8 类误分类的放大器，结构上禁止。

### D6 根命名空间 `errors.*` 保留

`errors.unhandled`（边界处未知 Error）、`errors.non_error`（抛出的非 Error 值）、
`errors.catalog_key_missing` / `errors.catalog_key_invalid`（目录装配防呆）、
`errors.duplicate_namespace`（face 装配重复）。能力包命名空间不得使用 `errors`。

### D7 `ai` ErrorKind 与根契约的关系：两个封闭词表，消费方装配时映射

`ai` 是零内部依赖的永久叶子（结构方案 §5.1），**不得** import `@tokenlens/errors`；
`errors` 也不认识任何厂商语义。两套词表并存的映射（由 `inference` / app face 在装配与
出站翻译时应用）裁决如下：

| ai ErrorKind | nature | category |
|---|---|---|
| network / timeout / upstream_error / overloaded / server_draining / empty_completion | infrastructure | —（环境故障，face 出 5xx 族） |
| rate_limited | business | rate_limited |
| quota_exhausted | business | quota_exhausted |
| invalid_api_key / insufficient_permissions | business | forbidden |
| invalid_request / invalid_response / context_overflow / content_filtered | business | invalid_input |
| model_not_found | business | not_found |
| invalid_config / unsupported_protocol / task_ops_unavailable | defect | —（调用方/装配 bug，细节不外泄） |
| canceled | —（不映射） | 传输生命周期事件，face 自行表达（408/499），不进入三性 |

本表为封闭词表的一部分：`ai` 新增 kind 或 `errors` 调整 category 时必须同步修订本 ADR。

### D8 业务码品牌与绑定构造：目录是唯一签发源（编译期封闭）

初版落地后复评（2026-08-23）发现的最大治理缺口：`BusinessError` 构造器收自由字符串
code，手误码/未登记码（E2 类）在包内无任何拦截，词表封闭只对 category 成立。裁决：

1. **`BusinessCode` 品牌类型**：业务身份码只能由错误目录签发（`code()` / `entry()` /
   `business()`）；自由字符串作为 code 编译不通过。`as BusinessCode` 强转可绕过品牌，
   属刻意违规，由全仓守卫扫描兜底（§4.3，时点不变）。
2. **绑定构造**：`BusinessError` 构造器只收绑定定义（`BusinessErrorInit`：code +
   category + message 三元组），三元组只能整体来自目录 `entry()`——message 与 category
   在构造点无法偏离定义，E8（定制文案杀死本地化）/E9（message 即 code）自此为编译期
   不可能，而非约定。
3. **infrastructure / defect 码不打品牌**：二者没有注册表事实源（按设计走通用渲染），
   无签发源的品牌只是仪式；其命名空间治理随 db/runtime 迁移单元落地。

## 3. 备选方案与取舍

| 备选 | 否决理由 |
|---|---|
| 维持 v1 集中注册表（http 持有全量业务码） | http 反向认识全部业务，违反 §5.1；v1 实证注册表与 app 表双轨漂移且无法拦截（E2/E3/E7） |
| 数字错误码（微信式） | 受众是自家前端；字符串码自解释、可作 i18n 主键（沿用 v1 §1.3 裁决） |
| `DomainError`/`ServiceError` 按层命名 | 层身份回答"谁的错"，处理需要"什么性质的错"；重构搬层会改变错误身份（沿用 v1 裁决） |
| `api-face` 桥包（instanceof 匹配拐杖） | 错误携带数据后无人需要 import 业务包翻译；桥包失去存在理由（沿用 v1 裁决） |
| 大写注册键 + wire 小写转换 | 大小写双轨的实害证据充分（E7），单轨小写 + 点分命名空间更可 grep、无转换层 |
| 定义携带 status（v1 ErrorSpec 形态） | status 是呈现轴不是身份轴；置于根契约则引入协议依赖，置于能力包则 face 差异又要改能力包 |
| retryable 逐例覆盖 | 破坏"category 唯一处理契约"；与 ai KIND_MECHANICS 单点派生的结构经验冲突 |
| 散参构造保留 + 仅靠全仓扫描守卫 | 守卫要等第一个消费者单元才落地（铁律 4），此前窗口内零拦截；且运行时扫描的强度低于编译期封闭（D8 采纳品牌+绑定构造） |
| infra/defect 码同样打品牌 | 无签发源（二者按设计不进目录），品牌沦为 `as` 仪式；治理收益为零 |

## 4. 影响

1. `packages/errors` 按本 ADR + DESIGN.md 落地；v1 `error-system-design.md` 中与 D1/D2
   冲突的注册表章节（§3.2 http 注册表目录、§4.4 集中 ErrorSpec）由本 ADR 取代，三性/
   category/源头分类/错误即数据/内外分际五条铁律继续有效。
2. 消费采用次序（结构方案 §9-P3"按消费者切片"）：http 重组（category 默认渲染 + face
   override）→ db（pg-error 源头分类）→ 各能力包家谱迁移（`extends BusinessError` +
   自有目录）→ app face 装配（compose + override 表）。每个消费者迁移单元各携
   MIGRATION.md；三份 `error-map.ts` 在对应 app 迁移单元中删除。
3. 守卫测试（D8 落地后范围收窄为：目录 namespace 归属校验、`as BusinessCode` 违规扫描、
   face override 差异显式注释、wire 快照）与错误目录文档生成，随第一个真实消费者迁移单元
   落地，不预建空壳（铁律 4）。
4. `errors.unhandled` / `errors.non_error` 出站一律按缺陷渲染通用文案（内外分际）；原始
   message 与 context 只进日志关联 requestId。
