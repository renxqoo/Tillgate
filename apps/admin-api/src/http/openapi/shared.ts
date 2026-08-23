/**
 * OpenAPI registry 基底（P3「contract → OpenAPI → generated client」生成链）。
 * 本目录是 admin-api HTTP 面的机器可读契约单一事实源：
 *   - 请求/查询面引用既有 contracts zod 实例（引用不复制——运行时校验单一真相不变）;
 *   - 响应面 wire 形状以 zod 声明在此（P3「wire schema 逐个迁入」:响应 schema 的
 *     单一真相从 api-client 手写 DTO 移入本 registry,zod→JSON Schema→TS 全链单源）。
 * 产物:scripts/generate-openapi.ts → generated/openapi.json（入库,api-client DESIGN §3.4）;
 * 门禁:__test__/openapi.test.ts 锁重生成逐字节相等 + 端点词表封闭 + 与 routes 对账。
 * 本目录不属于运行时热路径:routes 不 import 此处（仅 scripts/__test__/generator 消费）。
 */
import { z } from 'zod';
import { listQuerySchema } from '@tokenlens/http';

export type OpenApiMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

/** path 参数声明（JSON Schema 由 zod 实例转换） */
export interface OpenApiParam {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
}

/** registry 端点声明（每域文件产出,openapi/index.ts 聚合成文档） */
export interface OpenApiEndpoint {
  readonly method: OpenApiMethod;
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  /** 公开端点（不挂会话件,如 auth/login）;缺省 = Bearer 会话 */
  readonly auth?: 'public';
  readonly params?: readonly OpenApiParam[];
  /** 查询参数 zod object（通常 = listQuery(extra) 或 contracts 查询实例） */
  readonly query?: z.ZodType;
  /** 请求体:引用 contracts 的 zod 实例 */
  readonly body?: z.ZodType;
  readonly response: Readonly<{
    readonly schema: z.ZodType;
    readonly status?: 200 | 201;
    readonly description?: string;
  }>;
  /** 主要错误码（统一信封 { error: { code, message, context? } };会话面自动补 401） */
  readonly errors?: readonly number[];
}

/** 通用 path 参数:id（正整数,contracts/common idParam 同口径） */
export function idPathParam(description = '资源 id（正整数）'): OpenApiParam {
  return { name: 'id', description, schema: z.number().int().min(1) };
}

/** 死单/订单 requestId 路径参数（uuid 形状,contracts/billing-admin requestIdParam） */
export const requestIdPathParam: OpenApiParam = {
  name: 'requestId',
  description: '计费请求 id（uuid 形状）',
  schema: z.string().min(16).max(64),
};

/** 列表信封 {rows,total,page,pageSize}（contracts/common listEnvelope 同形） */
export function paginatedOf<T extends z.ZodType>(row: T) {
  return z.object({
    rows: z.array(row),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });
}

/** 统一列表查询（?page&page_size≤100&q&sort_by&order + 域 extra）——引用 http 货架不复制 */
export function listQuery(extra?: z.ZodObject<z.ZodRawShape>) {
  return extra === undefined ? listQuerySchema : listQuerySchema.extend(extra.shape);
}

/** 统一错误信封（@tokenlens/http renderError 形状） */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** 幂等动作通用回执 {ok:true} */
export const okTrue = z.object({ ok: z.literal(true) });

/** 生成链 DTO 组件登记项（顺序 = api-client 生成物导出顺序） */
export interface DtoComponent {
  readonly name: string;
  readonly schema: z.ZodType;
  /** 请求体组件取输入面（transform/coerce 按 wire 输入生成）;响应组件取输出面 */
  readonly io: 'input' | 'output';
  /** 生成物分组注释（x-domain） */
  readonly domain: string;
  /** 接口级 jsdoc 来源（openapi description）;响应组件的描述已在 .meta 内 */
  readonly description?: string;
}

/** 请求体组件:contracts 实例直接登记（形状单一真相在 contracts,不克隆）。 */
export function requestBody(
  name: string,
  schema: z.ZodType,
  description: string,
  domain: string,
): DtoComponent {
  return { name, schema, io: 'input', domain, description };
}

/** 响应组件:域文件内已以 .meta({id,description}) 声明的 wire 形状 */
export function responseComponent(name: string, schema: z.ZodType, domain: string): DtoComponent {
  return { name, schema, io: 'output', domain };
}
