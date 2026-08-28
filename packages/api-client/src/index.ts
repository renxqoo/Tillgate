/**
 * @tillgate/api-client 根入口:框架无关 transport / 错误 / 分页 / 两面 facade / 手写 DTO。
 *
 * 硬约束:根入口不得 import next/——Next 装配只从 './next' 子入口
 * (src/next/index.ts)导出;由 __test__/architecture.test.ts 边界门禁执行。
 * 发布闭包:零私有 @tillgate/* 依赖,运行时零第三方依赖。
 */
export { ApiError, type ApiErrorBody } from './core/api-error';
export {
  createHttpClient,
  type ApiFetchOptions,
  type HeaderGetter,
  type HttpClient,
  type HttpClientOptions,
  type TokenGetter,
} from './core/client';
export { buildListQuery, type ListFetchOptions, type Paginated } from './core/pagination';

export {
  createClientApiClient,
  type ClientApiClient,
  type ClientApiClientOptions,
} from './client-api';
export type * from './dto/client-api';

export {
  createAdminApiClient,
  type AdminApiClient,
  type AdminApiClientOptions,
  type EndpointBindingRow,
  type MenuGroup,
} from './admin-api';
export type * from './dto/admin-api.generated';
