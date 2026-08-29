# oxlint-plugins

Tillgate 本地 [oxlint JS 插件](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)集合,
把仓库规范(如 [rule/component-split.md](../rule/component-split.md))落成 lint 门禁。

## 目录结构:一个文件夹一个插件

```
oxlint-plugins/
├── package.json            type: module + test/typecheck 脚本(非 workspace,不进 turbo 门禁)
├── tsconfig.json           继承根 tsconfig.base.json,插件 TS 的编辑器与 tsc 检查上下文
├── README.md
├── multi-component/        一个插件一个文件夹,插件之间互不依赖
│   ├── index.ts            definePlugin 汇总入口,meta.name 即规则 ID 前缀
│   ├── rules/              一条规则一个文件 + 就近的 <rule>.test.ts
│   │   ├── no-multi-component.ts
│   │   └── no-multi-component.test.ts
│   └── test/
│       └── utils.ts        测试 harness:临时目录写样本,拉起真实 oxlint 断言
└── boundaries/             包边界门禁(@tillgate/* import 边界,全部由 lint 承担)
    ├── index.ts
    ├── utils.ts            workspace 发现 + exports 查表(按仓库根缓存)
    ├── rules/
    │   ├── no-deep-import.ts / no-deep-import.test.ts
    │   └── no-workspace-escape.ts / no-workspace-escape.test.ts
    └── test/
        └── utils.ts        测试 harness:临时目录搭最小 monorepo
```

新增规则:`rules/` 下新建 `<rule>.ts`,`export default defineRule({ meta, create })`,
再到插件 `index.ts` 的 `rules` 表注册一行,规则 ID 即 `<插件名>/<rule>`（当前 multi-component）。
新增插件:新建 `oxlint-plugins/<name>/` 文件夹(同样的 index.ts + rules/ + test/ 形状),
根 `.oxlintrc.json` 的 `jsPlugins` 加一条路径。

## 插件 multi-component

### multi-component/no-multi-component

判断一个 `.tsx` 文件内是否存在两个及以上的"组件/hook 定义",存在即报告:
`max`(默认 1)之后的每个定义报 `exceed`;嵌套在其它函数体内定义的报 `nested`
(每次渲染重建,React 反模式)。对应组件拆分规范 rule/component-split.md §2。

判定采用 React 社区通行命名启发式,命中以下任一形态即视为一个定义:

- `function X(...) {}` / `const X = function (...) {}` / `const X = (...) => {}`;
- 名字 `useXxx` 视为 hook,大写字母开头(`Xxx`)视为组件;
- 非函数初始化的大写常量(如 `const ONLY_LABEL = '...'`)不计数。

只作用于 `.tsx`;`.ts` 里的纯函数与多个 hook 合法,不受约束。
`const X = memo(() => ...)` 这类包装写法当前不识别(仓库无此形态)。

## 插件 boundaries

包边界门禁的逐文件 import 检查(迁移自已移除的 `scripts/check-package-boundaries.ts`,
边界检查自此全部由 lint 承担)。

### boundaries/no-deep-import

`@tillgate/*` import 必须命中目标包 package.json 的显式 exports:

- 深导入(如 `@tillgate/x/src/...`)与未登记子路径 → `deep`;
- import 不存在的 workspace → `unknown`;
- packages 里的文件 import app 包 → `pkg-to-app`。

AST 解析替代原脚本的正则扫描,`import()` 动态导入同样覆盖;
workspace 定位依赖本仓布局约定(workspace 只有一层 apps/_、packages/_,不嵌套)。

### boundaries/no-workspace-escape

- 相对 import 越出所在 workspace 根 → `escape`(阻止用 `../` 绕过 exports);
- 指向 `apps/` 的深路径 import → `app-path`。

## 接入方式

根 `.oxlintrc.json`:

```jsonc
{
  "jsPlugins": ["./oxlint-plugins/multi-component/index.ts"], // 路径相对配置文件解析
  "overrides": [{ "files": ["**/*.tsx"], "rules": { "multi-component/no-multi-component": "warn" } }],
}
```

`.ts` 插件由宿主原生剥类型加载:Bun 任意版本,或 Node ≥22.18 / ^20.19
(`bun x oxlint` 的 bin 是 node shebang,走 Node 宿主)。
当前 severity 为 `warn`(存量棘轮):`apps/*/src/features` 下尚有约 50 个文件
待按规范拆分,拆完后升 `error`。豁免面:

- `packages/ui/src/components/**`:设计系统原语族,shadcn 一文件一族形态
  (豁免写在 `packages/ui/.oxlintrc.json`,glob 相对该包解析);
- 测试文件:常定义多个 harness/桩组件。

## 测试与类型检查

```bash
cd oxlint-plugins && bun run test        # 临时样本驱动,不在仓库落 fixtures 文件
cd oxlint-plugins && bun run typecheck   # tsc --noEmit(依赖根 devDependencies)
```

测试在系统临时目录生成样本与最小配置(绝对路径指回插件),断言完即清理,
仓库内不保留任何违规样本。
