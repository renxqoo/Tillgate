import packageJson from '../../package.json';

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: 'TokenLens',
  version: packageJson.version,
  copyright: `© ${currentYear}, TokenLens.`,
  meta: {
    title: 'TokenLens - Multi-provider LLM API Gateway',
    description:
      'TokenLens is a multi-provider LLM API gateway: OpenAI-compatible entry, channel routing and failover, wallet billing, subscriptions and quotas, end-to-end tracing.',
  },
};
