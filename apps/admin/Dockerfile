# syntax=docker/dockerfile:1
# admin（管理后台，Next.js standalone 输出）
# 构建段：全 bun（bun install + bun x next build）；运行段：bun 跑 standalone server
FROM oven/bun:1.4-alpine AS builder
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run --filter "@ai-gateway/admin" build

FROM oven/bun:1.4-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/admin/server.js）
COPY --from=builder /repo/apps/admin/.next/standalone ./
COPY --from=builder /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder /repo/apps/admin/public ./apps/admin/public
EXPOSE 3002
CMD ["bun", "apps/admin/server.js"]
