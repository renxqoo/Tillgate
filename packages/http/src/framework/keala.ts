/**
 * keala 框架收口层：本仓库统一的中断件/上下文/路由注册类型面。
 *
 * keala 无 Hono 的 Env 泛型——请求级变量的类型收窄走 `ContextOf<V>`
 * （`c.state` 形状交叉），注册面（app/router 方法只收窄基础 Context）经
 * `routes<C>()` 门面做一次集中适配，散点不出现 `as` 断言。
 */
import {
  Router,
  type Application,
  type Context,
  type Middleware as KealaHandler,
  type Next,
  type RequestBodyFacade,
} from 'keala';

/** keala Context/Next 再导出（本仓库统一 import 路径；Next 自 0.6.1 起根导出） */
export type { Context, Next } from 'keala';

/** 中间件/处理器形态：(c, next)，返回 Response 即提交，void 透传洋葱 */
export type Middleware<C extends Context = Context> = (
  c: C,
  next: Next,
) => Response | void | Promise<Response | void>;

/** Hono `Hono<Env>` Variables 泛型的替代：`c.state` 形状收窄（interface 形态亦可） */
export type ContextOf<V extends object> = Context & { state: V };

/** 已装 bodyParser 插件的上下文（c.req.* facade 可用） */
export type ContextWithBody = Context & { req: RequestBodyFacade };

/** 测试/装配糖：保留 Hono `app.request(path, init)` 签名（相对路径基于 localhost 解析） */
export type App = Application & {
  request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
};

export function withRequest(app: Application): App {
  const adapted = app as App;
  adapted.request = (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), 'http://localhost').toString(), init);
    // keala 0.6.0 起 handle() 恒 Promise<Response> 且不 reject
    return app.handle(request);
  };
  return adapted;
}

/** 注册面适配：带收窄 Context 的处理器 → keala 处理器类型（运行时直传，仅类型桥） */
const asRoute = <C extends Context>(handlers: Middleware<C>[]): KealaHandler[] =>
  handlers as unknown as KealaHandler[];

export interface Routes<C extends Context> {
  /** 底层 Router（app.mount 用；不再直接在上面注册以保住类型收窄） */
  readonly router: Router;
  use(...middlewares: Middleware<C>[]): void;
  get(path: string, ...handlers: Middleware<C>[]): void;
  post(path: string, ...handlers: Middleware<C>[]): void;
  put(path: string, ...handlers: Middleware<C>[]): void;
  patch(path: string, ...handlers: Middleware<C>[]): void;
  delete(path: string, ...handlers: Middleware<C>[]): void;
}

/**
 * 类型化路由组（对应旧 `new Hono<Env>()` 子应用）：`app.mount(path, r.router)` 挂载。
 * 路由组级中间件（router.use）在该挂载域内先于 handler 执行。
 */
export function routes<C extends Context = Context>(prefix?: string): Routes<C> {
  const router = new Router(prefix === undefined ? {} : { prefix });
  return {
    router,
    use: (...middlewares) => router.use(...asRoute(middlewares)),
    get: (path, ...handlers) => void router.get(path, ...asRoute(handlers)),
    post: (path, ...handlers) => void router.post(path, ...asRoute(handlers)),
    put: (path, ...handlers) => void router.put(path, ...asRoute(handlers)),
    patch: (path, ...handlers) => void router.patch(path, ...asRoute(handlers)),
    delete: (path, ...handlers) => void router.delete(path, ...asRoute(handlers)),
  };
}

/** 全局中间件注册适配（app.use 场景的收窄类型桥） */
export const asMiddleware = <C extends Context>(middleware: Middleware<C>): KealaHandler =>
  middleware as unknown as KealaHandler;

/**
 * 前缀门控中间件（keala 无路径作用域 use）：命中前缀（路径本身或其子路径）才
 * 执行 inner，其余直通。前缀表来自装配层，不在底层写死。
 */
export function pathPrefixGate<C extends Context>(
  prefixes: readonly string[],
  inner: Middleware<C>,
): Middleware<C> {
  return async (c, next) => {
    if (prefixes.some((p) => c.path === p || c.path.startsWith(`${p}/`))) {
      await inner(c, next);
      return;
    }
    await next();
  };
}
