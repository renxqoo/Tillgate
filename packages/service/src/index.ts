/**
 * @ai-gateway/service —— 用例层（全部业务用例 + 事务编排）。
 *
 * 分层契约：service → domain（纯规则）→ repository（全部 SQL）→ db（表）。
 * 本包组合三者：进程级依赖装配注入（env），请求级 RunContext，事务级 inTx 派生。
 * 零 HTTP / 零队列 / 零上游 LLM——传输协议与 app 编排不进本包。
 */
export * from './context.js';
export * from './wallet/wallet.js';
export * from './billing/index.js';
export * from './channel-budget/index.js';
export * from './funding/index.js';
export * from './settlement/index.js';
export * from './shared/operations.js';
export type * from './generation/port.js';
export { createGenerationPollUseCase, type GenerationPollConfig, type GenerationPollResult } from './generation/poll.js';
export * from './subscription/index.js';
