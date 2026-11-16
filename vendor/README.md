# 来源与本地改动

这些 ESM 模块来自 DeepSeek Harness `dsh-v0.2.1-rc.3`（提交 `1f81c047fc48fa190a683e469daa699857e9afe8`），遵循仓库根目录中的 MIT 许可。

此前本机模型路由回移增加了五类专家模型偏好、显式 provider/model/effort、会话授权复用、实时预检、发现工具共享与卸载清理。原补丁包含在 `model-routing.patch` 中，SHA256 为 `834d0eba572af9dc30f602970c2f8965b7da414027dbf45c795927fe0cc73c31`。

独立插件追加的改动：

- `agent-team.mjs`：在创建子成员前，将经验证的 `specialistAssignment` 写入 Lead 会话并落盘。
- `tool-agent-team.mjs`：用 `src/spawn.mjs` 包装 `spawn_teammate`，要求结构化派工，传给 Team 服务；读取会话工作目录来规范化路径。
- `list-models-l-21_ZpK.mjs`、`tool-subagent.mjs`：保留原模型路由回移，无额外功能改动。

核心策略保存在 `src/`，不需要修改已安装 DSH 的文件。升级 vendor 模块时应比对上述接口，并运行真实服务组合及恢复验证。
