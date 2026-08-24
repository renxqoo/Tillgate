# syntax=docker/dockerfile:1
# admin（管理后台，Next.js standalone 输出）
# 构建段：全 bun（bun install + bun x next build）；运行段：bun 跑 standalone server
# apps/client 与 apps/admin 同拷：bun install --frozen-lockfile 要求 lockfile 内
# 全部 workspace 成员在场（其余 server apps 与 Next 构建无关，不拷）
FROM oven/bun:1.4-alpine AS builder
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json tsconfig.next.json ./
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run --filter "@tillgate/admin..." build

FROM oven/bun:1.4-alpine AS runtime
ENV NODE_ENV=production
# Next standalone 标准配方：Docker 的 HOSTNAME(=容器ID) 会劫持绑定地址；PORT 缺省 3000
ENV HOSTNAME=0.0.0.0 PORT=3002
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/admin/server.js）
COPY --from=builder /repo/apps/admin/.next/standalone ./
COPY --from=builder /repo/apps/admin/.next/static ./apps/admin/.next/static
# 落地页 hero 图（image-zh-cn/en.png）在 public/——Next standalone 不打包 public，
# 必须随镜像分发（缺这行 = 线上 /image-*.png 404）
COPY --from=builder /repo/apps/admin/public ./apps/admin/public
EXPOSE 3002
CMD ["bun", "apps/admin/server.js"]
