/**
 * 语言解析内核转发：单一实现在 @ai-gateway/http/locale（后端 Accept-Language
 * 协商与前端 cookie 解析同源，避免两端口径漂移）。
 */
export * from '@ai-gateway/http/locale';
