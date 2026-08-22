# TokenLens v2

多供应商 LLM API 网关的重构仓。按 [docs/project-structure-refactoring.md](docs/project-structure-refactoring.md)
的目标结构与 P0–P8 阶段计划从旧仓（ai-gateway）垂直用例逐个迁入。

- 工程规范（分层、资金域纪律、质量门禁）：[AGENT.md](AGENT.md)
- 错误体系设计：[docs/error-system-design.md](docs/error-system-design.md)
- 架构决策记录：[docs/adr/](docs/adr/)（按 §3.5 治理，编号递增，只进不出）

当前状态：仅目录骨架与根配置；`apps/`、`packages/` 为空，待按迁移纪律填充。
