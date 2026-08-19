# AI Gateway 架构与流程图（总览）

> 注：本文为 v1 总览设计文档（含 uncertain 状态等 v1 语义）。生产 v2 计费/扣款口径
> （gateway + wallet 双分录）见 [`billing-flow-deep-dive.md`](billing-flow-deep-dive.md)。

> 视觉配套文档，由四份设计文档生成：`requirements.md`（业务）、`data-model.md`（数据）、`api-contract.md`（接口）、`tech-stack.md`（选型）。
> 本文所有图均为 mermaid，支持在 GitHub / 支持 mermaid 的 Markdown 查看器中渲染。

---

## 1. 部署架构图

```mermaid
flowchart LR
    subgraph CLIENT["客户端"]
        AGENT["企业 Agent 服务<br/>Bearer JWT（OAuth2 换发）"]
        DEV["个人 / 脚本<br/>Bearer 静态 Key"]
        WEB["浏览器用户<br/>OIDC 登录控制台"]
    end

    subgraph DOCKER["Docker Compose（云服务器）"]
        NGINX["nginx<br/>TLS 终止 / 反代 / 静态资源"]
        subgraph APP["应用层（Node.js 集群，可水平扩展）"]
            GATEWAY["gateway · Hono<br/>/v1/chat/completions · /v1/embeddings<br/>/v1/models · /oauth/token · /livez · /readyz"]
            ADMIN["admin-api · Hono<br/>/api/* 管理端 REST<br/>仅内网，不发布端口"]
            CLIENTAPI["client-api · Hono<br/>/api/* 用户面 REST<br/>仅内网，不发布端口"]
            CLIENT["client · Next.js<br/>端用户面板"]
            ADMINWEB["admin · Next.js<br/>运营后台"]
            WORKER["worker · BullMQ 消费者<br/>计量结算 · 对账"]
        end
        subgraph DATA["数据层"]
            REDIS["Redis 7<br/>限流 · 鉴权缓存 · 队列 · 熔断"]
            PG[("PostgreSQL 16<br/>账本权威（billing_requests + durable receipt）")]
        end
        subgraph OBS["观测栈（compose profile `obs`，默认关闭）"]
            OTEL["OTel Collector"]
            PROM["Prometheus<br/>指标"]
            TEMPO["Tempo<br/>链路"]
            GRAFANA["Grafana<br/>面板"]
        end
    end

    subgraph UP["上游供应商（一期全部 OpenAI 兼容）"]
        DS["DeepSeek"]
        OA["OpenAI"]
        MM["MiniMax"]
        GLM["GLM 智谱"]
        QW["Qwen 通义"]
    end

    AGENT -->|"Bearer JWT"| NGINX
    DEV -->|"Bearer ag_Key"| NGINX
    WEB --> NGINX
    NGINX --> GATEWAY
    NGINX --> CLIENT
    CLIENT -->|"服务端调用（内网）"| ADMIN
    GATEWAY --> REDIS
    GATEWAY --> PG
    GATEWAY -->|"HTTPS 转发（含 SSE）"| DS
    GATEWAY -->|"HTTPS 转发（含 SSE）"| OA
    GATEWAY -->|"HTTPS 转发（含 SSE）"| MM
    GATEWAY -->|"HTTPS 转发（含 SSE）"| GLM
    GATEWAY -->|"HTTPS 转发（含 SSE）"| QW
    WORKER --> REDIS
    WORKER --> PG
    ADMIN --> PG
    ADMIN --> REDIS
    GATEWAY -.->|"OTLP"| OTEL
    WORKER -.->|"OTLP"| OTEL
    ADMIN -.->|"OTLP"| OTEL
    OTEL --> PROM
    OTEL --> TEMPO
    PROM --> GRAFANA
    TEMPO --> GRAFANA
```

---

## 2. 模块关系图（monorepo）

```mermaid
flowchart LR
    subgraph APPS["apps/"]
        GW["gateway<br/>对外代理 · 预扣 · 转发"]
        WK["worker<br/>结算 · 对账（编排）"]
        ADM["admin-api<br/>管理端 REST"]
        CA["client-api<br/>用户面 REST"]
        CS["client + admin<br/>Next.js 前端（两个独立部署）"]
    end
    subgraph PKGS["packages/（共享，结构已重组，见 README 仓库地图）"]
        DB["db<br/>Drizzle schema + migrations"]
        CORE["core<br/>env 校验 + 日志 + OTel + 加密"]
        DOMAIN["domain<br/>计价 rating（Decimal）/ 报价 / 收据"]
        SERVICE["service<br/>billing 预扣生命周期 + 结算唤醒"]
        WALLET["wallet<br/>双分录账本"]
        REPO["repository<br/>数据访问层"]
        LEDGERCORE["ledger-core<br/>账本内核"]
        AI["ai<br/>上游 LLM 传输层"]
    end
    GW --> DB
    GW --> SERVICE
    GW --> AI
    WK --> SERVICE
    ADM --> REPO
    CA --> REPO
    SERVICE --> DOMAIN
    SERVICE --> REPO
    CS -.->|"HTTP /api/*"| ADM
    DB -.->|"migrate 一次性执行"| PG[("PostgreSQL")]
```

---

## 3. 请求全生命周期流程图

```mermaid
flowchart TD
    C["客户端<br/>POST /v1/chat/completions<br/>Bearer ag_Key 或 JWT"] --> A1

    A1["① 鉴权<br/>Key 哈希查库 / JWT 验签（直查 DB 属主状态）<br/>+ 双层爆破锁（两分支同口径）"] -->|"失败"| ERR["统一错误信封<br/>401 invalid_api_key"]
    A1 -->|"通过"| A2

    A2["② 限流 admitKey<br/>Redis 计数：凭证维（key:/app:/pg:）+ 用户维并罚<br/>RPM · TPM（输入预占+历史回填）"] -->|"超限"| E429["429 rate_limit_exceeded<br/>Retry-After"]
    A2 -->|"放行"| A3

    A3["③ 报价/路由 buildQuote<br/>external_name → model_mappings"] -->|"无映射/下架"| E404["404 model_not_found"]
    A3 -->|"命中候选"| A4

    A4["④ 模型维 TPM 预占<br/>主 + fallback 候选 mappingId 一并占住"] -->|"超限"| E429
    A4 -->|"放行"| A5

    A5["⑤ 免费日限<br/>免费模型每用户每日次数（fail-closed）"] -->|"超限"| E429
    A5 -->|"放行"| A6

    A6["⑥ billing.authorize 足额授权<br/>required = 最贵候选完整费用上限<br/>DB 条件占用额度"] -->|"balance < required"| E402["402 insufficient_balance<br/>不发往上游"]
    A6 -->|"已预扣"| A7

    A7["⑦ 渠道选择<br/>权重/优先级<br/>过滤：熔断中 · 凭据无效 · 禁用"] -->|"全部不可用"| E503["503 no_available_channel"]
    A7 -->|"选定候选"| A8

    A8["⑧ 协议转换 + 参数钳制<br/>一期 OpenAI 兼容 = 透传<br/>reasoning 模型规则（param_rules）"] --> A9

    A9["⑨ 上游调用<br/>重试（退避+jitter）· 熔断 · 死凭据检测<br/>URL 校验（SSRF 防护）"] -->|"流式"| STR
    A9 -->|"非流式"| JSN

    STR["⑩ SSE 流式透传<br/>心跳注入 · 中断处理（见第 7 节）"]
    JSN["⑩ 非流式 JSON 返回<br/>空内容 → 空完成重试 ≤2"]

    STR --> M["⑪ 计量<br/>严格解析可信 usage<br/>缺失/非法 → 估算结算留痕"]
    JSN --> M
    M --> Q["durable receipt → billing_requests<br/>队列只唤醒"]
    Q --> W["⑫ worker 结算对账<br/>actual ≤ reserved 才提交<br/>写 usage_logs + transactions"]

    W --> R["⑬ 响应返回客户端"]
    ERR --> C
    E402 --> C
    E429 --> C
    E404 --> C
    E503 --> C
    R --> C
```

---

## 4. 鉴权双凭证流程图

```mermaid
flowchart TD
    REQ["Authorization: Bearer &lt;token&gt;"] --> P{"前缀判定"}

    P -->|"ag_"| KEY["静态 Key 路径<br/>SHA-256(token) 查 api_keys"]
    KEY -->|"不存在/吊销/过期"| E1["401 invalid_api_key /<br/>key_revoked / key_expired"]
    KEY -->|"有效"| CTX

    P -->|"JWT"| JWT["JWT 路径<br/>本地验签：iss · exp · 签名"]
    JWT -->|"属主失效（App/用户停用）"| E2["401"]
    JWT -->|"App 状态缓存 = 禁用"| E3["401 app_disabled"]
    JWT -->|"验签通过"| CTX

    CTX["统一调用上下文<br/>{user_id, app_id?, rate_card 系数, 限流维度}"] --> N["进入预扣 → 限流 → 路由链路"]
    E1 --> N
    E2 --> N
    E3 --> N
```

---

## 5. 计费预扣与结算流程图（含套餐判定）

```mermaid
flowchart TD
    subgraph PH1["请求前（gateway）"]
        H1["编译费用上界<br/>文本校准估算（estimateInputTokens + CJK 权重）；多模态按模型硬上限"] --> H2["required = max(所有候选)<br/>超风险上限直接拒绝"]
        H2 --> H3{"已结算余额 - 处理中预留 ≥ required ?"}
        H3 -->|"否"| H4["402 拒绝"]
        H3 -->|"是"| H5["PostgreSQL 事务<br/>写 billing_requests + 增加预留<br/>已结算余额不变"]
        H5 --> F["转发上游"]
    end

    subgraph PH2["请求完成后（worker）"]
        F --> M["成功收据 → billing_requests"]
        M --> S1["计算实际费用 amount<br/>（缓存/未缓存/输出 × 官方价 × 系数）"]
        S1 --> S2{"有有效套餐？"}
        S2 -->|"是"| S3["扣套餐额度<br/>plan_amount = min(amount, 剩余额度)<br/>quota 原子扣减"]
        S2 -->|"否"| S5
        S3 --> S4{"剩余部分？"}
        S4 -->|"fallback 开 + 余额足"| S5
        S4 -->|"fallback 关 / 余额不足"| S6["坏账 dead<br/>纯余额用户冻结 / 套餐用户不冻结"]
        S5["余额结算 payg_amount<br/>actual ≤ reserved：扣实际 + 释放全额预留<br/>actual > reserved：dead 审核"]
        S6 --> S7
        S5 --> S7["写 usage_logs + transactions<br/>billing_requests → settled"]
    end

    subgraph PH3["兜底与对账"]
        H5 -.->|"授权/租约过期"| T1["DB CAS 恢复<br/>未触达上游才退款；否则估算结算留痕"]
        S7 --> T2["每日对账<br/>Σ amount(status=0) = Σ transactions<br/>upstream_cost ↔ 供应商账单"]
    end
```

---

## 6. 渠道故障转移与熔断流程图

```mermaid
flowchart TD
    START["mapping 的渠道候选列表<br/>（权重/优先级排序）"] --> CHK{"还有候选？"}

    CHK -->|"否"| FB1{"配置了 fallback 模型？"}
    FB1 -->|"是"| FB2["切换到 fallback 模型<br/>重新解析候选（递归）"]
    FB2 --> CHK
    FB1 -->|"否"| FAIL["耗尽时对外统一<br/>503 no_available_channel<br/>（真实失败原因只进日志）"]

    CHK -->|"是"| C1["取下一候选"]
    C1 --> C2{"候选可用？<br/>（未熔断 · 凭据有效 · 已启用）"}
    C2 -->|"否"| SKIP["跳过，记录 lastErrorFrame"]
    C2 -->|"是"| C3["参数钳制 → 转发上游"]

    C3 --> C4{"尝试结果"}
    C4 -->|"成功（首帧前）"| DONE["进入内容校验<br/>空完成 → 同渠道重试 ≤2 → 换渠道<br/>流式 → 透传"]
    C4 -->|"5xx / 网络 / 超时"| R1["记熔断失败计数<br/>退避后下一候选"]
    C4 -->|"429 上游限流"| R2["不计入熔断<br/>退避后下一候选"]
    C4 -->|"401 / 403"| R3["死凭据计数<br/>≥N → 凭据无效 + 停路由 + 告警"]
    C4 -->|"其他 4xx"| R4["原样返回该状态<br/>upstream_client_error"]
    C4 -->|"流式错误帧 / 流中断"| R5["排除候选<br/>可信 usage 精确结算；否则估算结算留痕"]

    R1 --> CHK
    R2 --> CHK
    R3 --> CHK
    R5 --> CHK
    SKIP --> CHK

    subgraph BRK["熔断器状态机"]
        B1["closed"] -->|"60s 窗口 ≥5 次失败"| B2["open（5min）"]
        B2 -->|"冷却到期"| B3["half-open 探测"]
        B3 -->|"成功"| B1
        B3 -->|"失败"| B2
    end
    R1 -.-> BRK
```

---

## 7. 流式中继与中断处理流程图

```mermaid
flowchart TD
    UP["上游 SSE 响应"] --> PROBE["first_chunk 事件判定首帧"]

    PROBE -->|"无内容"| EMPTY["空完成：同渠道退避重试 ≤2<br/>仍空 → 排除候选换渠道"]
    PROBE -->|"有内容"| LOOP["读循环<br/>同一时刻只挂一个 read<br/>与心跳定时器竞争"]

    LOOP -->|"数据块"| SCAN["SseScanner（O(1) 内存）<br/>usage 最后帧胜出<br/>首个错误帧记录 code/detail"]
    LOOP -->|"静默 >30s"| HB["注入心跳帧 ': keep-alive'<br/>（仅 SSE 事件边界，防拆半截事件）"]
    LOOP -->|"静默 ≥5min"| TO["取消上游读<br/>发流式错误帧 stream_inactivity_timeout"]
    LOOP -->|"客户端 abort"| ABORT["主动断开上游（停止生成、省成本）<br/>可信 usage 精确结算；否则估算结算留痕"]

    SCAN -->|"流结束"| SETTLE["先提交 durable receipt<br/>再关闭 SSE"]
    TO --> ABORT
    SETTLE --> DONE["响应完成（[DONE] / 错误帧）"]
```

---

## 8. 核心数据关系图（ER 简化）

```mermaid
erDiagram
    users ||--o{ apps : "拥有应用"
    users ||--o{ api_keys : "拥有 Key"
    users ||--o{ transactions : "资金流水"
    users ||--o{ usage_logs : "用量明细"
    users }o--|| rate_cards : "绑定费率卡"
    users ||--o{ request_logs : "请求日志"
    users ||--o{ audit_logs : "操作审计"

    rate_cards ||--o{ rate_card_coefficients : "系数表"
    model_mappings ||--o{ rate_card_coefficients : "按模型覆盖"

    providers ||--o{ channels : "含渠道"
    channels ||--o{ model_channels : "关联"
    model_mappings ||--o{ model_channels : "关联"
    model_mappings ||--o{ usage_logs : "计价依据"

    redeem_batches ||--o{ redeem_codes : "包含"
    users ||--o{ redeem_codes : "兑换"

    plans ||--o{ user_subscriptions : "订阅"
    users ||--o{ user_subscriptions : "订阅"
    user_subscriptions ||--o{ usage_logs : "套餐扣减"

    channels ||--o{ usage_logs : "实际调用"
    apps ||--o{ usage_logs : "JWT 归因"
```

---

## 9. 各图对应的设计文档

| 图 | 对应章节 |
|---|---|
| 1 部署架构 | tech-stack §4（Docker Compose） |
| 2 模块关系 | tech-stack §2（monorepo） |
| 3 请求生命周期 | requirements §3（链路） |
| 4 鉴权双凭证 | requirements §4.2 |
| 5 预扣与结算 | requirements §4.7 · data-model §5 |
| 6 故障转移与熔断 | requirements §4.3/§4.4 · 规则 5.9/5.10/5.15/5.16 |
| 7 流式中继 | requirements §5.11 · api-contract §2.1 |
| 8 数据关系 | data-model §3 |
