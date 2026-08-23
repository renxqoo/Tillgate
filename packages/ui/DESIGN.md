# @tokenlens/ui 设计基线（DESIGN）

> 状态：定稿并已实施（v2 `packages/ui` 全新编写）。
> 依据：`docs/project-structure-refactoring.md` §3（目标树 / 禁止范围表）、§P7（第二个公开包准备）、AGENT.md §0 铁律。
> 指令裁决：用户明确要求「直接使用 `pnpm dlx shadcn@latest init --preset b0 --template vite` 模版，不复用旧 ui，完全重写对应组件」。

## 1. 范围与不处理

- **处理**：纯 React 设计系统——primitives/forms/data/navigation/feedback 五类组件、hooks、money/date/number 格式化工厂、主题令牌与样式、测试三件套。
- **不处理**（归属消费方）：
  - 业务取数与路由（apps 自己做；本包禁止依赖 `@tokenlens/api-client`——§3 禁止范围表）；
  - i18n 文案目录（组件文案 prop 必填或可覆盖，宿主注入）；
  - 「业务状态 → 颜色」映射词表（`StatusPill` 只收语义 tone，映射由调用方做——§0.3 零写死）；
  - 本地化 locale/币种默认值（formatting 工厂必填注入，无全局缺省实例——§0.3）。
- **显式待办**（有真实需求再补，组件注册表随时可加）：calendar/日期区间选择、OTP 输入、图表（recharts 封装）、carousel、chat 组件族（bubble/message）。后果：列表页日期筛选、MFA OTP UI、图表页届时需先补组件再迁移对应页面。

## 2. 技术基线（模版裁决）

- 预设 `b0`（style `base-nova`，Base UI `@base-ui/react` 原语，非 Radix）+ Vite 模版 + Tailwind v4 CSS-first 令牌 + `lucide-react` 图标 + `cmdk` + `sonner`。
- 与旧 `@ai-gateway/ui`（Radix + next-themes + next-intl + geist + api-client 依赖，9.7k 行）**零代码复用**；旧包审计结论（依赖耦合 Next、paths 旁路 exports、双前端混入业务逻辑）不足以支撑复制，全部重写。
- vendored 与手写的边界：`shadcn add` 生成的 base-nova 组件为 **vendored**（保留上游形态、只做目录归类与相对导入改写；`sonner.tsx` 因引 `next-themes` 被重写为主题可选注入）；五个分类目录下的业务组件（data-table/kpi-card/…）为本包手写。

## 3. 目录与导出

- 五分类：`primitives`（视觉原子+浮层 19）、`forms`（13）、`data`（7）、`navigation`（5）、`feedback`（6）。
- `src/index.ts` 唯一导出面；`cn` 放 `src/cn.ts`（结构树未列 lib/，cn 是组件编写工具，放顶层与 index 平级）。
- `components.json` 保留在包内供后续 `shadcn add`（aliases 指向 `@/` → `src/*`，与 tsconfig paths 一致）；CLI 安装步骤在仓库外执行（见 README）。
- package exports：`.`（development→src / import→dist）+ `./styles.css` + 三个目录子路径；`sideEffects: ["**/*.css"]`。

## 4. 组件契约要点

- **受控优先**：DataTable 排序状态由调用方持有（服务端排序友好），组件只回调 `onSortChange`（三态：asc→desc→清除）；未提供回调时表头退化为静态。
- **异步对话框契约**：ConfirmDialog/FormDialog 的 `onConfirm/onSubmit` resolve 后自动关闭；reject 保持打开并把错误交给 `onError`（缺省原样上抛，不静默吞错——§0.4）。
- **显式语义**：KpiCard delta 必须声明 `sentiment`（不假设涨=好）；MoneyDisplay 的 `format` 必须注入。
- **可访问性**：PasswordInput/SecretReveal 显隐按钮 `aria-pressed`；CopyButton 复制态切换 aria-label；骨架用 `Spinner role=status`。

## 5. formatting 工厂（零写死落法）

`createMoneyFormatter({ locale, currency, currencyDisplay? })` / `createNumberFormatter({ locale, maximumFractionDigits? })` / `createDateFormatter({ locale, timeZone? })`。要点：

- `formatMinor`（最小单位，如分）：安全整数范围内精确（|units| ≤ 2^53-1），超界抛英文错误而不是给错金额；非整数最小单位抛错。
- 相对时间分桶 45s/90s/45m/90m/22h/36h/7d，超一周回退绝对日期。
- 非法输入（NaN/Infinity/Invalid Date）一律抛错（错误 message 英文——§0.18）。

## 6. 测试策略（test/{unit,render,pack}）

- **目录裁决**：目标树 `test/{unit,render,pack}` 为用户指令直接给定，本包**优先于** AGENT §0.14 `__test__/` 平铺先例（api-client 当时按铁律 14 放弃分组；ui 因 jsdom render 与纯函数分层存在真实差异而分组）。
- unit：formatting 精确断言（Intl 输出预校验）、cn、hooks（可控 matchMedia/clipboard 桩 + fake timers）。
- render：jsdom + Testing Library/user-event，手写组件全交互覆盖；vendored 组件冒烟（完整交互矩阵归上游）。
- pack：依赖纯净性（禁 Next 生态/workspace 包/测试依赖进 src）、导出面冻结快照、exports 产物存在性。
- 覆盖率口径（如实申报）：**仅统计手写代码**（cn/formatting/hooks/10 个手写组件/sonner 重写）；vendored base-nova 组件与 index.ts 桶不计入分母，由 render 冒烟 + pack 导入兜底。阈值 90/90/90/85（仓库标准）。

## 7. 样式系统

- `src/styles/globals.css`：模版主题（oklch 令牌 + `@theme inline` 映射 + sidebar/chart 令牌）**新增** `--success`/`--success-foreground`、`--warning`/`--warning-foreground`（emerald/amber v4 色板，浅 600/500 深 400），供 StatusPill/MoneyDisplay/KpiCard/CopyButton 语义色使用——模版只有 destructive 一个语义色，不足以表达控制台状态。
- 字体：`@fontsource-variable/inter`（自托管，替代旧包 geist 的 Next font）。
- 消费端须 `@source` 指向本包 src（README 有最小示例）。

## 8. 迁移映射（旧 → 新）

| 旧 @ai-gateway/ui                                                                   | 新 @tokenlens/ui                               | 说明                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| components/ui/*（Radix）                                                            | components/{五类}（Base UI base-nova）         | 全部重生成, 零复制                                  |
| action-toast / confirm-action / form-dialog                                         | feedback/{confirm-dialog,form-dialog} + sonner | 异步契约显式化(onError/pending)                     |
| data-table / kpi-card / status-pill / money-points / secret-reveal / password-input | data/* + feedback/copy-button                  | 重写: 受控排序、sentiment 显式、formatter 注入      |
| shell/(header/sidebar/nav-main)                                                     | navigation/sidebar + theme-switcher            | account/locale switcher 属 app 会话层, 不进设计系统 |
| lib/money-tone                                                                      | formatting/money.toneOf                        | 纯函数化                                            |
| lib/list-query / pager-href / auth-url / cookie.client / fonts / preferences        | 不移植                                         | Next 路由/会话耦合, 归属 app 或独立适配层           |
| hooks/use-lg / use-mobile                                                           | hooks/use-media-query / use-mobile             | 泛化为任意查询                                      |
| next-themes 主题                                                                    | primitives/theme-provider                      | 模版自带纯 React 实现(本地存储)                     |

## 9. 后续（P7 发布前核验清单）

- tarball 安装 + Next 与 Vite 双 consumer typecheck/运行验证（§P7 验收）；
- `"use client"` 保留、CSS sideEffects、tree-shaking 验证；
- 从 `private: true` 移除需显式评审（发布白名单机制）。
