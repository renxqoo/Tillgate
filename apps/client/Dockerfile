# syntax=docker/dockerfile:1
# client（端用户面板，Next.js standalone 输出）
# 构建段：全 bun（bun install + bun x next build）；运行段：bun 跑 standalone server
# apps/client 与 apps/admin 同拷：bun install --frozen-lockfile 要求 lockfile 内
# 全部 workspace 成员在场（其余 server apps 与 Next 构建无关，不拷）
FROM oven/bun:1.4.0-alpine AS builder
ARG GATEWAY_BASE=http://gateway:8080
ARG NEXT_PUBLIC_DISPLAY_TZ=Asia/Shanghai
ENV GATEWAY_BASE=${GATEWAY_BASE} NEXT_PUBLIC_DISPLAY_TZ=${NEXT_PUBLIC_DISPLAY_TZ}
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json tsconfig.next.json ./
# bun patch 依赖(patchedDependencies)——漏拷则 --frozen-lockfile 直接报找不到 patch 文件
COPY patches ./patches
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run --filter "@tillgate/client..." build

FROM oven/bun:1.4.0-alpine AS runtime
ENV NODE_ENV=production
# Next standalone 标准配方：Docker 的 HOSTNAME(=容器ID) 会劫持绑定地址；PORT 缺省 3000
ENV HOSTNAME=0.0.0.0 PORT=3001
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/client/server.js）
COPY --from=builder /repo/apps/client/.next/standalone ./
COPY --from=builder /repo/apps/client/.next/static ./apps/client/.next/static
# 无 public 目录（无静态资源）；将来添加时恢复 COPY --from=builder /repo/apps/client/public ./apps/client/public
EXPOSE 3001
USER bun
CMD ["bun", "apps/client/server.js"]
