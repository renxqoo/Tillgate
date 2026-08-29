# @tillgate/control-plane

> 控制面配置能力:Provider/Channel/Model/RateCard/fx/目录的管理用例与只读快照边界(总纲 P4.2)。

一句话:「控制面配置」的全部写路径与配套读路径——Provider / Channel / Model 映射 /
RateCard / 目录汇率(fx) / 多源模型目录(catalog),外加渠道运营资金(进货/调账)与
上游连通性探针;网关热路径的只读快照经 port 供 `inference` 消费。

## 核心导出面

- `createControlPlane(env)` facade → `ControlPlane` 七组用例:
  `providers` / `channels`(含 `import` / `probe` / `recharge` / `adjust`,进货调账幂等)/
  `models`(映射与渠道绑定)/ `rates`(费率卡与卡内用户)/ `fx`(refresh/override/buffer)/
  `catalog`(多源目录比较与导入)/ `admins`(管理员资料,登录凭据在 identity)。
- 装配必填注入(零缺省,铁律 3):`db` / `cipher`(渠道 Key AES-256-GCM)/
  `capabilities`(可执行协议词表快照,assembly 从 `ai` 取——本包不 import ai)/
  `probe`(上游探针)/ `sources`(目录源注册表)等。
- 领域纯函数:`formatCoefficient` / `applyBuffer`(fx)、`mapModelsDevCatalog` /
  `compareCatalog` / `toCny`(目录)、`maskUpstreamKey`、`commandFingerprint`(幂等指纹)。
- port 契约(装配桥):`UpstreamProbe` / `SecretCipher` / `CatalogSource` /
  `EnabledModelRow` / `RouteCandidateRow` / `AuditSink` 等。
- `controlPlaneErrors` 错误目录;`./composition` 子入口(仅 assembly / 迁移脚本):
  目录源 adapter `createOpenRouterSource` / `modelsDevSource` + 热路径读工厂
  `postgresModelStore` / `postgresChannelStore` / `postgresRateCardStore`。

## 目录结构

```
src/
├── control-plane.ts  # createControlPlane facade:适配器族组装 + 分组用例收敛
├── application/      # 用例层:providers/channels/models/rates/fx/catalog/admins
├── domain/           # 领域纯函数:rate-card/fx/catalog/model/channel/operation/list
├── adapters/         # postgres store 族 + model-sources(目录源)
├── ports/            # store 与桥接契约(model-store/channel-store/audit-sink/...)
├── errors.ts         # controlPlaneErrors 目录
├── composition.ts    # 装配子入口(目录源 + 热路径读工厂)
└── index.ts          # 唯一公共出口(boundary.test.ts 快照锁定)
```

## 装配

消费方:`apps/admin-api`(facade 全量 + `./composition` 目录源)、`apps/gateway`
(`postgresModelStore` 热路径读)、`apps/worker`(`postgresChannelStore`)、
`apps/client-api`(`postgresModelStore` / `postgresRateCardStore` 经 pricing-read 适配器)。

## 开发

```bash
cd packages/control-plane
bun run typecheck && bun run lint && bun run test
DATABASE_URL=postgres://... bun run test:real   # postgres.real.test.ts 真库门(不可达整组 skip)
```
