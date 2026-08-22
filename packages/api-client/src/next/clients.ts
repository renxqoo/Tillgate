/**
 * Next BFF 装配工厂(仅 ./next 子入口):env 基地址解析 + 会话/语言/转发 IP 出口头注入。
 * 根入口的 baseUrl 必填(铁律 3);env 读取与 dev 兜底只存在于本装配层(DESIGN §3.1)。
 */
import { createAdminApiClient, type AdminApiClient } from '../admin-api';
import { createClientApiClient, type ClientApiClient } from '../client-api';
import { outgoingLocale } from './locale';
import { getSessionToken, getAdminSessionToken } from './session';
import { outgoingUserIpHeader } from './forwarded-ip';

/**
 * API 基地址解析:显式 env 优先,缺省回落本地 dev 端口(bun dev 直跑开箱即用)。
 * 生产安全不依赖兜底——compose 部署由 console 容器 environment 段显式注入
 * 容器网络地址;仅当「生产既未注入又直跑前端」时才会指到 localhost 并以
 * 连接失败显式暴露,不会静默串数据。
 * 惰性解析(首次调用时才要求配置):用户面前端不引用 ADMIN_API_BASE(反之亦然),
 * 模块加载期不因未用到的基地址缺失而炸(Next 构建期 collect page data 会加载模块)。
 */
function baseOrDefault(name: 'CLIENT_API_BASE' | 'ADMIN_API_BASE', devBase: string): string {
  return process.env[name] || devBase;
}

let clientApiBase: string | null = null;
let adminApiBase: string | null = null;

/** client-api(用户面)基地址(env CLIENT_API_BASE,dev 兜底 http://localhost:8081) */
export function getClientApiBase(): string {
  return (clientApiBase ??= baseOrDefault('CLIENT_API_BASE', 'http://localhost:8081'));
}

/** admin-api(管理面)内网地址(env ADMIN_API_BASE,dev 兜底 http://localhost:8082) */
export function getAdminApiBase(): string {
  return (adminApiBase ??= baseOrDefault('ADMIN_API_BASE', 'http://localhost:8082'));
}

/** 出站附加头:accept-language(与 UI 同源协商)+ x-forwarded-for(可信代理解出的用户 IP) */
async function outgoingBffHeaders(): Promise<Record<string, string>> {
  return { 'accept-language': await outgoingLocale(), ...(await outgoingUserIpHeader()) };
}

export interface NextApiClientOptions {
  /** 覆盖 env 解析的基地址(测试/自定义部署用) */
  baseUrl?: string;
  /** 覆盖 globalThis.fetch(测试用) */
  fetch?: typeof globalThis.fetch;
}

/** 用户面 client:client-api 基地址 + ag_session 会话 + BFF 出口头 */
export function createNextClientApiClient(options: NextApiClientOptions = {}): ClientApiClient {
  return createClientApiClient({
    baseUrl: options.baseUrl ?? getClientApiBase(),
    fetch: options.fetch,
    getToken: getSessionToken,
    getHeaders: outgoingBffHeaders,
  });
}

/** 管理面 client:admin-api 基地址 + ag_admin_session 会话 + BFF 出口头 */
export function createNextAdminApiClient(options: NextApiClientOptions = {}): AdminApiClient {
  return createAdminApiClient({
    baseUrl: options.baseUrl ?? getAdminApiBase(),
    fetch: options.fetch,
    getToken: getAdminSessionToken,
    getHeaders: outgoingBffHeaders,
  });
}
