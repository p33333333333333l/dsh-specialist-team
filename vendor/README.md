# 来源与改动

上游：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，版本 [`dsh-v0.2.1-rc.3`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3)，提交 [`1f81c047`](https://github.com/deepseek-ai/deepseek-harness/commit/1f81c047fc48fa190a683e469daa699857e9afe8)。上游代码遵循 [MIT 许可](LICENSE-MIT)。

本项目的原创贡献及原创修改采用 [Apache-2.0](../LICENSE)。本目录的 `.mjs` 文件含上游代码与本项目修改，[model-routing.patch](model-routing.patch) 也保留了上游上下文；其中的上游部分继续适用 MIT，不因本次许可调整而改变。完整上游版权与许可声明保存在 [LICENSE-MIT](LICENSE-MIT)，分发时一并保留；另见 [NOTICE](../NOTICE)。

| 来源 | 本插件中的用途 |
| --- | --- |
| [@deepseek-ai/dsh-experimental-agent-team-profile](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team-profile) | 提供基础 Team 服务、工具和界面；安装时保留界面，替换服务与工具 |
| [@deepseek-ai/dsh-experimental-agent-team](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team) | [agent-team.mjs](agent-team.mjs)：成员管理、消息和任务板 |
| [@deepseek-ai/dsh-experimental-tool-agent-team](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/tool-agent-team) | [tool-agent-team.mjs](tool-agent-team.mjs)：供模型调用的 Team 工具 |
| [@deepseek-ai/dsh-tool-subagent](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/subagent/tool-subagent) | [tool-subagent.mjs](tool-subagent.mjs) 和 [list-models-l-21_ZpK.mjs](list-models-l-21_ZpK.mjs)：模型选择与发现 |

本项目增加五类专家的模型偏好、显式模型与推理等级选择、授权校验和启动前预检；回移补丁保存在 [model-routing.patch](model-routing.patch)，SHA256 为 `834d0eba572af9dc30f602970c2f8965b7da414027dbf45c795927fe0cc73c31`。

独立插件另有两处改动：Team 服务在创建成员前保存派工记录；Team 工具通过 [spawn.mjs](../src/spawn.mjs) 校验结构化派工。分工规则与权限检查位于 [src/](../src/)，无需改动已安装的 DSH 文件。

升级上游代码后，需重新验证服务组合、工具参数和成员恢复。
