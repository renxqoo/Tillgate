# ADR-0010: 上游出口信任回归运营面——撤销 env 主机名白名单强制

> 状态：Accepted（2026-08-25 运营现实裁决）
> 日期：2026-08-25
> 关联：[0004-upstream-4xx-passthrough.md](./0004-upstream-4xx-passthrough.md)、
> PR #30 `audit/verify-reported-issues`（SSRF 防线收口批次）、
> [packages/ai/src/transport/http-client.ts](../../packages/ai/src/transport/http-client.ts)、
> [docs/configuration.md](../configuration.md)

## 背景

PR #30 为上游寻址接入 env 主机名白名单：`GATEWAY_UPSTREAM_ALLOWED_HOSTS` /
`WORKER_UPSTREAM_ALLOWED_HOSTS`（逗号分隔，生产必填、缺失拒绝启动），装配层注入
`assertSafeUrl(url, { allowedHosts })`。设计动机是经典多租户 SaaS 姿态——出口周界
由部署配置锚定，独立于业务数据。

复核发现四个事实使该姿态在本产品形态下不成立：

1. **上游 hostname 全部住在 DB**：真实 URL = `channels.base_url_override ??
   providers.base_url`，而 `providers` 本身就是 admin 可 CRUD 的表（渠道管理是产品
   的设计工作流）。写入时校验仅「http(s) 协议 + 长度 ≤255」。
2. **厂商集合大且动态**：多云各有域名、Azure 按资源分配子域名（`*.openai.azure.com`）、
   中转站任意域名——枚举式白名单连「静态小集合」前提都满足不了，只能永远滞后。
3. **不存在第二信任权威**：管 env 的人和管渠道表的是同一个运营者。env 列表最终
   只能是 DB 的镜像（PR #30 的 CHANGELOG 自己也规定「上线前按渠道表提取 host
   清单配置」）——这是同一决策的两份拷贝，不是信任边界；代价却是双份维护 +
   漏配只在请求期暴露（渠道全量故障）。
4. **经典用户输入 SSRF 不存在**：用户不能指定上游 URL（渠道写入是 admin 域，
   RBAC + 审计约束）。env 白名单的边际价值只剩两点：DNS rebinding TOCTOU 窗口的
   关闭、被劫持 admin 会话的出口遏制——后者在单运营者部署下同样不成立。

## 决策

1. **撤销两个 env 变量与生产必填门禁**：从 gateway / worker 的 config schema、
   superRefine、装配注入中整体移除 `*_UPSTREAM_ALLOWED_HOSTS`；部署清单同步删除。
2. **`packages/ai` 的 `SafeUrlOptions.allowedHosts` 选项一并移除**：无调用方即死
   代码（铁律 4 / 8——单一形态，不留无期限的机制残骸）。
3. **上游 SSRF 防线收敛为机械基线 + 运营面**，两者均维持现状不弱化：
   - 机械基线（代码层，不信任任何输入）：https-only（`allowLocal` 逃生门仅非生产
     且生产误配恒关）、私网/回环字面量与 IPv6 内嵌段全量解包拒绝、DNS 解析后
     逐地址拒绝私网、`redirect: 'manual'` 不跟随跳转；
   - 运营面（信任边界所在）：渠道/provider 写入是 admin 域（RBAC 权限 + 审计日志），
     即「能改渠道的人」就是本部署的出口授权人。
4. **接受两项残余风险并记录缓解路径**（见「影响」）。

## 备选方案与取舍

| 备选 | 取舍 |
| --- | --- |
| A. 维持 env 白名单强制 | 否决——只适合固定小厂商集合的产品；本产品渠道集动态且大，env 只能镜像 DB，安全收益趋近零而运维代价真实（见背景 2/3）。 |
| C. 白名单改为 admin 管理的安全级设置（独立权限码 + 审计 + 后缀条目 + 渠道写入时 fail-loud 校验） | 本轮否决但记录为回摆形态——保留权限分离与写入期漂移检查的真实价值；单运营者部署下权限分离暂时无牙，先不加机制。未来多租户/多管理员时按此回摆。 |
| D. DNS pinning（解析一次 → 直连 IP + TLS 校验原 hostname） | 工程正解但成本高（自定义 fetch agent/undici dispatcher）；残余风险实际发生时再立项，届时 hostname 枚举从安全需求降为纯出口策略。 |

## 影响

- **部署契约变更**：生产环境不再要求这两个 env；已有配置中的残留值成为无人读取的
  死配置，无害但应清理。
- **残余风险 1（接受）**：DNS rebinding TOCTOU——解析过检与 fetch 连接之间域名可
  重新解析为私网。缓解：运营者只应录入知名厂商域名（其 DNS 不受本方控制）；实际
  威胁成立时按备选 D 立项。
- **残余风险 2（接受）**：被劫持的 admin 会话可将渠道指向任意公网 host 外送流量。
  缓解：admin 会话本身有安全防线（TTL、审计）；多管理员分权需求出现时按备选 C 回摆。
- **推荐增量（独立立项，不改本 ADR 语义）**：渠道/provider 写入时结构校验
  （HTTPS + 公网点分域名，IP 字面量要求显式内网标记）——把「配置期报错」前移，
  顺带解锁内网/自建部署场景（今天被机械基线挡死）。
- CHANGELOG 在 Unreleased 登记本次撤销；PR #30 的 Fixed 条目保留为该批次的
  历史记录，不回改。
- 审计线：若后续安全审计再flag本缺口，引用本 ADR 的威胁模型分析（用户不能指定
  上游 URL；经典 SSRF 目标由机械基线确定性覆盖）复议，不得绕过本 ADR 直接恢复
  env 强制。
