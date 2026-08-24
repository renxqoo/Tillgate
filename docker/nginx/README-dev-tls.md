# LAN 开发 TLS 前门

给本机直跑的 dev 服务补 TLS（密码 / 会话 Cookie / 网关 API Key 不走明文 HTTP），
**应用代码零改动**。生产部署用同目录 `nginx.conf`（certbot + 域名 + HSTS）。

## 入口

| 地址                         | 后端                         |
| ---------------------------- | ---------------------------- |
| `https://<LAN-IP>:3443`      | 用户面板（3001）             |
| `https://<LAN-IP>:3444`      | 管理后台（3002）             |
| `https://<LAN-IP>:8443/v1/*` | 网关（8080，API Key 走 TLS） |

> 用 LAN IP 访问 Next dev server 时，需把该 IP 追加到
> `apps/{admin,client}/next.config.mjs` 的 `allowedDevOrigins`（否则 HMR/水合被拒）。

## 首次启用（一次性）

```bash
# 1) mkcert 本地 CA（已装过可跳过；首次执行会请求系统钥匙串授权）
mkcert -install

# 2) 签发证书（私钥落 docker/nginx/certs/，已 gitignore 不入库）
cd docker/nginx
mkcert -cert-file certs/dev.pem -key-file certs/dev-key.pem \
  "$(ipconfig getifaddr en0 | tr -d '\n')" localhost 127.0.0.1

# 3) 启动（相对路径基于 -p 前缀，任意 checkout 位置可用）
mkdir -p logs
nginx -p "$PWD" -c nginx.dev-tls.conf

# 4) 验证（mkcert CA 受信 → 无告警）
curl -sI https://localhost:3444/login
```

停止 / 重载：

```bash
nginx -p "$PWD" -c nginx.dev-tls.conf -s stop    # 或 -s reload
```

## 说明

- **无 HSTS**：LAN IP 上 3001/3002 明文口仍并行可用，HSTS 按 host 生效会连带
  封锁同 IP 其它端口的 http 访问；生产 conf 才启用 HSTS。
- **日志只记 `$uri` 不记查询串**：查询串可能带凭证（登录页已做白名单重定向，
  此处再堵 access log 留痕）。
- 网关经 8443 访问时，如需按真实客户端 IP 限流，把 `.env` 的
  `TRUSTED_PROXY_HOPS` 设为 `1`（信任这一跳 nginx 的 X-Forwarded-For）。
- Next dev 会话 Cookie 在开发模式无 `Secure` 标记（`NODE_ENV=development`），
  经 https 前门访问不受影响；生产构建自动带 `Secure`。
