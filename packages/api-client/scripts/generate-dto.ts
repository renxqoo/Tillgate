/**
 * admin-api DTO 生成脚本（P3 生成链第二段;P6 C1 换轨终结手写双轨）。
 * 用法:bun run generate:dto（或 bun scripts/generate-dto.ts）。
 * 输入:apps/admin-api/generated/openapi.json（入库交付物——本包不依赖
 * 任何私有 @tillgate/* workspace,生成从 checkout 内可复现;DESIGN §3.4）。
 * 输出:src/dto/admin-api.generated.ts（同路径覆盖,**GENERATED——禁止手改**;
 * __test__/generated-dto.test.ts 锁头标记/逐字节重渲/导出集合快照）。
 *
 * renderAdminApiDto 是纯函数（openapi 文档 → TS 源码文本）,供测试 in-memory 重渲。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** openapi 文档的 JSON Schema 节点（生成器只消费,不做完整校验） */
type SchemaNode = Record<string, unknown>;

const REF_PREFIX = '#/components/schemas/';

/** $ref → 组件名（非组件引用在此抛错——生成器只接受组件引用面） */
function refName(node: SchemaNode): string {
  const ref = node.$ref as string;
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) {
    throw new Error(`[generate-dto] unsupported $ref target: ${String(ref)}`);
  }
  return ref.slice(REF_PREFIX.length);
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 字面量渲染（枚举/const 值 → 单引号字面量;数字直出） */
function literal(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** JSON Schema → TS 类型文本（wire 事实优先;date-time 是 string 不映射 Date） */
function tsType(node: SchemaNode): string {
  if (typeof node.$ref === 'string') return refName(node);
  if (Array.isArray(node.anyOf)) {
    // 嵌套 anyOf 展平（zod union+nullable 会产生 anyOf 套 anyOf）
    const members: string[] = [];
    for (const member of node.anyOf) {
      if (!isSchemaNode(member)) continue;
      const text = tsType(member);
      for (const part of text === 'null' ? ['null'] : splitTopLevelUnion(text)) {
        if (!members.includes(part)) members.push(part);
      }
    }
    return members.join(' | ');
  }
  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => literal(value)).join(' | ');
  }
  const type = node.type;
  if (type === 'string') return 'string';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    const items = tsType(node.items as SchemaNode);
    return splitTopLevelUnion(items).length > 1 ? `(${items})[]` : `${items}[]`;
  }
  if (type === 'object') {
    const properties = node.properties as Record<string, SchemaNode> | undefined;
    if (properties !== undefined && Object.keys(properties).length > 0) {
      const required = new Set((node.required as string[] | undefined) ?? []);
      const lines = Object.entries(properties).map(
        ([name, property]) =>
          `${docLine(property)}${name}${required.has(name) ? '' : '?'}: ${tsType(property)}`,
      );
      return `{ ${lines.join('; ')} }`;
    }
    const additional = node.additionalProperties;
    if (isSchemaNode(additional)) return `Record<string, ${tsType(additional)}>`;
    return 'unknown';
  }
  // z.unknown()/空 schema——按 wire 事实取 unknown
  return 'unknown';
}

/** 顶层 `A | B` 拆分（跳过括号与引号内的竖线） */
function splitTopLevelUnion(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let current = '';
  for (const ch of text) {
    if (ch === '"' || ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      if (ch === '|' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** 字段/接口 jsdoc 单行文本（description 缺省不出注释;缩进由调用方决定） */
function docLine(node: SchemaNode): string {
  const description = node.description;
  return typeof description === 'string' && description !== '' ? `/** ${description} */` : '';
}

const FILE_HEADER = `/**
 * admin-api(管理面)wire DTO——GENERATED——禁止手改。
 *
 * 单一事实源:apps/admin-api/src/http/openapi registry → generated/openapi.json
 * (contract → OpenAPI → generated client 生成链;DESIGN §3.4)。重生成:
 *   cd apps/admin-api && bun run generate:openapi && cd ../../packages/api-client && bun run generate:dto
 * 文件为纯声明聚合(单一职责 = 管理面 wire 形状快照)。
 */
`;

/**
 * openapi 文档 → src/dto/admin-api.generated.ts 源码文本（纯函数,确定性输出）。
 * 组件按 components.schemas 插入序输出;x-domain 变化时插入分组注释。
 */
export function renderAdminApiDto(openapi: unknown): string {
  const spec = openapi as {
    components?: { schemas?: Record<string, SchemaNode & { 'x-domain'?: string }> };
  };
  const schemas = spec.components?.schemas;
  if (schemas === undefined)
    throw new Error('[generate-dto] openapi document has no components.schemas');

  const blocks: string[] = [];
  let currentDomain: string | undefined;
  for (const [name, schema] of Object.entries(schemas)) {
    const domain = schema['x-domain'];
    if (domain !== undefined && domain !== currentDomain) {
      blocks.push(`// ── ${domain} ─────────────────────────────────────`);
      currentDomain = domain;
    }
    const docComment = docLine(schema);
    blocks.push(
      `${docComment === '' ? '' : `${docComment}\n`}export interface ${name} ${renderInterfaceBody(schema)}`,
    );
  }
  return `${FILE_HEADER}\n${blocks.join('\n\n')}\n`;
}

/** 组件 → interface 体（字段按 properties 插入序;required 决定可选性） */
function renderInterfaceBody(schema: SchemaNode): string {
  const properties = schema.properties as Record<string, SchemaNode> | undefined;
  if (properties === undefined) {
    throw new Error('[generate-dto] dto component must be an object schema');
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const fields = Object.entries(properties).map(([name, property]) => {
    const doc = docLine(property);
    const optional = required.has(name) ? '' : '?';
    return `${doc === '' ? '' : `  ${doc}\n`}  ${safeFieldName(name)}${optional}: ${tsType(property)};`;
  });
  return `{\n${fields.join('\n')}\n}`;
}

/** JSON 保留字字段名加引号（wire 键名保持原样,如 max_tokens 无需处理——预留词表守卫） */
function safeFieldName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

// ---- CLI（bun 直跑时执行;被测试 import 时不触发）----
const runningAsMain = (import.meta as { main?: boolean; url?: string }).main === true;
if (runningAsMain) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const openapiPath = join(pkgRoot, '..', '..', 'apps', 'admin-api', 'generated', 'openapi.json');
  const outPath = join(pkgRoot, 'src', 'dto', 'admin-api.generated.ts');
  const openapi = JSON.parse(readFileSync(openapiPath, 'utf8')) as unknown;
  const source = renderAdminApiDto(openapi);
  writeFileSync(outPath, source);
  console.log(`src/dto/admin-api.generated.ts 已生成(${source.length} bytes;来源 ${openapiPath})`);
}
