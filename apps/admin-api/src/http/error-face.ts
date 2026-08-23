/**
 * 错误面装配（v1 error-map.ts 的目录体系替身——E1/E3 病灶核销）：
 * 全量目录合成（http + 六能力包 + app 自有 admin.*），路由只抛目录业务错误,
 * errorHandler 按 nature/category 分派渲染,PG SQLSTATE 仅兜底注入。
 * message 英文(铁律 18),中文经目录 zh 字段按 Accept-Language 协商。
 */
import { composeErrorCatalogs } from '@tokenlens/errors';
import { HttpErrors } from '@tokenlens/http';
import { AccountsErrors } from '@tokenlens/accounts';
import { controlPlaneErrors } from '@tokenlens/control-plane';
import { BillingErrors } from '@tokenlens/billing';
import { observabilityErrors } from '@tokenlens/observability';
import { identityErrors } from '@tokenlens/identity';
import { defineErrorCatalog } from '@tokenlens/errors';

/** app 自有目录 admin.*：只登记 app 协议层抛点的边界码（铁律 4：无抛点不登记） */
export const AdminErrors = defineErrorCatalog('admin', {
  invalid_param: {
    category: 'invalid_input',
    message: 'Invalid request parameter',
    zh: '请求参数无效',
  },
  invalid_sort_field: {
    category: 'invalid_input',
    message: 'Unsupported sort field',
    zh: '不支持的排序字段',
  },
  /** 目录源路径参数未知（v1 catalog_source_not_found 语义;404 不泄漏源清单） */
  catalog_source_not_found: {
    category: 'not_found',
    message: 'Unknown catalog source',
    zh: '未知的目录源',
  },
});

/** 全量目录(app 唯一错误事实源;handler 渲染与测试断言共用) */
export const adminErrorCatalog = composeErrorCatalogs(
  HttpErrors,
  AccountsErrors,
  controlPlaneErrors,
  BillingErrors,
  observabilityErrors,
  identityErrors,
  AdminErrors,
);
