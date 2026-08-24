// 接口绑定共享件：HTTP 方法封闭词表（创建/编辑弹窗同口径）

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const METHODS: readonly Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
