import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Docker 部署用 standalone 输出（见 apps/console-app/Dockerfile）
  output: 'standalone',
};

export default nextConfig;
