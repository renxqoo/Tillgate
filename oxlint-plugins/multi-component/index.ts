import { definePlugin } from '@oxlint/plugins';

import noMultiComponent from './rules/no-multi-component.ts';

// 插件 multi-component:规则以 multi-component/ 前缀引用。
// oxlint-plugins 下一个文件夹一个插件:本文件夹即一个插件,入口固定 index.ts,
// 由根 .oxlintrc.json 的 jsPlugins 指向;规则放在 rules/ 下,一条规则一个文件,
// 与就近的 <rule>.test.ts 配套;新增规则在本文件注册一行即可。
export default definePlugin({
  meta: {
    name: 'multi-component',
  },
  rules: {
    'no-multi-component': noMultiComponent,
  },
});
