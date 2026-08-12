# `@ai-gateway/ui`

**共享 shadcn 原语 + 主题系统**。供 `apps/client` 和 `apps/admin` 两个 Next.js 应用复用。

## 包含内容

- **60 个 shadcn 原语**：button, card, dialog, sheet, drawer, sidebar, table, field, input, input-group, select, combobox, dropdown-menu, popover, tooltip, sonner, badge, breadcrumb, tabs, pagination, navigation-menu, command, kbd, empty, item, marker, attachment, chart, separator, label, toggle, toggle-group, button-group, scroll-area, avatar, accordion, collapsible, hover-card, carousel, alert, alert-dialog, skeleton, spinner, progress, switch, slider, checkbox, radio-group, textarea, native-select, input-otp, direction, resizable, menubar, context-menu, bubble, message, message-scroller
- **主题系统**：自定义 Zustand preferences store + 防 FOUC 的 theme boot script + 17 字体 registry
- **全局 CSS**：`@import "tailwindcss"` + 4 套主题预设（Default / Brutalist / Soft Pop / Tangerine）的 OKLCH 变量
- **tooling 集成**：`components.json` (radix-nova style) 给 shadcn CLI 用

## 用法

apps 通过 `tsconfig.json` 的 paths 别名直接引用源码（无需先编译 `packages/ui`）：

```json
{
  "compilerOptions": {
    "paths": {
      "@ai-gateway/ui": ["../../packages/ui/src/index.ts"],
      "@ai-gateway/ui/components/ui/*": ["../../packages/ui/src/components/ui/*"]
    }
  }
}
```

```tsx
import { Button, Card } from "@ai-gateway/ui/components/ui/...";
import { fmtBalance } from "@ai-gateway/api-client";
```

## 主题

- 默认 light + Geist 字体 + Default preset
- 可在右上角「布局设置」切换 dark mode / 4 个 preset / 17 个字体 / sidebar variant 等
- 设置持久化到 cookie + localStorage（防 FOUC 由 `theme-boot.tsx` 处理）

## 关于 `peerDependencies`

所有第三方依赖（Radix、Base UI、Tailwind 相关）都是 peerDependencies：

```json
{
  "peerDependencies": {
    "@base-ui/react": "^1.7.0",
    "radix-ui": "^1.6.7",
    "@tanstack/react-table": "^8.21.3",
    "recharts": "^3.8.0",
    "react-hook-form": "^7.84.0",
    "zod": "^4.4.3",
    "...": "..."
  }
}
```

宿主应用（client/admin）安装一次，pnpm 自动 hoist 共享。

## 类型检查

```bash
pnpm --filter @ai-gateway/ui typecheck
```

## 升级 shadcn 原语时

1. 在 `next-shadcn-admin-dashboard` 模板里看最新版的 `components/ui/*.tsx`
2. 复制覆盖 `packages/ui/src/components/ui/` 对应文件
3. 跑 `pnpm --filter @ai-gateway/ui typecheck`
4. 跑两个 app 的 typecheck

## 不包含

- ❌ 业务页面
- ❌ 业务数据获取（走 `@ai-gateway/api-client`）
- ❌ admin-api / gateway 客户端调用
- ❌ Server Actions
