/**
 * Bun SQL 形态的 jsonb 列（全 schema 唯一 jsonb 定义——替换 drizzle 缺省 PgJsonb）：
 *
 * drizzle 缺省 jsonb 的 mapToDriverValue 会 JSON.stringify 成字符串参数；而
 * Bun SQL 对「字符串参数 → jsonb 列」按 JSON 字符串标量存储（pg 驱动则 parse
 * 成对象）——对象被双重编码（drizzle#5139 / oven-sh/bun#28819；官方修复在
 * drizzle v1 线，0.45 不回移）。本列类型对驱动透传 JS 对象，由 Bun SQL 的
 * 对象参数序列化完成单次编码；读取两侧（pg/Bun）都返回已解析对象，驱动面等价。
 */
import { customType } from 'drizzle-orm/pg-core';

/** data 缺省 unknown——列定义处 .$type<T>() 收窄（与 PgJsonb 同用法） */
export const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value) {
    // 透传（对象/数组原样；null/标量由 Bun SQL 按 jsonb 标量语义序列化）
    return value;
  },
});
