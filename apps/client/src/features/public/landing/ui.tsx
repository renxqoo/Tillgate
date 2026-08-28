/**
 * 营销首页共用小块（复刻 skillhub.cn 风格的黑白灰 + #3957ff 主题）。
 * 无状态服务端组件：文案由 page.tsx 注入，保证所有 section 可单独编译。
 */
export { LogoMark } from './logo-mark';
export { BlackPill } from './black-pill';
export { OutlinePill } from './outline-pill';
export { SectionHeading } from './section-heading';
export type { LandingT, PricingT } from './landing-shared';
export { fmtPrice, formatUnit } from './landing-shared';
