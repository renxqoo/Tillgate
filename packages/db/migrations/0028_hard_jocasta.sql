-- trace_spans：按 start_time 日分区的 span 存储（诊断数据，best-effort，TTL 分区滚动删除）。
-- 分区由 @ai-gateway/tracing partition 维护：接收端写入前 ensure 当天分区，worker 定时预建未来分区并清理超期分区。
CREATE TABLE "trace_spans" (
	"trace_id" varchar(32) NOT NULL,
	"span_id" varchar(16) NOT NULL,
	"parent_span_id" varchar(16),
	"name" varchar(256) NOT NULL,
	"service" varchar(64) NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"status_code" smallint DEFAULT 0 NOT NULL,
	"status_message" varchar(512),
	"request_id" varchar(64),
	"user_id" bigint,
	"channel" varchar(64),
	"model" varchar(128),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- 分区表主键必须包含分区键
	CONSTRAINT "trace_spans_pk" PRIMARY KEY ("start_time", "span_id")
) PARTITION BY RANGE ("start_time");
--> statement-breakpoint
CREATE INDEX "trace_spans_trace_id_idx" ON "trace_spans" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "trace_spans_request_id_idx" ON "trace_spans" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "trace_spans_start_time_idx" ON "trace_spans" USING btree ("start_time");
