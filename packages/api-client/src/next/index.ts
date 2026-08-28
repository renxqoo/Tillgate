/**
 * @tillgate/api-client/next 子入口:Next BFF 装配(会话 cookie / 语言协商 / 转发 IP /
 * env 基地址工厂)。根入口(../index.ts)禁止 import 本目录,
 * 由 __test__/architecture.test.ts 边界门禁执行。Next 为 peer dependency。
 */
export * from './session';
export * from './locale';
export * from './forwarded-ip';
export * from './clients';
