import { relations } from 'drizzle-orm'
import { users } from './users.js'
import { apps } from './apps.js'
import { apiKeys } from './api-keys.js'
import { channels } from './channels.js'
import { providers } from './providers.js'
import { modelChannels, modelMappings } from './model-mappings.js'
import { rateCardCoefficients, rateCards } from './billing.js'
import { usageLogs } from './usage.js'
import { transactions } from './transactions.js'
import { redeemBatches, redeemCodes } from './redeem.js'
import { auditLogs, requestLogs } from './logs.js'
import { plans, userSubscriptions } from './plans.js'

export const usersRelations = relations(users, ({ many, one }) => ({
  apps: many(apps),
  apiKeys: many(apiKeys),
  usageLogs: many(usageLogs),
  transactions: many(transactions),
  redeemCodes: many(redeemCodes),
  requestLogs: many(requestLogs),
  auditLogs: many(auditLogs),
  userSubscriptions: many(userSubscriptions),
  rateCard: one(rateCards, { fields: [users.rateCardId], references: [rateCards.id] }),
}))

export const appsRelations = relations(apps, ({ one }) => ({
  user: one(users, { fields: [apps.userId], references: [users.id] }),
}))

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
  app: one(apps, { fields: [apiKeys.appId], references: [apps.id] }),
}))

export const providersRelations = relations(providers, ({ many }) => ({
  channels: many(channels),
}))

export const channelsRelations = relations(channels, ({ one, many }) => ({
  provider: one(providers, { fields: [channels.providerId], references: [providers.id] }),
  modelChannels: many(modelChannels),
  usageLogs: many(usageLogs),
}))

export const modelMappingsRelations = relations(modelMappings, ({ many }) => ({
  modelChannels: many(modelChannels),
  coefficients: many(rateCardCoefficients),
}))

export const modelChannelsRelations = relations(modelChannels, ({ one }) => ({
  mapping: one(modelMappings, { fields: [modelChannels.mappingId], references: [modelMappings.id] }),
  channel: one(channels, { fields: [modelChannels.channelId], references: [channels.id] }),
}))

export const rateCardsRelations = relations(rateCards, ({ many, one }) => ({
  coefficients: many(rateCardCoefficients),
  users: many(users),
}))

export const rateCardCoefficientsRelations = relations(rateCardCoefficients, ({ one }) => ({
  rateCard: one(rateCards, { fields: [rateCardCoefficients.rateCardId], references: [rateCards.id] }),
  modelMapping: one(modelMappings, {
    fields: [rateCardCoefficients.modelMappingId],
    references: [modelMappings.id],
  }),
}))

export const usageLogsRelations = relations(usageLogs, ({ one }) => ({
  user: one(users, { fields: [usageLogs.userId], references: [users.id] }),
  app: one(apps, { fields: [usageLogs.appId], references: [apps.id] }),
  apiKey: one(apiKeys, { fields: [usageLogs.apiKeyId], references: [apiKeys.id] }),
  channel: one(channels, { fields: [usageLogs.channelId], references: [channels.id] }),
  subscription: one(userSubscriptions, {
    fields: [usageLogs.subscriptionId],
    references: [userSubscriptions.id],
  }),
}))

export const transactionsRelations = relations(transactions, ({ one }) => ({
  user: one(users, { fields: [transactions.userId], references: [users.id] }),
}))

export const redeemBatchesRelations = relations(redeemBatches, ({ many }) => ({
  codes: many(redeemCodes),
}))

export const redeemCodesRelations = relations(redeemCodes, ({ one }) => ({
  batch: one(redeemBatches, { fields: [redeemCodes.batchId], references: [redeemBatches.id] }),
  user: one(users, { fields: [redeemCodes.usedBy], references: [users.id] }),
}))

export const requestLogsRelations = relations(requestLogs, ({ one }) => ({
  user: one(users, { fields: [requestLogs.userId], references: [users.id] }),
  apiKey: one(apiKeys, { fields: [requestLogs.apiKeyId], references: [apiKeys.id] }),
}))

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  admin: one(users, { fields: [auditLogs.adminId], references: [users.id] }),
}))

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(userSubscriptions),
}))

export const userSubscriptionsRelations = relations(userSubscriptions, ({ one, many }) => ({
  user: one(users, { fields: [userSubscriptions.userId], references: [users.id] }),
  plan: one(plans, { fields: [userSubscriptions.planId], references: [plans.id] }),
  usageLogs: many(usageLogs),
}))
