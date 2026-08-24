# 组件拆分规范（rule/component-split.md）

> 本文档是前端组件的**拆分与编写规范**，与 AGENTS.md 铁律 5（一动词一文件）、铁律 20（UI 优先复用）
> 配套。判例均来自本仓真实代码（`apps/admin/src/features/channels/` 等）。
> 冲突时以 AGENTS.md 为准；本文是它在组件域的展开。

## 1. 组件单一原则

一个组件只回答一个可命名的问题。拆分是否到位的检验：「这个组件叫什么名字，
名字能不能一句话说清它做什么」——说不清就是装了两件事。

- `ProviderRowItem` = 渠道商表格的一行（在册编辑/删除 + 回收站恢复）✅
- `RateLimitEditDialog` = 限流编辑弹窗（受控哑件，值与校验都在编排器）✅
- `XxxContent` 里同时装表格 + 行 + 创建弹窗 + 编辑弹窗 + 表单 ❌（这就是要拆的信号）

推论：**状态住在其最小完整作用域**。编辑弹窗的四个表单值如果只被编排器的 `save` 消费，
就提升到编排器、弹窗做受控哑件（判例：`rate-limits-content/index.tsx` 对
`rate-limit-edit-dialog.tsx` 的 17-prop 全受控设计）；反之状态只被弹窗自己用，
就不要上提（判例：`create-provider-dialog.tsx` 自持 open/pending/form）。

## 2. 目录化标准形态

功能超过两个组件就必须目录化，禁止继续往单文件里堆：

```
features/<domain>/<entity>-content/
├── index.tsx                 导出面 + 外壳（表格壳/空态/tab 编排），re-export 公开组件
├── <entity>-row-item.tsx     行项（一行内聚：状态徽章、行操作菜单、行级弹窗触发）
├── create-<entity>-dialog.tsx   创建弹窗（一动词一文件）
├── edit-<entity>-dialog.tsx     编辑弹窗（一动词一文件；创建与编辑永远分开）
├── <entity>-form.tsx         创建/编辑共享的表单体 + 字段面类型 + schema 构造
└── <entity>-format.ts        纯函数（格式化/解析），无 React 依赖
```

判例：`channels-content/`、`providers-content/`、`rate-limits-content/`、
client 的 `orgs/`（orgs-shared / orgs-section / orgs-members / orgs-quota / orgs-invite）。

规则：

1. **一动词一文件**：`create-` 与 `edit-` 是两个动词，各一个文件，禁止「dialogs.ts」聚合
   （判例：`channel-dialogs.tsx` 已被拆为 `create-channel-dialog.tsx` + `edit-channel-dialog.tsx`）。
2. **index 只做导出面与外壳**，页面只从目录根导入（`@/features/channels/providers-content`），
   页面不感知内部文件名。
3. **共享契约类型不放视图目录**：server actions 也要用的类型放 feature 层
   （判例：`rate-limit-types.ts` 留在 `channels/` 而非 `rate-limits-content/`）。
4. 文件名 kebab-case（`unicorn/filename-case`）；目录名与被替代的旧单文件同名加 `/`，
   页面导入路径零改动。

## 3. 拆分决策

按序自问：

1. **有没有既存组件可复用？**（铁律 20）`@tillgate/ui` 与 `@/components/*` 先查，
   `ConfirmDialog`/`FormDialog`/`RowActions`/`ListPage` 已经覆盖大量弹窗/行操作/列表范式，
   禁止手写替代。
2. **是不是两个动词？** create/edit/import/delete 各自独立成文件。
3. **是不是两种角色？** 表格（壳）与行项（行）分文件；编排器（状态+流程）与哑件（展示）分层。
4. **纯逻辑混在 JSX 里？** 格式化/解析抽成无 React 的 `.ts` 纯函数模块，可独立测试。
5. **超过 ~150 行的组件函数**（oxlint tsx 阈值）不是直接豁免，而是回到 1-4 找该拆的缝。

**不拆的情形**（拆了反而坏）：

- 行项的状态徽章/操作菜单拆出去后要回读行数据七八个字段——行是内聚单元，别碎成格子；
- 强关联多阶段交互（如登录三态流程表单）在无独立 UI 契约裁决前保持整段（存量棘轮）；
- 仅为绕过行数阈值把内聚函数切两段、拆出去后互相 import——禁止（铁律 22⑤）。

## 4. 怎么写好每一类组件

### 编排器（index / *-content）

- 持有跨子组件的状态（editing、tab、pending），子组件经回调上抛（`onEdit(kind, item)`）。
- 保存/校验逻辑住在编排器的**具名函数**里（`openEdit` / `save`），不写内联长闭包。

### 弹窗

- 复用 `FormDialog`（表单模式 / `onSubmitClick` 无表单模式，返回 `true` 关闭、`false` 保持）。
- 受控与否按状态归属：行菜单打开的编辑弹窗用受控 `open`/`onOpenChange`
  （判例：`edit-provider-dialog.tsx`）；页面级创建弹窗自持 open。
- 弹窗挂在 `RowActions` 菜单**外**：菜单点选会卸载面板内容，放里面连弹窗一起被卸掉。

### 表单

- 共享表单体抽 `<entity>-form.tsx`：导出字段面类型（如 `ChannelFormValues`）、
  schema 构造函数（i18n 消息在组件内用 `t` 构造）、`<EntityForm` 组件本体；
  创建/编辑弹窗只装 defaultValues 与提交编排。
- zod schema 的校验消息走目录键，不在 schema 里硬编码文案。

### 处理器与副作用

- **动态 import server actions**：`await import('@/server/x-actions')` 写在动作触发点，
  不做顶部静态导入、不用顶层 await——server actions chunk 只在用户真的点击时加载
  （全仓统一约定，39+ 处判例）。
- **具名局部处理器**：多行 async 处理器一律 `const onTest = async () => {}` /
  `function onSubmit(values) {}` 写在组件 `return` 之前，JSX 侧保持
  `onClick={onTest}` 的干净形态；单行小回调（`onClick={() => setOpen(false)}`）允许内联。
- 动作结果统一走 `useActionResult`/`actionResult` 包装 toast，不裸 `toast.error`。

### 行项

- 一行内聚：状态徽章、操作菜单、行级确认/编辑弹窗都在行组件内；
  删除/恢复用 `ConfirmAction`/`ConfirmDialog`，测活/切换等即时动作用具名 async 处理器。
- 回收站行（`deletedAt != null`）是**只读行**：仅暴露恢复动作，其余动作不可达。

## 5. 拆分操作规程（改动者必读）

1. **逐字搬迁**：拆分是移动不是重写——组件体、className、i18n 键、行为分支原样搬运；
   发现该组件本身有 bug，先修 bug 单独说明，不与拆分混在一个 diff 语义里。
2. **导出面不变**：页面导入路径靠目录 index 保持不变；确需改导入，逐个点名更新并全文
   grep 旧路径确认无残留。
3. **依赖无环**：index → 行项/弹窗 → 表单/纯函数，单向；共享类型与纯函数沉到最底层文件。
4. **门禁**：`bun x oxlint` 0 error、`bun run typecheck` 0 error、`bun run test` 全过、
   `bun run format:check` 通过——拆分不改变任何行为断言，测试原样全绿是硬标准。
5. **顺手清理**：搬迁后检查未用 import（拆分最常见残留）、旧文件删除、
   `export type` re-export 保持类型单一来源（判例：`orgs-content.tsx` 的
   `export type { OrgWithMembers } from './orgs-shared'`）。

## 6. 反例清单（出现即返工）

- 单文件聚合「表格+行+创建+编辑+表单」继续膨胀；
- `*-dialogs.tsx` 聚合两个以上动词的弹窗；
- 共享表单字段面类型在创建/编辑两个文件里各抄一份；
- 页面 deep import 目录内部文件（`.../channels-content/channel-form`）；
- 为了行数达标把行项拆成「左半行/右半行」这类无语义碎片；
- 拆出去的文件互相 import 对方内部状态；
- server-only 类型/模块被顶部静态 import 进客户端组件。
