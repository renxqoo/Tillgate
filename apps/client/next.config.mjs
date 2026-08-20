/** @type {import('next').NextConfig} */

/**
 * 浏览器安全头（API 面由各自 hono app 的 securityHeaders 覆盖）。
 * CSP 为保守版：Next.js 水合需要内联脚本与样式，故 script/style 留 'unsafe-inline'；
 * frame-ancestors 'none' + X-Frame-Options DENY 防点击劫持（面板不允许被嵌入）。
 *
 * client 面板与管理面板的差异：注册页嵌 Cloudflare Turnstile（隐形人机验证），
 * 需放行其脚本与 iframe（frame-src；缺省会回落 default-src 'self' 被拦）；admin
 * 无自助注册，CSP 不含此项。
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig = {
  output: 'standalone',
  // dev 源站白名单：LAN TLS 前门（docker/nginx/nginx.dev-tls.conf，见 README-dev-tls.md）
  // 经 https://<IP>:344x 反代访问 dev server 时，浏览器 origin 与 dev server 自知
  // host 不同，Next 16 dev 会拒绝 HMR/水合——只影响开发模式，生产构建忽略此配置
  // 裸主机名 + 端口变体都列上（Next 按请求提取的 host:port 归一匹配）
  allowedDevOrigins: [
    '192.168.31.98',
    '192.168.31.98:3443',
    '192.168.31.98:3444',
    'localhost',
    'localhost:3443',
    'localhost:3444',
  ],
  transpilePackages: ['@ai-gateway/ui', '@ai-gateway/api-client'],
  // 操练场 BYOK 直连网关（同域推理端点）：生产由 nginx 分流（请求不达 Next，
  // 此规则不生效）；dev 无 nginx 时兜底转发本地网关。
  // ！！只转发推理端点——/v1/pricing 等属 client-api（server 侧走 CLIENT_API_BASE
  // 直连），通配整个 /v1 会劫持它们且网关未启动时全部 500（曾发生）
  async rewrites() {
    const gateway = process.env.GATEWAY_BASE ?? 'http://localhost:8083';
    return [
      { source: '/v1/chat/completions', destination: `${gateway}/v1/chat/completions` },
      { source: '/v1/completions', destination: `${gateway}/v1/completions` },
      { source: '/v1/embeddings', destination: `${gateway}/v1/embeddings` },
      { source: '/v1/models', destination: `${gateway}/v1/models` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;