# ADR-0005: 服务端部署产物策略——Docker 全量 bundle,仓内 dev 构建保持 external

> 状态：Accepted（P3 收口补档；总纲 §3.5 必需 ADR 清单第 4 项「服务端部署产物策略」）
> 日期：2026-08-23
> 关联：[project-structure-refactoring.md §7.1/§8](../project-structure-refactoring.md)、
> [docker/Dockerfile.server](../../docker/Dockerfile.server)、各 app/package.json `build` 脚本

## 背景

总纲 §3.5 要求在明确内部 build 时裁决部署产物形态，三选一：

1. **bundle**——单一自包含产物，运行环境零依赖；
2. **external + 裁剪 dist**——产物保留 import 语句，部署时携带裁剪后的 node_modules；
3. **完整 workspace runtime**——部署整个 monorepo + bun install。

当前仓库已经形成的事实（本 ADR 存档追认并固定）：

- **部署面（Docker）**：`docker/Dockerfile.server` 构建段用 `bun build --target=bun
  --format=esm`（无 `--packages=external`）对 app 入口做**全量 bundle**，workspace 源码
  直接打进 dist；运行段仅 `COPY dist`，零 node_modules/零 packages，镜像约 40MB。
  特例：`packages/control-plane` 的 `models-dev-snapshot.json`（require 的 JSON 不内联）
  随 dist 同级分发。
- **仓内 dev/CI 面**：各 app/package 自带 `build` 脚本统一为
  `bun build … --packages=external --outdir=dist`——产物依赖 workspace node_modules
  解析，只服务 turbo 四门验证与本地 `node dist` 冒烟（trace-receiver 有双形态进程冒烟）。

## 决策

**部署产物 = Docker 全量 bundle（形态 1）；仓内 `--packages=external` dev 构建保留，
但不作为部署契约。** 两者并存是刻意的双轨分工，不是漂移：

- 部署单元只有一个镜像产物，运行段零依赖、零符号链接布局坑（bun workspace 的
  node_modules 符号链接在容器内跨层 COPY 是已知坑，全量 bundle 使其整体退场）。
- 内部包按总纲 §7.1 不强制 `.d.ts`、不发布；dev 构建只验证「能产出可运行 JS」，
  不承诺产物可独立分发。

约束（进入后续维护纪律）：

- Dockerfile.server 的 bundle 命令**不得**复用各 app 的 build script（后者带
  `--packages=external`）；两处命令漂移由各自注释互相锚定，改一处必须核对另一处。
- 新增「require 的 JSON/资产」类文件时，必须同步 Dockerfile.server 的 COPY 特例清单。
- 公开发布候选包（api-client/ui/ai）不适用本 ADR——它们按总纲 §7.2/§8 走独立
  `dist + .d.ts + tarball 冒烟`的发布门禁。

## 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| external + 裁剪 node_modules | 需要维护裁剪清单（native 依赖、optional peer、传递依赖），bun 锁文件演化时易漏；镜像可小但工程税持续——否决 |
| 完整 workspace runtime | 部署最简单（COPY 全仓 + install），但镜像大、攻击面大、运行段携带全部源码与 devDependencies——否决 |
| 全仓统一 bundle（连 dev build 也 bundle） | dev 产物无法被 turbo 缓存增量复用，且 external 形态保留了「node dist」与 `bun src` 的行为等价冒烟价值——否决 |

## 影响

- 运行时为 bun（`oven/bun:1.4-alpine`）；未来若切 node 运行段，bundle 形态不变，
  仅换基础镜像与启动命令，届时另开 ADR。
- 镜像体积增长主要来自 vendor SDK（`--packages=external` 在 bundle 段不生效，
  全部内联）；若某重型 SDK 造成体积问题，优先在 ai 包用窄入口延迟加载（总纲 §4.5），
  不回退产物形态。
