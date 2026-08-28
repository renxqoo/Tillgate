/**
 * OpenAPI 生成脚本（生成链第一段）。
 * 用法:bun run generate:openapi（或 bun scripts/generate-openapi.ts）。
 * 产物:generated/openapi.json（OpenAPI 3.1,**产物入库**——api-client 生成与兼容性
 * diff 都以该交付物为准,api-client 不得 import admin-api 源码）。
 * 禁止手改产物:__test__/openapi.test.ts 锁重生成逐字节相等。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdminOpenApiDocument } from '../src/http/openapi/index';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated', 'openapi.json');

const json = `${JSON.stringify(buildAdminOpenApiDocument(), null, 2)}\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);
console.log(`openapi.json 已生成:${OUT}(${json.length} bytes)`);
