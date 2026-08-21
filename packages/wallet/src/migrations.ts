/** 独立迁移入口；业务运行时根入口不暴露 DDL 或 schema。 */
export { migrateWallet, walletSchemaMigrations, type WalletSchemaMigration } from './schema';
