-- 死列清理（删除优于兼容）：request_logs.candidates_tried 自建立以来无任何写入方
-- （管线从不填候选尝试明细，attempts 恒 1），管理端查询/前端亦无消费。整链一次删净。
ALTER TABLE "request_logs" DROP COLUMN IF EXISTS "candidates_tried";
