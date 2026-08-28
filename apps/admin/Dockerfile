# admin（管理后台，Next.js standalone 输出）
# 构建段：全 bun（bun install + bun x next build）；运行段：bun 跑 standalone server
# apps/client 与 apps/admin 同拷：bun install --frozen-lockfile 要求 lockfile 内
# 全部 workspace 成员在场（其余 server apps 与 Next 构建无关，不拷）
FROM oven/bun:1.4.0-alpine AS builder
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json tsconfig.next.json ./
# bun patch 依赖(patchedDependencies)——漏拷则 --frozen-lockfile 直接报找不到 patch 文件
COPY patches ./patches
# manifest 先行：bun install 的输入只有根 manifest/lockfile/patches + 所涉 workspace 成员的
# package.json——源码后拷，改源码不再打掉 install 层缓存。
# 新增 workspace 成员时须同步补一行（漏拷则 --frozen-lockfile 报 workspace 成员缺失）。
COPY packages/accounts/package.json packages/accounts/
COPY packages/ai/package.json packages/ai/
COPY packages/api-client/package.json packages/api-client/
COPY packages/billing/package.json packages/billing/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/db/package.json packages/db/
COPY packages/errors/package.json packages/errors/
COPY packages/http/package.json packages/http/
COPY packages/identity/package.json packages/identity/
COPY packages/inference/package.json packages/inference/
COPY packages/notifications/package.json packages/notifications/
COPY packages/observability/package.json packages/observability/
COPY packages/runtime/package.json packages/runtime/
COPY packages/ui/package.json packages/ui/
COPY apps/client/package.json apps/client/
COPY apps/admin/package.json apps/admin/
# 缓存挂载：bun 下载缓存跨构建持久（与 Dockerfile.server 共享同一缓存卷）
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN bun run --filter "@tillgate/admin..." build

FROM oven/bun:1.4.0-alpine AS runtime
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
USER bun
CMD ["bun", "apps/admin/server.js"]
