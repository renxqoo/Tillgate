# @tokenlens/ui

纯 React 设计系统（第二发布候选）。基于 shadcn **base-nova 预设**（`pnpm dlx shadcn@latest init --preset b0 --template vite`）+ Base UI + Tailwind v4，全新编写，不复用旧仓 `@ai-gateway/ui` 任何代码。

**纪律**：本包及其依赖闭包禁止 Next 专有依赖（`next/*`、`next-themes`、`next-intl`、`geist`）与 `@tokenlens/*` workspace 兄弟包 —— 由 `test/pack/imports.test.ts` 机器锁定。

## 结构

```
src/
├── components/
│   ├── primitives/   # 视觉原子与浮层(button/card/dialog/tooltip/...)
│   ├── forms/        # 表单控件(input/select/field/password-input/...)
│   ├── data/         # 数据展示(data-table/kpi-card/money-display/secret-reveal/status-pill/...)
│   ├── navigation/   # 导航(tabs/breadcrumb/pagination/sidebar/theme-switcher)
│   └── feedback/     # 反馈(confirm-dialog/form-dialog/copy-button/toaster/alert/progress)
├── hooks/            # use-media-query / use-copy / use-mobile
├── formatting/       # money / date / number 工厂(locale 等装配注入)
├── styles/           # globals.css(主题令牌 + Tailwind v4)
└── index.ts          # 唯一导出面
test/
├── unit/             # 纯函数: formatting/cn/hooks
├── render/           # jsdom + Testing Library 组件渲染与交互
└── pack/             # 导出面冻结 + 依赖纯净性 + exports 产物存在性
```

## 消费方式

```tsx
// app 的全局 css(任意 React 宿主, Next/Vite 皆可):
@import "tailwindcss";
@import "@tokenlens/ui/styles.css";
@source "../node_modules/@tokenlens/ui/src"; // 让 Tailwind 扫描包内 class
```

```tsx
import { Button, DataTable, createMoneyFormatter, ThemeProvider } from '@tokenlens/ui';

const money = createMoneyFormatter({ locale: 'zh-CN', currency: 'USD' });
```

- React 19 / react-dom 19 为 peer dependency；
- 主题：包内 `ThemeProvider`（纯 localStorage 实现）+ `ThemeSwitcher`；
- 金额/日期/数字：一律 `create*Formatter({ locale, ... })` 工厂注入，组件不创建 formatter（零写死）；
- 文案：交互组件的按钮/aria 文案 prop 必填或可覆盖，i18n 由宿主注入。

## 添加 shadcn 组件

在**仓库外**的临时 Vite 项目执行 `pnpm dlx shadcn@latest add <name>`（风格 `base-nova`），把产物搬入对应分类目录并把别名导入改为相对导入（本仓用 bun workspace，勿让 CLI 直接安装依赖）。

## 门禁

`bunx turbo typecheck lint test build`（包内四门）；覆盖率 `bun run test:coverage`（口径见 `vitest.config.ts`：仅统计手写代码）。
