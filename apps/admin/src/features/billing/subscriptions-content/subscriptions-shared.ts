// 订阅页共享契约类型：沉到目录最底层，index/行项/变更弹窗单向依赖（规范 §5.3）

/** 套餐下拉选项（PlanRow 的视图投影——订阅页唯一消费域） */
export interface PlanOption {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
}
