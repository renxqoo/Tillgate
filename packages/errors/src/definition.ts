/**
 * 错误目录契约（ADR-0001 D1-D3）：业务错误定义由能力包自有、随包分发；
 * app face 装配期合成全量目录；http 只做 category 默认渲染——本包不含任何业务条目。
 */
import { isErrorCategory, type ErrorCategory } from './category';
import { ROOT_ERROR_CODES } from './error-record';
import {
  BusinessError,
  DefectError,
  type BusinessCode,
  type ErrorContext,
  type ErrorOptions,
} from './nature';

/**
 * 错误定义（能力包目录条目）：
 * 不含 HTTP status（零协议依赖，ADR-0001 D5）；message/zh 必填——结构性消灭
 * v1「登记缺中文静默英文」与「message 即 code 直达用户」缺陷类（E8/E9）。
 */
export interface ErrorDefinition {
  readonly category: ErrorCategory;
  /** 默认英文文案：目录构造的错误一律用此文案，调用点不再传 message——face 按码本地化的前提 */
  readonly message: string;
  /** 中文文案 */
  readonly zh: string;
}

/** 目录查询面（face 装配与渲染消费的形状） */
export interface ErrorCatalog {
  /** 全部身份码（`namespace.key`） */
  readonly codes: readonly string[];
  /** 按完整身份码查定义；未命中返回 undefined */
  get(code: string): ErrorDefinition | undefined;
  has(code: string): boolean;
}

/** 绑定身份的完整目录条目（`entry()` 的返回；固化子类的零漂移构造材料，ADR-0001 D8） */
export interface CatalogEntry extends ErrorDefinition {
  /** 已签发的业务身份码（品牌类型——不可由目录外构造） */
  readonly code: BusinessCode;
}

/** 命名空间目录：能力包自有定义 + 身份码签发 + 受荐的抛出入口 */
export interface NamespacedErrorCatalog<N extends string, K extends string> extends ErrorCatalog {
  readonly namespace: N;
  /** 身份码签发（品牌类型；纯拼接，不做运行时校验——类型面已保证 key 合法） */
  code(key: K): BusinessCode;
  /**
   * 绑定身份的完整定义（code/category/message/zh 四元组，冻结）。
   * 固化子类（extends BusinessError）经此构造——类定义与目录单一真相，零漂移。
   */
  entry(key: K): CatalogEntry;
  /**
   * 自目录构造业务错误（受荐路径：身份/分类/文案单点来自定义，context 携带动态事实）。
   * 文案不可在调用点覆盖——动态事实进 context，保证 face 按码双语渲染可行。
   */
  business(key: K, context?: ErrorContext, opts?: ErrorOptions): BusinessError;
}

/** 单段标识符：小写蛇形（命名空间与 key 同规；点分连接后即身份码，DESIGN §3.3） */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

function invalid(field: string, value: string): DefectError {
  return new DefectError(`invalid error catalog ${field}`, ROOT_ERROR_CODES.catalogKeyInvalid, {
    field,
    value,
  });
}

/** 身份码签发（品牌类型的唯一落点；断言合法——string → 品牌子类型） */
const issue = (prefix: string, key: string): BusinessCode => (prefix + key) as BusinessCode;

/** lookupEntry 的目录绑定面(defineErrorCatalog 闭包内的既定事实) */
interface CatalogBinding {
  namespace: string;
  /** 身份码前缀(`${namespace}.`) */
  prefix: string;
  frozen: Record<string, ErrorDefinition>;
}

/** key 查找（含形状与 miss 防呆）——entry()/business() 的公共底座 */
function lookupEntry(binding: CatalogBinding, key: string): CatalogEntry {
  const { namespace, prefix, frozen } = binding;
  if (!IDENTIFIER_PATTERN.test(key)) throw invalid('key', `${namespace}.${key}`);
  const def = frozen[key];
  if (def === undefined) {
    throw new DefectError(
      `unknown error catalog key: ${namespace}.${key}`,
      ROOT_ERROR_CODES.catalogKeyMissing,
      {
        namespace,
        key,
      },
    );
  }
  return Object.freeze({ ...def, code: issue(prefix, key) });
}

/**
 * 定义命名空间错误目录（装配期调用一次；条目深冻结、与源对象隔离）。
 * 形状非法的命名空间/key/定义（JS 调用方绕过类型时）装配期即失败，不带入运行时。
 */
export function defineErrorCatalog<
  const N extends string,
  const D extends Record<string, ErrorDefinition>,
>(namespace: N, definitions: D): NamespacedErrorCatalog<N, keyof D & string> {
  if (!IDENTIFIER_PATTERN.test(namespace)) throw invalid('namespace', namespace);
  const frozen: Record<string, ErrorDefinition> = {};
  for (const [key, def] of Object.entries(definitions)) {
    if (!IDENTIFIER_PATTERN.test(key)) throw invalid('key', `${namespace}.${key}`);
    if (def === null || typeof def !== 'object') throw invalid('definition', `${namespace}.${key}`);
    if (!isErrorCategory(def.category)) throw invalid('category', `${namespace}.${key}`);
    if (typeof def.message !== 'string' || def.message === '') {
      throw invalid('message', `${namespace}.${key}`);
    }
    if (typeof def.zh !== 'string' || def.zh === '') throw invalid('zh', `${namespace}.${key}`);
    frozen[key] = Object.freeze({ ...def });
  }
  const prefix = `${namespace}.`;
  const binding: CatalogBinding = { namespace, prefix, frozen };
  const catalog: NamespacedErrorCatalog<N, keyof D & string> = {
    namespace,
    codes: Object.freeze(Object.keys(frozen).map((key) => prefix + key)),
    code: (key) => issue(prefix, key),
    entry: (key: string) => lookupEntry(binding, key),
    get: (code: string) =>
      code.startsWith(prefix) ? frozen[code.slice(prefix.length)] : undefined,
    has: (code: string) => catalog.get(code) !== undefined,
    business: (key: string, context?: ErrorContext, opts?: ErrorOptions) =>
      new BusinessError(lookupEntry(binding, key), context, opts),
  };
  return Object.freeze(catalog);
}

/**
 * face 装配：合成多个（命名空间）目录为单一查询面（ADR-0001 D1）。
 * 命名空间重复在装配期失败——v1 跨包 code 冲突无门禁（E6）的结构修复。
 */
export function composeErrorCatalogs(
  ...catalogs: NamespacedErrorCatalog<string, string>[]
): ErrorCatalog {
  const seen = new Set<string>();
  for (const catalog of catalogs) {
    if (seen.has(catalog.namespace)) {
      throw new DefectError(
        'duplicate error catalog namespace',
        ROOT_ERROR_CODES.duplicateNamespace,
        {
          namespace: catalog.namespace,
        },
      );
    }
    seen.add(catalog.namespace);
  }
  const lookup = (code: string): ErrorDefinition | undefined => {
    for (const catalog of catalogs) {
      const def = catalog.get(code);
      if (def !== undefined) return def;
    }
    return undefined;
  };
  return Object.freeze({
    codes: Object.freeze(catalogs.flatMap((catalog) => catalog.codes)),
    get: (code: string) => lookup(code),
    has: (code: string) => lookup(code) !== undefined,
  });
}
