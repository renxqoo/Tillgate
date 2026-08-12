# syntax=docker/dockerfile:1
# client（端用户面板，Next.js standalone 输出）
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@ai-gateway/client" build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/client/server.js）
COPY --from=builder /repo/apps/client/.next/standalone ./
COPY --from=builder /repo/apps/client/.next/static ./apps/client/.next/static
COPY --from=builder /repo/apps/client/public ./apps/client/public
EXPOSE 3001
CMD ["node", "apps/client/server.js"]
