# syntax=docker/dockerfile:1
# console（Next.js standalone 输出）
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/console-app ./apps/console-app
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@ai-gateway/console" build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/console-app/server.js）
COPY --from=builder /repo/apps/console-app/.next/standalone ./
COPY --from=builder /repo/apps/console-app/.next/static ./apps/console-app/.next/static
COPY --from=builder /repo/apps/console-app/public ./apps/console-app/public
EXPOSE 3000
CMD ["node", "apps/console-app/server.js"]
