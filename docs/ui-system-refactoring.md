# Admin / Client UI 系统重构

> 状态：已完成，已核销  
> 范围：`packages/ui`、`apps/admin`、`apps/client`  
> 参考：[shadcn/ui apps](https://github.com/shadcn-ui/ui/tree/main/apps/v4)、[shadcn/ui Create](https://ui.shadcn.com/create)
> 精确源码：`/Users/wrr/work/ui/apps/v4/registry/bases/base/blocks/preview-02/cards/recent-transactions.tsx`、`sidebar-nav.tsx`、`registry/styles/style-nova.css`

## 1. 目标与边界

### 1.1 目标

- 以 shadcn/ui 当前 `Base + Nova` 风格为视觉基线，保持 neutral 色系、Inter 字体、Lucide 图标与中等圆角。
- Admin 与 Client 使用同一套页面节奏：无外框 inset Sidebar、48px Header、响应式内容容器、统一 Page Header、KPI 与列表框架。
- 列表交互统一为：URL 搜索、清除搜索、筛选、排序、分页、空态、错误态与紧凑行操作。
- 按钮统一主次层级、尺寸、图标位置、危险态与 pending/disabled 反馈。
- 保持现有 API、Server Action、权限、路由、查询参数和业务行为不变。

### 1.2 不处理

- 不改业务接口、鉴权、计费或数据库结构。
- 不引入新的表格状态框架；当前列表以服务端 URL 状态为主，避免把服务端分页复制到客户端。
- 不照搬 shadcn 演示数据、拖拽排序或演示文案；仅吸收可复用的布局与交互模式。
- 不为视觉目的引入图片或生成式素材。

## 2. 官方基线

从官方 `apps/v4` 与 Create 源码提取以下约定：

1. Dashboard 使用 `SidebarProvider → AppSidebar variant="inset" → SidebarInset → SiteHeader`；应用壳保持平面化，不叠加 Sidebar 与 Inset 的外框和阴影。
2. Header 高度为 48px，内容区以 `@container/main` 驱动响应式布局，页面纵向间距为 16/24px。
3. KPI 使用浅色背景块、tabular numbers、CardAction Badge，信息层级为描述 → 主值 → 辅助说明；Dashboard 图表同样以背景层次替代重复描边。
4. 列表工具栏与数据区分层：筛选/列操作/新增位于表格上方；表格置于独立圆角边框容器；分页位于底部。
5. 表格行操作使用 28px ghost 三点按钮，菜单右对齐；危险操作放在 Separator 之后。
6. Create 使用 Nova 风格、中等圆角、neutral 基色、Inter/继承标题字体、subtle/default 菜单。
7. Auth 使用受控宽度表单、清晰的品牌入口、muted 页面背景与独立 Card，不让表单直接贴在大画布上。
8. `preview-02` 列表使用 Nova Card ring、Table 分隔行、40px muted 图标块、主副信息层级和末列三点菜单。
9. `preview-02` 菜单使用 Card 化 Sidebar、分组标签、组间 Separator 与 muted 激活项。
10. 应用层不复制演示 Card 的外框：侧栏和主内容作为一个连续画布，桌面内容横向留白按 24/32/40px 递增。

## 3. 现状审计

| 编号 | 位置 | 问题 | 裁决 |
| --- | --- | --- | --- |
| U1 | Admin / Client MainLayout | Header 左侧只有 SidebarTrigger 和空分隔线；Sidebar 未使用 inset/rail | 重构为统一应用壳 |
| U2 | 两套 ListPage | 代码重复；搜索仅靠回车且无清除动作；工具栏与 Card header 耦合 | 保留应用侧 URL 适配，统一结构与交互 |
| U3 | Admin DataTable / UI DataTable | 排序语义和空态不一致，缺少 `aria-sort` | 统一可访问排序和表格容器 |
| U4 | 多个筛选器 | 自定义原生 `<select>` 高度、圆角、焦点态与设计系统不一致 | 收敛到 `NativeSelect` 与统一 Filter 组合 |
| U5 | Dashboard KPI | Admin / Client 各有一套 KPI Card，视觉与官方 SectionCards 不一致 | 收敛到共享 `KpiCard` |
| U6 | Auth 页面 | 大屏左右分栏但表单区缺少背景层次和品牌容器 | 使用共享 Auth Shell 视觉规则重构 |
| U7 | 行操作 | 文本按钮、图标按钮与危险按钮混排，部分列表横向占用过大 | 统一为三点 `RowActions`，危险项分组并保留确认流程 |

未发现需要改变业务契约的缺口。现有原语实现已是 Base UI + Nova，全部保留并在其上收敛应用模式。

## 4. 目标结构

```text
packages/ui
├── layout/page-header.tsx       # 页面标题、描述、计数与 actions
├── layout/auth-shell.tsx        # 认证页双区布局
├── data/kpi-card.tsx            # 官方 SectionCards 风格 KPI
├── data/data-table.tsx          # 受控表格、排序、空态、加载态
├── data/list-panel.tsx          # Nova Card 化列表外壳
├── data/row-actions.tsx         # 三点触发器与右对齐菜单
└── navigation/sidebar.tsx       # inset + rail 原语（现有）

apps/admin | apps/client
├── (main)/layout.tsx            # 应用装配、Header actions、内容区
├── app-sidebar.tsx              # 品牌、分组导航、用户菜单
├── list-page.tsx                # URL 搜索/清除/筛选/分页适配
└── feature tables               # 业务列与行操作
```

## 5. 交互契约

### 5.1 搜索与筛选

- 搜索使用 GET，保留除 `q` / `page` 外的筛选参数；提交搜索永远回到第 1 页。
- 有搜索词时显示清除按钮；清除只删除 `q` 与 `page`，保留其他筛选。
- Select 改值时同步 URL 并重置页码；浏览器前进/后退可恢复状态。
- 工具栏在窄屏纵向堆叠，输入框占满宽度；宽屏恢复行内布局。

### 5.2 表格

- 排序表头循环 `未排序 → 升序 → 降序`，并提供 `aria-sort`。
- 表格容器负责横向滚动；Header 使用 muted 背景，行 hover 不改变业务状态。
- 空态、加载态与错误态占满全部列；不能用空白区域代替反馈。
- 分页保留完整查询条件；不可达按钮具有 disabled 语义和视觉反馈。

### 5.3 按钮与行操作

- 页面主要动作使用 default，次要动作使用 outline，工具/行操作使用 ghost + icon-sm。
- 图标按钮必须有 `aria-label` 或可见文本；长文本在移动端可隐藏但保留可访问名称。
- 危险操作保持 destructive 颜色，并继续经过确认对话框；pending 时禁用且显示 Spinner。
- 行操作统一收敛为三点菜单；普通操作在前，危险操作在 Separator 后。
- 从菜单打开 Dialog 时菜单使用非 modal 模式，Dialog 受控并位于菜单外，避免焦点竞争和关闭即卸载。

## 6. 实施与验证

1. 新增共享 PageHeader / AuthShell 并更新 KPI、Table 视觉。
2. 重构 Admin / Client 主应用壳与 Sidebar。
3. 重构两套 ListPage、筛选器、分页和高频列表行操作。
4. 重构 Admin 登录、Client 登录/注册与两个 Dashboard。
5. 执行 `format:check`、UI/Admin/Client typecheck、test、build。
6. 核销：路由与查询参数不变；搜索/筛选/排序/分页/确认行为不变；桌面与移动布局无横向溢出。

## 7. 回滚

- 共享组件、Admin、Client 分文件独立修改，可按层回滚。
- 不包含数据迁移、依赖升级与协议变化；回滚不影响服务端状态。

## 8. 核销结果

- UI：118 项测试通过；Statements 96.27%、Branches 94.36%、Functions 97.36%、Lines 96.15%。
- Admin：125 项测试通过；Statements 95.25%、Branches 88.68%、Functions 96.39%、Lines 97.42%。
- Client：118 项测试通过；Statements 94.41%、Branches 86.75%、Functions 98.96%、Lines 96.93%。
- UI / Admin / Client 的 typecheck、lint、test、coverage 全部通过，共 361 项测试；Admin / Client 生产构建通过。
- Next.js 路由清单保持不变；无 API、查询参数、权限和数据结构变更。
- 仓库不包含 `.openai/hosting.json`，且当前产物为双 Next.js standalone 应用并依赖现有后端服务；本次保持既有 Docker / standalone 部署结构，不创建不兼容的 Sites 单站点配置。
