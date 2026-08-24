# 管理后台「系统管理」模块（IMPLEMENTATION）

> 状态：**已核销**（2026-08-24）。小功能单文档（AGENT.md 铁律 13）。
> 本文档兼记同期导航信息架构调整（§关联调整）。

## 需求与裁决

管理后台 sidebar 新增「系统管理」分组，收纳：

| 条目 | URL | 权限 | 来源 |
| --- | --- | --- | --- |
| 管理员 | /dashboard/admins | admins:read | 自「资源管理」组迁入（RBAC 波次新增） |
| 安全设置 | /dashboard/settings | settings:read | 自「资源管理」组迁入——该菜单文案本就是「安全设置」（页面装 2FA/TOTP/计费时区） |

- 分组置于导航末位（id 6，审计组之后）——系统管理类入口沉底是管理台惯例；
- **不新建页面、不改任何页面内容与守卫**——纯导航信息架构重组；
- 图标沿用：管理员 UserCog、安全设置 ShieldCheck。

## 已知张力（挂账，非本次范围）

「安全设置」页混装**个人安全**（2FA/TOTP——每个管理员自身域，语义上应无权限门槛）与
**计费时区**（平台配置，settings:read 恰当）。当前整页挂 settings:read 守卫（RBAC 波次
D5 方法分派的既成结果）——support 角色无法管理自己的 2FA/TOTP。拆页（个人安全独立成
self-realm 页 + 计费配置留 settings 域）是后续波次的小活，触发条件：有非超管角色实际
使用后台时。

## 验证

- `__test__/coverage-completions.test.ts` sidebar 路由契约（每 URL 必须有 page）自动覆盖——全绿；
- admin 四门（typecheck/lint/test/build）全绿。

## 关联调整：模型管理分组（2026-08-24 同批）

「模型生态」分组（groupEcosystem）更名**模型管理**（键名同步改 `groupModels`，不留
语义遗留），并收纳四个目录域入口（自「资源管理」迁入三个 + 原有模型市场）：

| 条目 | URL | 权限 |
| --- | --- | --- |
| 供应商 | /dashboard/providers | catalog:read |
| 渠道 | /dashboard/channels | catalog:read |
| 模型映射 | /dashboard/models | catalog:read |
| 模型市场 | /dashboard/model-market | catalog:read |

整组统一 `catalog:read` 门禁（与后端 DESIGN §2.2 域归属一致——无权限角色整组隐藏），
页面/守卫零改动。
