# @tillgate/ui 实施文档（IMPLEMENTATION）

> 状态：已完成（波 1 设计系统落地 → 波 2 高优缺口闭合 → 系统重构轮共享模式件收口，
> `docs/ui-system-refactoring.md` §8 核销：UI 118 项测试、96.27/94.36/97.36/96.15 覆盖率；
> 四门全绿）
> 基线：旧仓 `ai-getway/packages/ui`（102 个 ts/tsx 文件 ~10.0k 行：components/ui 62 个
> vendored Radix 组件 + 15 个业务组件 + lib/hooks/server；4 测试文件 136 行 16 用例）——
> 审计结论**不足以支撑复制**（DESIGN §2），零代码复用、全新编写
> 目标：`packages/ui`——纯 React 设计系统（第二发布候选，重构方案 §3/P7）
> 依据：[DESIGN.md](./DESIGN.md)（设计基线）、`docs/ui-system-refactoring.md`（应用层
> 重构规格与核销）、[project-structure-refactoring.md](../../docs/project-structure-refactoring.md)
> §3 禁止范围表 / §P7；用户指令裁决：`shadcn init --preset b0 --template vite` 模版起步

---

## 0. 原则

1. **不是迁移，是重写**：v1 包的依赖耦合（next-themes / next-intl / geist / api-client）、
   paths 旁路 exports、双前端混入业务逻辑，使逐文件审计无法给出「复制无可挑剔」结论——
   裁决整体重写（用户指令），旧件只做行为参照（金额 tone、列表交互模式），不做代码源。
2. **vendored 与手写的边界显式化**：`shadcn add` 生成的 base-nova 组件为 vendored
   （保留上游形态，只做目录归类与相对导入改写；`sonner.tsx` 因引 next-themes 被重写为
   主题可选注入）；五分类目录下的业务组件（data-table / kpi-card / list-panel / row-actions /
   page-header / auth-shell / …）为本包手写。
3. **零写死落法**：金额/日期/数字一律 `create*Formatter({ locale, … })` 工厂注入；交互组件
   文案 prop 必填或可覆盖（i18n 宿主注入）；StatusPill 只收语义 tone，业务状态→颜色映射
   由调用方做。
4. **依赖纯净性机器锁定**：本包及依赖闭包禁止 Next 生态（`next/*`、next-themes、next-intl、
   geist）与 `@tillgate/*` workspace 兄弟包——`test/pack/imports.test.ts` 断言（铁律 11）。

## 1. v1 审计结论（无编号审计发现，见 DESIGN.md §2）

- **依赖耦合 Next**：next-themes / next-intl / geist / `@ai-gateway/api-client` 直接进包，
  组件无法在非 Next 宿主复用（发布候选资格根本不具备）。
- **paths 旁路 exports**：消费方经 tsconfig paths 深导入，exports 边界名存实亡。
- **双前端混入业务逻辑**：lib/list-query、pager-href、auth-url、cookie.client、fonts、
  preferences 均为 Next 路由/会话耦合件，归属 app 而非设计系统。
- 正面资产（行为参照，非代码源）：money-tone 的金额涨跌语义、list-page 的 URL 搜索/
  清除/筛选交互模式、action-toast/confirm-action 的异步反馈语义——v2 以显式契约重写
  （sentiment 声明、onError 不吞错）。
- app 层（admin/client 壳与列表）审计为编号项 **U1-U7**（`docs/ui-system-refactoring.md` §3），
  由系统重构轮逐项裁决消解。

## 2. 逐模块裁决表（v1 → v2；完整映射见 DESIGN §8）

| v1 模块                                                                             | 裁决           | 动作                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| components/ui/*（62 个 Radix vendored）                                             | **全部重生成** | base-nova（Base UI 原语）逐个 `shadcn add`，零复制                                                                                                                                                                                            |
| action-toast / confirm-action / form-dialog                                         | 重写           | feedback/{confirm-dialog,form-dialog} + sonner；异步契约显式化（onError/pending）                                                                                                                                                             |
| data-table / kpi-card / status-pill / money-points / secret-reveal / password-input | 重写           | data/* + feedback/copy-button；受控排序、sentiment 显式、formatter 注入                                                                                                                                                                       |
| shell/（header/sidebar/nav-main）                                                   | 重写           | navigation/sidebar + theme-switcher；account/locale switcher 属 app 会话层不进包                                                                                                                                                              |
| lib/money-tone                                                                      | 重写           | formatting/money.toneOf 纯函数                                                                                                                                                                                                                |
| lib/list-query / pager-href / auth-url / cookie.client / fonts / preferences        | 不移植         | Next 路由/会话耦合，归 app 或独立适配层                                                                                                                                                                                                       |
| hooks/use-lg / use-mobile                                                           | 重写           | hooks/use-media-query（泛化任意查询）/ use-mobile                                                                                                                                                                                             |
| next-themes 主题                                                                    | 重写           | primitives/theme-provider（模版纯 React 本地存储实现）                                                                                                                                                                                        |
| server/server-actions.ts                                                            | 不移植         | 应用装配面职责                                                                                                                                                                                                                                |
| （无对应）                                                                          | 新增           | 第二波：calendar/date-picker(区间)/input-otp/chart(Recharts 封装)/number-field(手写,注册表 404)/form(RHF 胶水)/button-group/native-select/accordion/slider；系统重构轮：layout/{page-header,auth-shell}、data/{list-panel,row-actions}、empty |

## 3. 拆分决策（目录即边界）

1. **五分类 + layout**：`primitives/`（21）`forms/`（20）`data/`（10，含 chart）`navigation/`
   （5）`feedback/`（6）`layout/`（2，系统重构轮新增分类）；`cn` 放 `src/cn.ts`；
   `src/index.ts` 唯一导出面（pack 测试冻结快照）。
2. **exports**：`.`（development→src / import→dist）+ `./styles.css` + 三个目录子路径；
   `sideEffects: ["**/*.css"]`；`components.json` 留包内供后续 `shadcn add`（CLI 在仓库外执行）。
3. **样式系统**：模版 oklch 令牌 + `@theme inline` 基础上**新增** `--success`/`--warning`
   语义色对（模版只有 destructive 不足以表达控制台状态）；字体 `@fontsource-variable/inter`
   自托管；消费端 `@source` 指向本包 src（README 最小示例）。
4. **formatting 工厂**：`createMoneyFormatter`（formatMinor 安全整数范围内精确、超界抛英文
   错）/ `createNumberFormatter` / `createDateFormatter`（相对时间分桶 45s/90s/45m/90m/22h/
   36h/7d，超一周回退绝对日期）；非法输入一律抛错。
5. **组件契约要点**：DataTable 受控优先（三态 asc→desc→清除，无回调退化为静态）；
   ConfirmDialog/FormDialog resolve 关闭、reject 保持打开交 onError（缺省上抛不吞错）；
   KpiCard delta 必须声明 `sentiment`；DatePicker 区间只在 from<to 真跨度时收起；
   NumberField 透传 Base UI 原语签名、空值首步进落 `min`。

## 4. 测试计划（`test/{unit,render,pack}` 分组——用户指令裁决，优先于铁律 14 平铺先例）

| 层          | 文件 → 用例数（核销时点）                                                                       | 内容                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| unit（4）   | cn 4 / formatting-money 11 / formatting-number 5 / formatting-date 10 / hooks 9 = **39**        | Intl 输出预校验精确断言、可控 matchMedia/clipboard 桩 + fake timers                    |
| render（7） | primitives 9 / forms 5 / data 20 / feedback 12 / navigation 6 / layout 4 / controls 14 = **70** | jsdom + Testing Library/user-event 手写组件全交互；vendored 冒烟                       |
| pack（2）   | imports 4 / exports 5 = **9**                                                                   | 依赖纯净性（禁 Next 生态/workspace 包/测试依赖进 src）、导出面冻结、exports 产物存在性 |
| 合计        | 13 文件 **118 用例**（§8 核销口径）                                                             | 覆盖率仅统计手写代码（vendored 与 index 桶不计分母），阈值 90/90/90/85                 |

## 5. 实施顺序（每波独立提交 + 四门）

1. **波 1**（`04b060d`）：模版 init + 五分类落地 + 手写首批组件 + formatting 工厂 +
   hooks + 三层测试骨架 + pack 门禁。
2. **波 2**（`2537565`）：高优缺口闭合——calendar/DatePicker/DateRangePicker、InputOTP、
   Chart 族、ButtonGroup、NativeSelect、Accordion、Slider、NumberField（手写）、
   Form 胶水（react-hook-form 接 Field 原语）。
3. **系统重构轮**（`docs/ui-system-refactoring.md`，U1-U7 消解）：新增共享
   layout/{page-header,auth-shell} + data/{list-panel,row-actions} + empty，更新
   KpiCard/Table 视觉（官方 SectionCards/Nova 基线）；Admin/Client 主应用壳、两套 ListPage、
   筛选器、分页、行操作、Auth 页与 Dashboard 同步重构（应用侧变更，见该文档 §4-§6）。
4. 验收：`docs/ui-system-refactoring.md` §8 核销结果（UI 118 用例；96.27% statements /
   94.36% branches / 97.36% functions / 96.15% lines；Admin 125 / Client 118；
   三包 typecheck/lint/test/coverage 全过、共 361 项测试；Admin/Client 生产构建通过）。

## 6. 验收清单

- [x] 四门全绿；覆盖率 96.27/94.36/97.36/96.15（手写代码口径）≥ 90/90/90/85，未调阈值
- [x] 依赖纯净性机器锁定：src 零 Next 生态 / 零 `@tillgate/*`（pack/imports）
- [x] 导出面冻结快照（pack/exports）；exports 产物存在性验证
- [x] v1 可保留行为参照逐项重写并有测试（金额 tone、受控排序、异步对话框、复制反馈）
- [x] 显式待办留档（DESIGN §1）：carousel/menubar/hover-card/context-menu/resizable/
      aspect-ratio/simple-icon/chat 族——有真实需求再补，后果已声明
- [x] P7 发布前核验清单留档（DESIGN §9）：tarball 双 consumer 验证、"use client" 保留、
      tree-shaking、`private: true` 移除需显式评审——发布时执行
