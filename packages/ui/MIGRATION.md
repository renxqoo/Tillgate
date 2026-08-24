# @tillgate/ui 迁移文档（MIGRATION.md）

> 状态：已核销（核销依据 = [docs/ui-system-refactoring.md](../../docs/ui-system-refactoring.md)
> §8：UI/Admin/Client 三面 361 项测试全过、覆盖率达标、路由与查询参数不变、生产构建通过）
> 迁移单元：前端呈现层基线——React 设计系统**整体替换**（Radix → Base UI base-nova）+
> Admin/Client 应用壳与列表交互收敛（页面节奏 / 列表 / 按钮层级 / Auth / Dashboard）。
> **不是**业务行为迁移：API、Server Action、权限、路由、查询参数、数据结构显式不变
> （ui-system-refactoring §1.1 目标即「保持不变」）
> 旧实现：`/Users/wrr/work/ai-getway/packages/ui`（102 个 ts/tsx 文件 ~10.0k 行：
> components/ui 62 个 vendored Radix + 15 个业务组件 + lib/hooks/server；4 测试文件
> 136 行 16 用例）+ `apps/admin`（95 文件 ~12.5k 行）/ `apps/client`（65 文件 ~7.2k 行）
> 的 MainLayout / ListPage / 筛选器 / 行操作（U1-U7 审计对象；两 app 仓内零单测）
> 目标位置：`packages/ui` + `apps/admin` + `apps/client`
> 关联：[DESIGN.md](./DESIGN.md)（设计基线 + §8 迁移映射）、[IMPLEMENTATION.md](./IMPLEMENTATION.md)
> （裁决与实施顺序）、[project-structure-refactoring.md](../../docs/project-structure-refactoring.md)
> §3 禁止范围表 / §P5（两 Next app）/ §P7（第二发布候选）

## 1. 行为规格基线

- **旧测试清单**（v1 `packages/ui/src/lib/`，文件 → 用例数）：
  `auth-url.test.ts`（6）/ `dashboard-navigation.test.ts`（2）/ `pager-href.test.ts`（3）/
  `list-query.test.ts`（5）——共 4 文件 16 用例。
- **apps 侧 v1 零单测**——行为等价的判定标准是 ui-system-refactoring §1.1 不变量
  （现有 API、Server Action、权限、路由、查询参数和业务行为不变）+ §5 交互契约
  （搜索/筛选/表格/按钮与行操作），核销证据为 §8（见 §7）。
- **显式删除的用例及理由**：上述 4 件 lib 测试**全部不移植**——被测对象（auth-url /
  pager-href / list-query / dashboard-navigation）是 Next 路由与会话耦合件，裁决
  「不移植、归 app 或独立适配层」（DESIGN §8；机制已裁决移除 ≠ 功能缺失）。
  新行为规格全部为 v2 新写测试（§5 矩阵）。

## 2. 审计结论（引用，不重复抄写）

- **包级**：无编号审计发现，见 [DESIGN.md](./DESIGN.md) §2——v1 依赖耦合 Next
  （next-themes/next-intl/geist/api-client）、paths 旁路 exports、双前端混入业务逻辑，
  逐文件审计无法支撑「复制无可挑剔」，裁决**零代码复用、全部重写**（用户指令）。
- **app 层**：U1-U7（ui-system-refactoring §3 现状审计）——U1 应用壳空壳、U2 两套
  ListPage 重复且搜索无清除、U3 排序语义与空态不一致缺 `aria-sort`、U4 自定义原生
  select 漂移、U5 双套 KPI Card、U6 Auth 页缺背景层次、U7 行操作混排——逐项裁决于该文档
  §3 表（全部「重构/收敛」方向，无业务契约缺口）。
- **正面资产（行为参照）**：money-tone 金额语义、list-page URL 交互模式、异步反馈语义
  ——以显式契约在 v2 重写（IMPLEMENTATION §1）。

## 3. 逐模块裁决表

| 旧文件/模块（v1）                                                                                                 | 裁决           | 审计状态     | 动作                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| components/ui/*（62 个 Radix vendored）                                                                           | **全部重生成** | DESIGN §2    | base-nova（Base UI）逐个 `shadcn add`，零复制                                                                        |
| action-toast / confirm-action / form-dialog                                                                       | 重写           | —            | feedback/{confirm-dialog,form-dialog} + sonner（onError/pending 显式契约）                                           |
| data-table / kpi-card / status-pill / money-points / secret-reveal / password-input                               | 重写           | U3/U5        | data/* + copy-button；受控排序 + `aria-sort`、sentiment 显式、formatter 注入                                         |
| shell/（header/sidebar/nav-main）                                                                                 | 重写           | U1           | navigation/sidebar（inset + rail 原语）+ 主题件；switcher 归 app                                                     |
| lib/money-tone                                                                                                    | 重写           | —            | formatting/money.toneOf 纯函数                                                                                       |
| lib/{list-query,pager-href,auth-url,cookie.client,fonts,preferences}                                              | 不移植         | DESIGN §2/§8 | Next 路由/会话耦合，归 app 或独立适配层（其 4 件测试随之删除，§1）                                                   |
| hooks/use-lg / use-mobile                                                                                         | 重写           | —            | hooks/use-media-query（泛化任意查询）/ use-mobile                                                                    |
| server/server-actions.ts                                                                                          | 不移植         | —            | 应用装配面职责                                                                                                       |
| apps/admin·client MainLayout（U1）/ ListPage×2（U2）/ 筛选器（U4）/ 行操作（U7）/ Auth（U6）/ Dashboard KPI（U5） | 重构           | U1-U7        | 共享 page-header/auth-shell/list-panel/row-actions/kpi-card 收敛；应用侧保留 URL 适配（ui-system-refactoring §4-§5） |
| （无对应）                                                                                                        | 新增           | —            | 第二波 9 组件 + 系统重构轮 layout/data 增件（IMPLEMENTATION §2 末行）                                                |

## 4. API 对照

| 旧签名/形态                                           | 新签名/形态                                                               | 变化理由                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `@ai-gateway/ui` 深导入（paths 旁路）                 | `@tillgate/ui` 唯一导出面 + `./styles.css` 子路径                        | exports 边界可执行（pack 测试冻结）     |
| Radix 原语 + next-themes 主题                         | Base UI（`@base-ui/react`）+ 纯 React ThemeProvider                       | b0 预设裁决；去 Next 耦合               |
| `moneyTone(value)`（隐含涨=好）                       | `createMoneyFormatter(...).toneOf` + KpiCard `sentiment` 必填             | 零写死 + 不假设涨跌语义                 |
| `ListPage`（内置取数 + 回车搜索）                     | 应用侧 list-page.tsx（URL 搜索/清除/筛选/分页适配）+ 包内 list-panel 外壳 | 取数归 app；交互契约统一（§5 交互契约） |
| `action-toast` / `confirm-action`（Promise 任意形态） | ConfirmDialog/FormDialog：resolve 关闭、reject 开 + onError               | 异步契约显式化，不静默吞错              |
| `use-lg()` 断点                                       | `useMediaQuery(query)`                                                    | 泛化                                    |
| v1 无（表单胶水散在 app）                             | Form/FormField/FormControl（react-hook-form 接 Field 原语）               | 校验器由调用方自选                      |
| geist 字体（Next font）                               | `@fontsource-variable/inter` 自托管                                       | 去 Next 专有依赖                        |

## 5. 测试迁移矩阵

| 旧测试                              | 新去处                                                               | 动作（移植 / 改写 / 删除+理由）                         |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `auth-url.test.ts`（6）             | —                                                                    | 删除：被测件 Next 会话耦合不移植（DESIGN §8）           |
| `pager-href.test.ts`（3）           | —                                                                    | 删除：同上（URL 组装归 app 侧，app 波自测）             |
| `list-query.test.ts`（5）           | —                                                                    | 删除：服务端 URL 状态归 app；包内列表交互由 render 层锁 |
| `dashboard-navigation.test.ts`（2） | —                                                                    | 删除：导航数据属 app 会话层                             |
| （apps 侧无单测）                   | UI `test/{unit,render,pack}` 13 文件 118 用例；Admin 125；Client 118 | 新增规格（§8 核销口径，共 361 项）                      |

## 6. 回滚方案

- 波 1（`04b060d` 设计系统）与波 2（`2537565` 缺口闭合）各自独立提交、独立可 revert；
  系统重构轮的共享件与 Admin/Client 变更按层分文件独立修改、可按层回滚
  （ui-system-refactoring §7；该轮提交由其波次收口，铁律 15——不与他人工作区文件混提）。
- 本迁移不含数据迁移、依赖升级与协议变化，回滚不影响服务端状态。
- 新包是加法（旧仓只读不动）；Admin/Client 的 v2 app 迁移本体（P5 两 app 波：
  `431593f` admin / `1daa6a5` client）与本单元分层——回滚呈现层基线不触碰 API 层与数据层。

## 7. 验收（全部满足才算完成；核销记录 = ui-system-refactoring §8）

- [x] UI / Admin / Client 的 typecheck、lint、test、coverage 全部通过，共 **361 项测试**
      （UI 118：96.27% statements / 94.36% branches / 97.36% functions / 96.15% lines；
      Admin 125：95.25/88.68/96.39/97.42；Client 118：94.41/86.75/98.96/96.93——
      全部 ≥ 90/85/90/90，未调阈值）
- [x] Admin / Client 生产构建（Next.js standalone）通过
- [x] **Next.js 路由清单保持不变**；无 API、查询参数、权限和数据结构变更（§1.1 不变量核销）
- [x] 交互契约逐项核销（ui-system-refactoring §5）：URL 搜索/清除保留筛选、Select 改值
      重置页码、排序三态 + `aria-sort`、空/加载/错误态占满全列、分页保留查询条件、
      危险操作确认 + pending Spinner、三点行操作菜单（Dialog 非 modal + 菜单外受控）
- [x] 依赖纯净性机器锁定：包闭包零 Next 生态 / 零 workspace 兄弟包（pack/imports）
- [x] 部署结构维持既有 Docker / standalone 双 Next 应用（§8 末条：不创建 Sites 单站点配置）
- 待核销（非本单元，显式留档）：P7 发布前核验清单（tarball 双 consumer、tree-shaking、
  `private: true` 移除评审，DESIGN §9）——发布动作触发，不阻塞本迁移单元核销结论。
