# syntax=docker/dockerfile:1
# admin（管理后台，Next.js standalone 输出）
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@ai-gateway/admin" build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/admin/server.js）
COPY --from=builder /repo/apps/admin/.next/standalone ./
COPY --from=builder /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder /repo/apps/admin/public ./apps/admin/public
EXPOSE 3002
CMD ["node", "apps/admin/server.js"]
