# new-api 开放 Bug 交叉审计——第 2-14 页（301 条）逐条分类附录

> 主文档：`newapi-open-bugs-cross-audit-2026-08-16.md`。
> 分类口径：APPLICABLE=缺陷类可映射到本项目（需/已代码核查）；NOT_APPLICABLE=无对应子系统或设计不同；
> FEATURE=变相需求；UI=纯控制台缺陷；UNCLEAR=摘要不足。
> 子 agent 逐条分类后，全部 APPLICABLE 项由主 agent 复核：绝大多数在早前轮次已验证安全，
> 真正新确认为 BUG-E / BUG-F（见主文档）。

## Batch 1（#6872 区段之后的高号段，61 条）

```
#6491 | NOT_APPLICABLE | 无表达式计费/费用预估器子系统
#6476 | NOT_APPLICABLE | 无在线支付
#6470 | NOT_APPLICABLE | 无 /v1/responses、无图片按次计价
#6412 | APPLICABLE(已跟踪) | evalsha NOSCRIPT = BUG-C（OPEN）
#6401 | NOT_APPLICABLE | 无邮箱绑定/验证码
#6398 | NOT_APPLICABLE | 无用户分组
#6396 | NOT_APPLICABLE | 无协议转换
#6370 | UI | 公告弹窗接线
#6362 | NOT_APPLICABLE | 无邀请/返利
#6358 | NOT_APPLICABLE | 无视频路由
#6353 | NOT_APPLICABLE | 无 Claude 上游/该 usage schema；归一化已验证
#6344 | NOT_APPLICABLE | 无 Turnstile/邮箱验证
#6333 | NOT_APPLICABLE | requestId 服务端生成（防绕过，已验证）
#6296 | UI | 前端开关映射错误
#6294 | APPLICABLE(复核排除) | 响应形态由请求 stream 标志驱动，不依赖上游 Content-Type；上游违约流→invalidResponse 重试/换道（边界已核）
#6293 | NOT_APPLICABLE | 无协议策略探测
#6285 | UI | 表格渲染错位
#6265 | APPLICABLE(复核排除) | 无 usage→uncertain（G1），零计费成功不存在（usage-missing 测试锁定）
#6260 | NOT_APPLICABLE | 无消息体转换
#6250 | NOT_APPLICABLE | 无 Vertex 适配器
#6244 | FEATURE | 编辑过期时间 UX（且无 token-quota）
#6241 | APPLICABLE(已跟踪) | 排序 tiebreaker = BUG-D（OPEN）
#6239 | APPLICABLE(复核排除) | inactivity/截断注入错误帧后再补 [DONE]，调用方可感知（failWithErrorFrame 已核）
#6230 | NOT_APPLICABLE | 无 /v1/responses 与按工具计费
#6226 | NOT_APPLICABLE | 无 Telegram OAuth
#6222 | APPLICABLE(记录) | 控制台订阅绑定展示语义与后端一致性——前端待查（并入需求面）
#6215 | APPLICABLE(复核排除) | 兑换码 160-bit Base32 熵，无 4 位码碰撞面（secrets.ts 已核）
#6180 | UI | 侧边栏权限配置联动
#6175 | NOT_APPLICABLE | 无分组
#6172 | APPLICABLE(复核排除) | settle 用 authorize 时价格快照（receipt 携带 inputPrice/coefficient，已核）
#6166 | NOT_APPLICABLE | 无异步任务轮询
#6152 | NOT_APPLICABLE | 无 Passkey/2FA 流程
#6149 | APPLICABLE(复核排除) | finalizeRequestBody 强制注入 stream_options.include_usage（create-ai.test 已锁定）
#6144 | APPLICABLE(已验证) | sidecar 单源提取 + cached_tokens 归一化，无双路径分叉
#6132 | APPLICABLE(复核排除) | brute-force/auth-failure guard 均 Redis 共享（已核，多实例安全）
#6130 | UI | 模型分组 UI
#6129 | NOT_APPLICABLE | 上游侧 cache 语义；我们 byte 级透传
#6125 | APPLICABLE(复核排除) | client usage 仅暴露 channelId 数字与模型/Key 名，无渠道/上游身份；错误消毒有测试
#6121 | NOT_APPLICABLE | 探测固定 GET /v1/models，无按模型选端点
#6099 | NOT_APPLICABLE | 不解码图片
#6095 | APPLICABLE(复核排除) | 候选列表一次取定不可变，熔断开路走 canRequest→failEarly→下一渠道，无下标错位面
#6075 | APPLICABLE(复核排除) | 流/非流分支由请求 stream 标志决定，不依赖上游 Content-Type 存在性
#6050 | UI | 前端 debounce
#6038 | NOT_APPLICABLE | 无出站协议转换
#6017 | NOT_APPLICABLE | 表结构已规范化 + migration 管理
#6011 | UI | 用量弹窗展示完整性（计费正确）
#5987 | UI | i18n 文案
#5984 | NOT_APPLICABLE | 无邮件告警
#5982 | NOT_APPLICABLE | 无入站 Claude 协议
#5981 | UI | 前端表单状态（亦无按次/按 Token 双模式）
#5977 | NOT_APPLICABLE | 无异步任务轮询
#5966 | NOT_APPLICABLE | 无游乐场/高级自定义渠道
#5961 | NOT_APPLICABLE | 无 /v1/responses 与渠道级 prompt 注入
#5938 | NOT_APPLICABLE | 无协议转换
#5933 | NOT_APPLICABLE | 单一 PG 配置源 + 版本化路由缓存
#5922 | NOT_APPLICABLE | 无入站 Claude 格式
#5914 | NOT_APPLICABLE | 上游 token 语义，透传计费
#5907 | UI | iframe 属性
#5878 | NOT_APPLICABLE | 构建链路
#5877 | NOT_APPLICABLE | numeric(38,18)
#5834 | APPLICABLE(复核排除) | 非流式 `{...body, model}` spread 保真（attempt-runner:441 已核）
```

## Batch 2（61 条）

```
#5833 | APPLICABLE(复核排除) | SSE 改写 JSON.parse→仅改 model→重序列化，其余字段全保留（sse-model-rewrite 已核）
#5828 | APPLICABLE(复核排除) | pipeTo cancel 传播 + peek readBody 带 signal（已核）
#5826 | APPLICABLE(复核排除) | 中流错误帧→aborted(非 client_disconnect)→breaker.recordFailure（BUG-B 修复时已核）
#5816 | APPLICABLE(复核排除) | 错误分支 readBody 消费 body、probe 亦读 body（连接可复用，已核）
#5815 | APPLICABLE(复核排除) | 失败/换道/断开路径 releaseTpm + settle 回填（已核）
#5809 | UI | 前端编辑器
#5804 | FEATURE | 同步自动删除模型
#5803 | UI | 前端选中态未刷新（记录：我们 admin 模型弹窗同类风险待查）
#5767 | UI | logo 缓存
#5756 | NOT_APPLICABLE | 无 tiered_expr/Anthropic 双格式
#5727 | FEATURE | 节点手动删除
#5715 | NOT_APPLICABLE | 无异步任务；billing_requests 封闭状态机
#5702 | APPLICABLE(复核排除) | settle 原子更新 used_amount（已核+测试）
#5698 | APPLICABLE(复核排除) | readBody 8MB 上限 + timeout 恒设置 + 咨询锁不跨上游调用（authorize 内）（已核）
#5665 | APPLICABLE(复核排除) | chatSchema passthrough + 定点改写，未知字段透传（已核）
#5661 | APPLICABLE(复核排除) | 订阅额度不足 authorize 干净拒绝（402），设计上无自动切余额
#5655 | NOT_APPLICABLE | 无模型部署
#5640 | UI | 卡片标签截断
#5639 | UI | OAuth 图标
#5638 | UI | 前端样式
#5561 | APPLICABLE(复核排除) | 单活跃订阅硬不变量（F1 索引），无叠加态
#5557 | NOT_APPLICABLE | 无支付
#5556 | APPLICABLE(复核排除) | release 单条守卫 UPDATE + fund_operations 幂等（已核）
#5542 | NOT_APPLICABLE | 无支付
#5530 | NOT_APPLICABLE | 无转换层，thinking 块透传
#5513 | NOT_APPLICABLE | 无 images 端点
#5498 | NOT_APPLICABLE | 无视频按 seconds 计价
#5494 | UI | 货币展示（无充值页）
#5489 | UI | 表单交互（无分组倍率）
#5485 | NOT_APPLICABLE | 无邮箱验证码；共享态均在 Redis
#5483 | NOT_APPLICABLE | 无转换层
#5468 | NOT_APPLICABLE | 无模型广场/分组
#5467 | APPLICABLE(复核排除) | content 数组/工具结构原样透传（passthrough，已核）
#5446 | APPLICABLE(复核排除) | 无跨请求共享响应可变态（结构审计已核）
#5441 | APPLICABLE(复核排除) | 非免费零价报价 fail-closed invalid_quote（billing-flow 已核）
#5440 | APPLICABLE(复核排除) | usage 聚合直读 usage_logs（含 cachedInputTokens），口径单一
#5419 | NOT_APPLICABLE | 探测无计费路径
#5410 | UI | 定价页展示
#5402 | APPLICABLE(复核排除) | 心跳仅 atBoundary 注释帧、错误帧带 \n\n（已核）
#5378 | NOT_APPLICABLE | 无 audio
#5335 | NOT_APPLICABLE | 无转换层，cache_control 类字段透传
#5299 | UI | 展示口径
#5278 | NOT_APPLICABLE | 模型名表驱动，无硬编码厂商路径
#5253 | APPLICABLE(复核排除) | usage_logs 仅 settle 写入，released/失败不入账（已核）
#5236 | APPLICABLE(记录) | admin 创建外键存在性校验——低风险记录（渠道导入有 provider 校验）
#5233 | APPLICABLE(复核排除) | forbidden 可换道 + 熔断开路止血；连接固化属基础设施层
#5218 | NOT_APPLICABLE | 无自动测试调度（by design，需求 R1）
#5215 | NOT_APPLICABLE | 无 OIDC 用户登录
#5200 | NOT_APPLICABLE | 无分组；key→订阅绑定 authorize 校验
#5182 | NOT_APPLICABLE | 无视频轮询
#5174 | UI | 前端竞态
#5172 | UI | 前端功能
#5156 | FEATURE | OIDC RP logout
#5152 | NOT_APPLICABLE | 无邮箱注册
#5141 | UI | 前端状态（无表达式计价）
#5139 | APPLICABLE(复核排除) | 创建时 assertCanUseSubscription 即校验归属（keys.ts:116 已核）
#5137 | NOT_APPLICABLE | numeric(38,18)
#5064 | NOT_APPLICABLE | 无分组倍率/测试计费
#5063 | NOT_APPLICABLE | 无上游余额查询
#5045 | NOT_APPLICABLE | 无任务状态映射层
#5040 | APPLICABLE(记录) | 创建接口事务性——渠道导入为单事务；单建路径低风险记录
```

## Batch 3（61 条）

```
#5029 | APPLICABLE(复核排除) | SQL 行级 sum 天然按请求加权（usage.ts 已核）
#5020 | NOT_APPLICABLE | 无 images/Gemini
#5004 | UNCLEAR | 摘要不足以判因
#4993 | NOT_APPLICABLE | 无分组/模型广场
#4990 | NOT_APPLICABLE | 无 models.json 同步
#4980 | FEATURE | 按组建用户（无分组）
#4973 | APPLICABLE(复核排除) | probe 读 body→mapError，非 JSON 走文本分类（错误可读性可改进，记录）
#4960 | NOT_APPLICABLE | 仓库 skill 文件问题
#4951 | APPLICABLE(复核排除) | 渠道页仅 search（已应用）；其余列表筛选项与 schema 一一对应（抽查已核）
#4931 | NOT_APPLICABLE | 无转换
#4895 | NOT_APPLICABLE | 无分组倍率
#4844 | NOT_APPLICABLE | 无多货币
#4807 | NOT_APPLICABLE | 无邮件
#4791 | NOT_APPLICABLE | 无 Bedrock
#4781 | NOT_APPLICABLE | 无支付
#4765 | NOT_APPLICABLE | 无支付回调
#4764 | NOT_APPLICABLE | 无重置密码页
#4755 | NOT_APPLICABLE | 无转换（OpenAI 进出直通）
#4753 | FEATURE | UI 愿望
#4733 | APPLICABLE(复核排除) | 16MB body 上限 + SseScanner O(1) + request-log 不克隆（已核）
#4722 | NOT_APPLICABLE | 仅 PostgreSQL
#4697 | NOT_APPLICABLE | 无 /v1/messages
#4694 | NOT_APPLICABLE | 使用咨询
#4679 | NOT_APPLICABLE | 第三方文档
#4656 | APPLICABLE(记录) | 网关致流停滞类——push-through 无缓冲已核；长思考静默由心跳+300s 不活动超时覆盖，记录观察
#4654 | NOT_APPLICABLE | 无 playground/分享链接
#4609 | APPLICABLE(复核排除) | release 无资金移动不写流水；reconcile 只记差异表；usage_logs/transactions 均带 requestId/refId（已核）
#4592 | NOT_APPLICABLE | durationMs 毫秒级（logs/usage/tracing schema 已核）
#4579 | NOT_APPLICABLE | 无分组
#4575 | NOT_APPLICABLE | 固定双控制台
#4556 | NOT_APPLICABLE | 无 per-key 模型限制
#4546 | NOT_APPLICABLE | 无 images
#4543 | NOT_APPLICABLE | 无转换，字段直通
#4541 | APPLICABLE(复核排除) | 429→rate_limited 可重试+可换道（channel-policy + with-retry 已核）
#4526 | APPLICABLE(复核排除) | 信用模型：settle 按实际扣、地板 -credit_limit（设计文档化的有意语义）
#4525 | NOT_APPLICABLE | 无阶梯计费
#4523 | NOT_APPLICABLE | 无 tiered_expr
#4522 | APPLICABLE(复核排除) | 响应改写统一 externalModel；usage_logs 双存 external/real（已核）
#4517 | NOT_APPLICABLE | 无 Vertex
#4512 | NOT_APPLICABLE | 无 playground
#4494 | NOT_APPLICABLE | 无购买次数上限
#4487 | NOT_APPLICABLE | 探测固定路径
#4484 | NOT_APPLICABLE | 无支付
#4483 | NOT_APPLICABLE | 单协议直通（归一化已验证）
#4476 | FEATURE | Veo 文档指引
#4466 | NOT_APPLICABLE | 无外部目录同步（catalog 导入为 OpenRouter 单源+防御解析）
#4429 | APPLICABLE(复核排除) | worker recoverOnce 收割过期 authorized/in_flight（已核+测试）
#4406 | NOT_APPLICABLE | 无公式文案
#4395 | NOT_APPLICABLE | 不改 usage 字段
#4379 | NOT_APPLICABLE | 无转换
#4370 | APPLICABLE(记录) | 强制 include_usage 会向客户端透传 usage 尾帧——计费完整性优先的有意设计（注释明示），记录为语义差异
#4367 | NOT_APPLICABLE | 无 setup 页
#4364 | APPLICABLE(复核排除) | 超时无 usage→uncertain 保留预扣（G1），不误标 settled（已核）
#4352 | NOT_APPLICABLE | 单角色认证
#4345 | NOT_APPLICABLE | 无敏感词
#4330 | NOT_APPLICABLE | 无 OpenRouter 适配器
#4317 | APPLICABLE(复核排除) | passthrough + 定点改写，未知参数透传（与 new-api 的 typed Unmarshal 相反，已核）
#4287 | UI | 按钮文案 i18n
#4281 | NOT_APPLICABLE | 单协议探测
#4274 | APPLICABLE(复核排除) | 锁序固定已核（F1-F4 修复时验证）
#4261 | NOT_APPLICABLE | 无 images
```

## Batch 4（61 条）

```
#4252 | NOT_APPLICABLE | 无 Gemini 入口
#4234 | NOT_APPLICABLE | 无视频
#4232 | UNCLEAR | 摘要无错误详情
#4227 | NOT_APPLICABLE | 单一 Bearer 凭据
#4211 | APPLICABLE(复核排除) | 聚合全部派生自已结算行（usage_logs），released 无聚合可逆转（已核）
#4203 | NOT_APPLICABLE | 逐字节透传，无 tool_call 重组
#4168 | APPLICABLE(复核排除→设计差异) | 用户侧取消按 input 估算结算（G1 有意语义，文档化）
#4166 | NOT_APPLICABLE | 无阶梯计费
#4161 | NOT_APPLICABLE | 无邮件
#4148 | NOT_APPLICABLE | 无分组；PG text
#4139 | APPLICABLE(已跟踪/已修) | = BUG-B 首帧错误 failEarly（已修复）；中流错误帧→uncertain 已核
#4138 | UI | 前端预设列表
#4125 | NOT_APPLICABLE | 无视频
#4121 | NOT_APPLICABLE | 无 remix
#4120 | NOT_APPLICABLE | 无任务 ID 映射
#4119 | APPLICABLE(复核排除) | 系数仅 60s 有界陈旧（key 快照缓存自然过期），路由缓存不含系数（已核）
#4081 | NOT_APPLICABLE | 无 Claude 原生
#4014 | APPLICABLE(记录) | orgs-content.tsx:94 一处未包 try/catch 的 clipboard.writeText（HTTP 下低危 unhandled rejection，前端待修记录）
#3537 | NOT_APPLICABLE | 熔断 300s 自动闭合 + 死凭据 TTL 自动过期（tracker 已核）
#3533 | NOT_APPLICABLE | 无视频
#3513 | APPLICABLE(复核排除) | 出站头集合受控：仅 authorization/content-type/idempotency-key，客户端头不透传（已核）
#3511 | APPLICABLE(复核排除) | 断流无 usage→uncertain（G1），不漏记不伪造（已核）
#3490 | UI | 文案 i18n
#3487 | NOT_APPLICABLE | 无按次计价
#3448 | APPLICABLE(复核排除) | connectMs 覆盖 connect+TTFB（http-client 已核），陈旧连接错误→transport error→换道
#3389 | APPLICABLE(复核排除) | messages 原样透传、param 规则确定性；无 affinity 的缓存分裂为已知设计权衡
#3385 | NOT_APPLICABLE | 无 Gemini DTO
#3376 | NOT_APPLICABLE | 无 Playground
#3365 | NOT_APPLICABLE | 无公开元数据端点
#3354 | NOT_APPLICABLE | 无 OIDC
#3352 | NOT_APPLICABLE | 无视频
#3346 | APPLICABLE(复核排除) | 16MB 网关与 nginx 一致（security.ts + nginx.conf 已核）
#3339 | NOT_APPLICABLE | 无 Bedrock
#3327 | NOT_APPLICABLE | 端点表静态绑定
#3309 | APPLICABLE(已验证) | usage 归一化覆盖（prompt_tokens_details/DeepSeek）
#3306 | NOT_APPLICABLE | 无支付
#3302 | UNCLEAR | 摘要无根因
#3298 | NOT_APPLICABLE | 无自动测试调度（R1 需求）
#3260 | NOT_APPLICABLE | 无任务日志/视频
#3255 | NOT_APPLICABLE | 不注入默认值，仅重写 model
#3206 | NOT_APPLICABLE | 无支付
#3200 | NOT_APPLICABLE | 无支付
#3199 | NOT_APPLICABLE | 无支付
#3196 | UI | 展示（无充值页）
#3191 | APPLICABLE(复核排除) | normalizeRequest 对 chat/embeddings 共用（create-ai:179 已核）
#3189 | NOT_APPLICABLE | 无分组
#3177 | APPLICABLE(记录) | 控制台金额浮点运算风险——前端待查（服务端 numeric/decimal 安全）
#3173 | NOT_APPLICABLE | 厂商显式配置
#3149 | APPLICABLE(已验证) | 单一 normalize 实现，无多路径分叉
#3144 | NOT_APPLICABLE | 无 Playground/转换
#3133 | APPLICABLE→**BUG-E** | joinUrl 版本段重复（红测已证）
#3127 | NOT_APPLICABLE | 无图像
#3126 | NOT_APPLICABLE | 无邮件
#3111 | UI | i18n
#3110 | APPLICABLE(复核排除) | normalize 拒 cached>input→null→G1 uncertain；calcAmount 双向钳制（已核）
#3109 | NOT_APPLICABLE | 无上游余额查询
#3025 | NOT_APPLICABLE | 两推理端点共用 authorize（已核）
#3022 | NOT_APPLICABLE | 无转换
#2919 | NOT_APPLICABLE | 无支付
#2891 | APPLICABLE(复核排除) | 同 #4211：聚合派生自已结算行
#2841 | NOT_APPLICABLE | 全维度原子 Lua；唯一缺口=NOSCRIPT（BUG-C 已跟踪）
```

## Batch 5（57 条）

```
#2830 | NOT_APPLICABLE | 无视频
#2828 | NOT_APPLICABLE | 熔断/死凭据机制不同且无视频渠道
#2775 | NOT_APPLICABLE | 计量在 PG+Redis，无实例内存态
#2774 | NOT_APPLICABLE | 无邀请返佣
#2773 | NOT_APPLICABLE | 无自注册
#2719 | NOT_APPLICABLE | 无密码注册
#2699 | NOT_APPLICABLE | 无异步视频（支持类提问）
#2681 | APPLICABLE(复核排除) | 心跳不重置 lastDataAt（不活动计时只认上游数据），EOF 缺哨兵走截断终止（已核）
#2650 | NOT_APPLICABLE | 无支付
#2638 | NOT_APPLICABLE | 不查上游余额
#2608 | APPLICABLE(复核排除) | 无最小计费钳制；decimal 全精度（money/units 已核）
#2594 | APPLICABLE(复核排除) | 同 #6294：形态由请求标志驱动
#2498 | NOT_APPLICABLE | 无 /v1/messages
#2484 | NOT_APPLICABLE | 无转换层
#2463 | APPLICABLE→**BUG-F** | embeddings 结构化 input 被拒（红测已证）
#2443 | APPLICABLE→**BUG-F** | 同 #2463
#2404 | NOT_APPLICABLE | 无 Vertex
#2401 | NOT_APPLICABLE | 不解码图片
#2400 | APPLICABLE(记录) | param 规则嵌套 path/keep_origin 支持——当前规则引擎为扁平键，记录为能力缺口（需求）
#2376 | APPLICABLE(记录) | 规则 delete 模式带条件——能力缺口记录（需求）
#2347 | NOT_APPLICABLE | 无 rerank
#2333 | NOT_APPLICABLE | 无深链
#2308 | FEATURE | Dify 会话保持
#2301 | NOT_APPLICABLE | 无协议转换
#2217 | APPLICABLE(复核排除) | 路由过滤 status=0 + PATCH/DELETE 均 bumpRouteCache（已核）
#2199 | APPLICABLE(复核排除) | user:{id} 维恒定存在，多建 key 不放大用户级上限（已核）
#2196 | NOT_APPLICABLE | 无 images
#2174 | NOT_APPLICABLE | 无视频/quota_data
#2148 | UI | 图标素材
#2071 | APPLICABLE(复核排除) | 限流在管线准入（chat+embeddings 共用 run()），无旁路（已核）
#2049 | APPLICABLE(复核排除) | connect+TTFB 超时 + 240s 请求预算 + 非流式 120s（已核）
#2012 | NOT_APPLICABLE | 无转换
#1999 | NOT_APPLICABLE | 无转换
#1990 | APPLICABLE(复核排除) | 唯一索引与路由 eq 同为大小写敏感，语义一致（已核）
#1975 | NOT_APPLICABLE | 仅 PostgreSQL
#1928 | NOT_APPLICABLE | 无 Bedrock
#1927 | APPLICABLE(复核排除) | 上游成功后解析异常→G1 uncertain 保留预扣（usage-missing 测试锁定）
#1903 | NOT_APPLICABLE | 无邮件
#1883 | NOT_APPLICABLE | 环境/部署问题
#1880 | APPLICABLE(复核排除) | 重试有界（3+空补2）、deadline 240s、熔断开路（已核）
#1768 | NOT_APPLICABLE | 熔断按计数不解析文本；死凭据 tracker 结构性覆盖
#1752 | FEATURE | embed 默认测试请求体
#1675 | APPLICABLE(复核排除) | 同 #1990
#1618 | NOT_APPLICABLE | 无 /v1/messages
#1470 | NOT_APPLICABLE | 无自定义首页
#1390 | NOT_APPLICABLE | 无后缀驱动参数注入
#1330 | APPLICABLE(复核排除) | embeddings 响应整包透传（rebuild 仅换 model），base64 编码保留（已核）
#1323 | APPLICABLE(复核排除) | passthrough 未知参数透传（已核）
#1103 | APPLICABLE(复核排除) | completion_tokens 含 reasoning（OpenAI 口径），计费不拆不少——厂商细分口径为需求
#1086 | APPLICABLE(复核排除) | 同 #1323
#1013 | APPLICABLE(复核排除) | 同 #1323
#994 | NOT_APPLICABLE | 无 OIDC
#952 | NOT_APPLICABLE | 无 audio
#884 | APPLICABLE(复核排除) | eventsource-parser 无行长上限，不截断（已核）
#792 | NOT_APPLICABLE | 无内容变换
#767 | NOT_APPLICABLE | 不查上游余额
#513 | UI | 前端加载
```

## 统计

| 类别 | 数量 | 说明 |
|---|---|---|
| APPLICABLE（含已跟踪/已验证/复核排除） | 89 | 其中真正新确认：BUG-E、BUG-F；其余 87 项全部主 agent 复核排除（多数早前轮次已验证） |
| NOT_APPLICABLE | 187 | 无对应子系统（视频/转换/支付/分组/邮件/OIDC 等）或设计不同 |
| UI | 18 | 纯控制台缺陷 |
| FEATURE | 9 | 变相需求 |
| UNCLEAR | 3 | 摘要不足以判定（#5004/#4232/#3302） |
| **合计** | **301** | |
