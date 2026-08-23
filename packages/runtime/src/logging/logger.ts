import pino, { type DestinationStream } from 'pino';

export interface CreateLoggerOptions {
  /** 日志级别（trace…fatal）——必填注入（铁律 3：'info' 不做藏默认） */
  level: string;
  serviceName?: string;
  /** 开发环境输出可读格式——必填注入（装配层显式决定，不藏 false 默认） */
  pretty: boolean;
  /** 输出流注入（测试捕获用）；缺省 stdout（pino 默认直写 fd 1，不走 process.stdout.write） */
  stream?: DestinationStream;
}

/**
 * 敏感字段清单（单一来源）：同时派生根级与嵌套两级 redact 路径。
 * v1 只有 `*.field` 通配——fast-redact 的 `*` 不匹配根级日志对象，根级字段
 * 从未被脱敏（IMPLEMENTATION.md §2.1 B5，行为等价测试暴露）；v2 补根级显式路径。
 */
const SENSITIVE_FIELDS = [
  'apiKey',
  'api_key',
  'clientSecret',
  'client_secret',
  'key',
  'token',
  'secret',
  'password',
] as const;

const REDACT_PATHS = [
  'req.headers.authorization',
  ...SENSITIVE_FIELDS.flatMap((field) => [field, `*.${field}`]),
];

/** 统一日志封装：JSON 结构化 + 敏感字段脱敏（根级 + 嵌套 + authorization 头）+ 服务名标记。 */
export function createLogger({ level, serviceName, pretty, stream }: CreateLoggerOptions) {
  return pino(
    {
      level,
      name: serviceName,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      ...(pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
            },
          }
        : {}),
    },
    stream,
  );
}

export type Logger = ReturnType<typeof createLogger>;
