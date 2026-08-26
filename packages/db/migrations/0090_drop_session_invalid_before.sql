-- 0090：会话失效线旧列退役（0055 注释挂账的 P5 统一 DROP 收口）——
-- drop users/admins.session_invalid_before。
-- 前置：吊销唯一真相已归 identity_session_anchors（advanceAnchor 单调推进），
-- 登录/验签只读锚点表；两列自 0055 回填后无任何写入方，删除零信息损失。
-- 与 0089（password_hash 旧列退役）同口径：零兼容层、不留双轨（铁律 8）。

--> statement-breakpoint
ALTER TABLE users DROP COLUMN IF EXISTS session_invalid_before;

--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS session_invalid_before;
