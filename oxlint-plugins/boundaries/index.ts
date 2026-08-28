import { definePlugin } from '@oxlint/plugins';

import noDeepImport from './rules/no-deep-import.ts';
import noWorkspaceEscape from './rules/no-workspace-escape.ts';

// 插件 boundaries:包边界门禁,规则以 boundaries/ 前缀引用。
// 包边界的逐文件 import 检查全部由 lint 承担(原 scripts/check-package-boundaries.ts 已移除)。
export default definePlugin({
  meta: {
    name: 'boundaries',
  },
  rules: {
    'no-deep-import': noDeepImport,
    'no-workspace-escape': noWorkspaceEscape,
  },
});
