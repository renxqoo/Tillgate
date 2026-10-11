import packageJson from '../../package.json';

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: 'Tillgate',
  version: packageJson.version,
  copyright: `© ${currentYear}, Tillgate.`,
  /** 项目仓库外链（品牌事实：页脚 GitHub 入口统一取此） */
  repoUrl: 'https://github.com/renxqoo/Tillgate',
  meta: {
    title: 'Tillgate - Multi-provider LLM API Gateway',
    description:
      'Tillgate is a multi-provider LLM API gateway: OpenAI-compatible entry, channel routing and failover, wallet billing, subscriptions and quotas, end-to-end tracing.',
  },
};
