import { Hono } from 'hono'

/** 存活探针（无鉴权） */
export const healthRoutes = new Hono().get('/', (c) => c.json({ status: 'ok' }))
