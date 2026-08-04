import pino from 'pino'

export interface CreateLoggerOptions {
  level?: string
  serviceName?: string
  /** 开发环境输出可读格式 */
  pretty?: boolean
}

/** 统一日志封装：JSON 结构化 + 敏感字段脱敏 + 服务名标记 */
export function createLogger({ level = 'info', serviceName, pretty = false }: CreateLoggerOptions = {}) {
  return pino({
    level,
    name: serviceName,
    redact: {
      paths: [
        'req.headers.authorization',
        '*.apiKey',
        '*.api_key',
        '*.clientSecret',
        '*.client_secret',
        '*.key',
      ],
      censor: '[REDACTED]',
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : {}),
  })
}

export type Logger = ReturnType<typeof createLogger>
