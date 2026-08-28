/**
 * OpenAPI registry 聚合器（生成链唯一出口）。
 * buildAdminOpenApiDocument():registry → OpenAPI 3.1 文档（纯函数,确定性输出——
 * scripts/generate-openapi.ts 与 __test__/openapi.test.ts 共用,锁逐字节重生成相等）。
 * 转换口径:请求面 io:'input'（transform/coerce 取 wire 输入侧）,响应面 io:'output';
 * $defs 引用重写为 #/components/schemas/*（未登记目标的 $ref 直接抛错——registry 漏登记守卫）;
 * additionalProperties:false 统一剥除（zod 非 strict object 对未知键是静默剥离而非拒绝,
 * closed-world 断言由 contracts 运行时校验承担,不在 schema 里重复）。
 */
import * as z from 'zod';
import { plansContracts, redeemContracts, reviewContracts } from '../contracts/billing-admin';
import { channelsContracts, providersContracts } from '../contracts/control-plane';
import { keysContracts } from '../contracts/users';
import { modelsContracts } from '../contracts/models';
import { rateCardsContracts } from '../contracts/rates';
import { adminsContracts } from '../contracts/admins';
import { authEndpoints } from './auth';
import { usersEndpoints } from './users';
import { adminsEndpoints, adminRowSchema, adminCreatedSchema } from './admins';
import { rbacEndpoints, roleRowSchema, permissionNodeSchema } from './rbac';
import { controlPlaneEndpoints } from './control-plane';
import { modelsEndpoints } from './models';
import { catalogEndpoints } from './catalog';
import { rateCardsEndpoints } from './rates';
import { billingAdminEndpoints } from './billing-admin';
import { observabilityEndpoints } from './observability';
import { inferenceEndpoints } from './inference';
import { marketingEndpoints } from './marketing';
import { notificationsEndpoints } from './notifications';
import { integrationItemSchema, settingsEndpoints } from './settings';
import { errorEnvelopeSchema, requestBody, responseComponent } from './shared';
import type { DtoComponent, OpenApiEndpoint } from './shared';
import { adminMeInfoSchema } from './auth';
import { adminKeyRowSchema, adminTransactionRowSchema, adminUserRowSchema } from './users';
import {
  adminChannelFundRowSchema,
  adminChannelRowSchema,
  adminProviderRowSchema,
  channelOptionSchema,
  channelTestResultSchema,
  providerOptionSchema,
} from './control-plane';
import { adminModelRowSchema } from './models';
import { adminRateCardRowSchema, rateCardOptionSchema } from './rates';
import {
  adminBatchRowSchema,
  adminSubscriptionRowSchema,
  batchCreatedSchema,
  deadCaseRowSchema,
  planRowSchema,
  redeemCodeRowSchema,
} from './billing-admin';
import {
  adminUsageRowSchema,
  auditLogRowSchema,
  channelHealthRowSchema,
  logRowSchema,
  statsOverviewSchema,
  statsTrendRowSchema,
  statsTrendsSchema,
  statsUsageItemSchema,
  traceDetailDtoSchema,
  traceSpanRowSchema,
  traceSummaryRowSchema,
  traceTopologyResponseSchema,
  tracingStatsResponseSchema,
} from './observability';

// ---- 域端点清单（固定顺序 = openapi.json paths 键序;新增域文件在此登记）----
export const adminApiEndpoints: readonly OpenApiEndpoint[] = [
  ...authEndpoints,
  ...usersEndpoints,
  ...adminsEndpoints,
  ...rbacEndpoints,
  ...controlPlaneEndpoints,
  ...modelsEndpoints,
  ...catalogEndpoints,
  ...rateCardsEndpoints,
  ...billingAdminEndpoints,
  ...observabilityEndpoints,
  ...inferenceEndpoints,
  ...marketingEndpoints,
  ...notificationsEndpoints,
  ...settingsEndpoints,
];

// ---- DTO 组件登记（顺序 = api-client 生成物导出顺序）----
export const adminApiDtoComponents: readonly DtoComponent[] = [
  responseComponent('AdminMeInfo', adminMeInfoSchema, 'me'),
  responseComponent('AdminRow', adminRowSchema, 'admins'),
  responseComponent('AdminCreatedRow', adminCreatedSchema, 'admins'),
  responseComponent('IntegrationSettingItem', integrationItemSchema, 'settings'),
  responseComponent('RoleRow', roleRowSchema, 'roles'),
  responseComponent('PermissionNode', permissionNodeSchema, 'permissions'),
  requestBody(
    'AdminCreateBody',
    adminsContracts.create,
    '创建管理员请求体（POST /v1/admins;字段真相 = contracts zod——角色词表封闭,密码策略单源在 identity）',
    'admins',
  ),
  requestBody(
    'AdminPatchBody',
    adminsContracts.patch,
    '更新管理员请求体（PATCH /v1/admins/:id;字段真相 = contracts zod——role/status 不可改自身）',
    'admins',
  ),
  responseComponent('AdminUserRow', adminUserRowSchema, 'users'),
  responseComponent('AdminTransactionRow', adminTransactionRowSchema, 'users'),
  responseComponent('AdminChannelRow', adminChannelRowSchema, 'channels'),
  requestBody(
    'ChannelCreateBody',
    channelsContracts.create,
    '创建渠道请求体（POST /v1/channels;字段真相 = contracts zod——models 线上契约是 string[]）',
    'channels',
  ),
  requestBody(
    'ChannelUpdateBody',
    channelsContracts.update,
    '更新渠道请求体（PATCH /v1/channels/:id;字段真相 = contracts zod;rpmLimit/tpmLimit null=不限流）',
    'channels',
  ),
  responseComponent('ChannelTestResult', channelTestResultSchema, 'channels'),
  responseComponent('AdminProviderRow', adminProviderRowSchema, 'providers'),
  requestBody(
    'ProviderCreateBody',
    providersContracts.create,
    '创建供应商请求体（POST /v1/providers;字段真相 = contracts zod;vendor 空 = 纯透传）',
    'providers',
  ),
  responseComponent('AdminModelRow', adminModelRowSchema, 'models'),
  requestBody(
    'ModelCreateBody',
    modelsContracts.create,
    '创建模型映射请求体（POST /v1/models;字段真相 = contracts zod,价格十进制字符串,unitPrice 收 string | number）',
    'models',
  ),
  requestBody(
    'ModelUpdateBody',
    modelsContracts.update,
    '更新模型映射请求体（PATCH /v1/models/:id;字段真相 = contracts zod——fallbackModels/paramRules 不在更新面）',
    'models',
  ),
  responseComponent('AdminKeyRow', adminKeyRowSchema, 'keys'),
  requestBody(
    'AdminKeyUpdateBody',
    keysContracts.patch,
    'Key 限额与状态补丁请求体（PATCH /v1/admin-keys/:id;字段真相 = contracts zod;null=不限流）',
    'keys',
  ),
  responseComponent('AdminChannelFundRow', adminChannelFundRowSchema, 'channel-funds'),
  responseComponent('AdminRateCardRow', adminRateCardRowSchema, 'rate-cards'),
  requestBody(
    'RateCardCreateBody',
    rateCardsContracts.create,
    '创建费率卡请求体（POST /v1/rate-cards;字段真相 = contracts zod,系数 0.001..9.999）',
    'rate-cards',
  ),
  requestBody(
    'RateCardUpdateBody',
    rateCardsContracts.update,
    '更新费率卡请求体（PATCH /v1/rate-cards/:id;字段真相 = contracts zod;description null=清除）',
    'rate-cards',
  ),
  responseComponent('AdminBatchRow', adminBatchRowSchema, 'redeem-batches'),
  requestBody(
    'BatchCreateBody',
    redeemContracts.create,
    '创建兑换批次请求体（POST /v1/redeem-batches;字段真相 = contracts zod,amount 十进制字符串）',
    'redeem-batches',
  ),
  responseComponent('BatchCreated', batchCreatedSchema, 'redeem-batches'),
  responseComponent('RedeemCodeRow', redeemCodeRowSchema, 'redeem-batches'),
  responseComponent('StatsOverview', statsOverviewSchema, 'stats'),
  responseComponent('StatsUsageItem', statsUsageItemSchema, 'stats'),
  responseComponent('StatsTrendRow', statsTrendRowSchema, 'stats'),
  responseComponent('StatsTrends', statsTrendsSchema, 'stats'),
  responseComponent('LogRow', logRowSchema, 'stats'),
  responseComponent('AdminUsageRow', adminUsageRowSchema, 'stats'),
  responseComponent('AuditLogRow', auditLogRowSchema, 'stats'),
  responseComponent('ProviderOption', providerOptionSchema, 'options'),
  responseComponent('ChannelOption', channelOptionSchema, 'options'),
  responseComponent('RateCardOption', rateCardOptionSchema, 'options'),
  responseComponent('PlanRow', planRowSchema, 'plans'),
  requestBody(
    'PlanCreateBody',
    plansContracts.create,
    '创建套餐请求体（POST /v1/plans;字段真相 = contracts zod——price/quotaAmount 是十进制字符串,kind 不可变）',
    'plans',
  ),
  requestBody(
    'PlanUpdateBody',
    plansContracts.update,
    '更新套餐请求体（PATCH /v1/plans/:id;字段真相 = contracts zod——kind 创建后不可变）',
    'plans',
  ),
  responseComponent('AdminSubscriptionRow', adminSubscriptionRowSchema, 'subscriptions'),
  responseComponent('DeadCaseRow', deadCaseRowSchema, 'billing-operations'),
  requestBody(
    'DeadCaseDecisionBody',
    reviewContracts.decision,
    '死单复核决策体（retry/abandon 同形;理由必填;expectedRevision 乐观锁——字段真相 = contracts zod）',
    'billing-operations',
  ),
  responseComponent('TraceSummaryRow', traceSummaryRowSchema, 'tracing'),
  responseComponent('TraceSpanRow', traceSpanRowSchema, 'tracing'),
  responseComponent('TraceDetailDto', traceDetailDtoSchema, 'tracing'),
  responseComponent('ChannelHealthRow', channelHealthRowSchema, 'tracing'),
  responseComponent('TraceTopologyResponse', traceTopologyResponseSchema, 'tracing'),
  responseComponent('TracingStatsResponse', tracingStatsResponseSchema, 'tracing'),
];

// ---- JSON Schema 转换与后处理 ----

type JsonSchema = Record<string, unknown>;

/** 递归后处理:剥 $schema/$defs/additionalProperties:false,重写 $defs 引用为组件引用 */
function normalize(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalize(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as JsonSchema;
  delete obj.$schema;
  delete obj.$defs;
  if (obj.additionalProperties === false) delete obj.additionalProperties;
  if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/$defs/')) {
    obj.$ref = `#/components/schemas/${obj.$ref.slice('#/$defs/'.length)}`;
  }
  for (const value of Object.values(obj)) normalize(value);
}

/** zod 实例 → 规范化 JSON Schema 片段（io:请求面 input/响应面 output） */
function convert(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const converted = z.toJSONSchema(schema, { io, target: 'draft-2020-12' }) as JsonSchema;
  normalize(converted);
  return converted;
}

/** 根描述/x-domain 剥除后的稳定比较键（$ref 判重用——registry 登记元数据不影响形状相等） */
function shapeKey(node: JsonSchema): string {
  const { description: _desc, 'x-domain': _domain, ...rest } = node;
  return JSON.stringify(rest);
}

/** 收集片段内全部组件引用（漏登记守卫） */
function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (key === '$ref' && typeof value === 'string') into.add(value);
    else collectRefs(value, into);
  }
}

/** 文档构建（纯函数;两次调用输出逐字节相等） */
// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- 注册表→JSON 形状的数据装配平铺(组件/端点逐项遍历,语句与分支皆来自字段映射)
export function buildAdminOpenApiDocument(): JsonSchema {
  // 组件名唯一性守卫 + 组件装配（x-domain 供 api-client 生成物分组注释）
  const componentNames = new Set<string>();
  const schemas: JsonSchema = {};
  for (const component of adminApiDtoComponents) {
    if (componentNames.has(component.name)) {
      throw new Error(`[openapi] duplicate dto component: ${component.name}`);
    }
    componentNames.add(component.name);
    schemas[component.name] = {
      'x-domain': component.domain,
      ...convert(component.schema, component.io),
      ...(component.description === undefined ? {} : { description: component.description }),
    };
  }

  const errorEnvelope = convert(errorEnvelopeSchema, 'output');

  /** 与组件形状全等 → 换 $ref（requestBody/response 复用组件,不内联重复） */
  function refOrInline(converted: JsonSchema): JsonSchema {
    for (const [name, schema] of Object.entries(schemas)) {
      if (shapeKey(schema as JsonSchema) === shapeKey(converted)) {
        return { $ref: `#/components/schemas/${name}` };
      }
    }
    return converted;
  }

  const paths: JsonSchema = {};
  const seen = new Set<string>();
  for (const endpoint of adminApiEndpoints) {
    const id = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    if (seen.has(id)) throw new Error(`[openapi] duplicate endpoint: ${id}`);
    seen.add(id);

    const parameters: JsonSchema[] = [];
    for (const param of endpoint.params ?? []) {
      parameters.push({
        name: param.name,
        in: 'path',
        required: true,
        description: param.description,
        schema: convert(param.schema, 'output'),
      });
    }
    if (endpoint.query !== undefined) {
      const query = convert(endpoint.query, 'input');
      const required = new Set((query.required as string[] | undefined) ?? []);
      for (const [name, property] of Object.entries(
        (query.properties as JsonSchema | undefined) ?? {},
      )) {
        parameters.push({
          name,
          in: 'query',
          required: required.has(name),
          schema: property,
        });
      }
    }

    const status = String(endpoint.response.status ?? 200);
    const responses: JsonSchema = {
      [status]: {
        description: endpoint.response.description ?? `${endpoint.summary} 成功响应`,
        content: {
          'application/json': { schema: refOrInline(convert(endpoint.response.schema, 'output')) },
        },
      },
    };
    const codes = new Set(endpoint.errors ?? []);
    if (endpoint.auth !== 'public') {
      codes.add(401);
      codes.add(403); // 受护端点经 guard(code),无权 403
    }
    for (const code of [...codes].toSorted((a, b) => a - b)) {
      responses[String(code)] = {
        description: `错误响应（统一信封 { error: { code, message, context? } }）`,
        content: { 'application/json': { schema: { ...errorEnvelope } } },
      };
    }

    const operation: JsonSchema = {
      tags: [endpoint.tag],
      summary: endpoint.summary,
      ...(endpoint.auth === 'public' ? { security: [] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(endpoint.body !== undefined
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: refOrInline(convert(endpoint.body, 'input')) },
              },
            },
          }
        : {}),
      responses,
    };

    const pathItem = (paths[endpoint.path] ?? {}) as JsonSchema;
    if (Object.keys(pathItem).length === 0) paths[endpoint.path] = pathItem;
    pathItem[endpoint.method] = operation;
  }

  // tags 按端点声明顺序去重收集（词表封闭）
  const tags: JsonSchema[] = [];
  const tagNames = new Set<string>();
  for (const endpoint of adminApiEndpoints) {
    if (!tagNames.has(endpoint.tag)) {
      tagNames.add(endpoint.tag);
      tags.push({ name: endpoint.tag });
    }
  }

  const doc: JsonSchema = {
    openapi: '3.1.0',
    info: {
      title: '@tillgate/admin-api',
      version: '0.1.0',
      description:
        '管理控制面 REST API（contract → OpenAPI → generated client 生成链产物;registry 单一事实源 = src/http/openapi）。' +
        '统一列表契约 ?page&page_size≤100&q&sort_by&order（sort_by 白名单外 400）;列表信封 {rows,total,page,pageSize};' +
        '错误统一信封 { error: { code, message, context? } }。',
    },
    tags,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas,
    },
    paths,
  };

  // 漏登记守卫:全部组件引用必须可解析（$defs 残留/未登记 meta id 在此暴露）
  const refs = new Set<string>();
  collectRefs(doc, refs);
  for (const ref of refs) {
    if (!ref.startsWith('#/components/schemas/')) {
      throw new Error(`[openapi] unresolved ref target: ${ref}`);
    }
    const target = ref.slice('#/components/schemas/'.length);
    if (!componentNames.has(target)) {
      throw new Error(`[openapi] ref target not registered as dto component: ${target}`);
    }
  }
  return doc;
}
