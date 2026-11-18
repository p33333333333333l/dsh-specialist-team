# 维护与验证

[English](maintenance.md) | 简体中文 · [首页](../README.zh-CN.md)

## 安装检查

`0.3.0` 要求 DSH 恰为 `0.2.2-rc.4`，且 Node.js 版本为 22 或更高。安装或升级后，在当前 profile 的插件页检查以下条目。

| 条目 ID | 预期状态 |
| --- | --- |
| `agent-team`、`tool-agent-team` | 启用。DSH 提供团队服务和任务板工具。 |
| `tool-subagent-control`、`tool-subagent`、`tool-subagent-fork` | 保留 DSH 对普通子代理及分组控制的常规配置。 |
| `ui-agent-team` | 在提供原生团队界面的端上保持启用。在根会话中使用其 **Agent Teams** 开关。 |
| `subagent-model-selection-settings` | 如需使用自定义模型，在新建根会话前开启模型选择并授权所需的提供方和模型组合。 |
| `dsh-team` | 启用。专家派工、设置和权限检查由本插件的这一个条目提供。 |

保留原生 preset 的工具分组。在根会话中开启 Agent Teams，确认出现 `spawn_teammate`，且必填 `specialist` 和 `assignment`。关闭 Agent Teams 后，专家派工入口应消失。子会话不能派发专家。代理树、通信和任务板均由 DSH 管理。

## 从 0.2.x 升级

1. 在当前 profile 的 `cordis.patch.yml` 中，把 `dsh-team-tools.config.models` 中的模型偏好移到 `dsh-team.config.models` 下，保留 `dsh-team.config.coordinatorMode`。参见[手动配置示例](../README.zh-CN.md#手动配置可选)。
2. 移除旧的 `dsh-team-tools` 和 `dsh-team-service` 条目或覆盖项。检查 `agent-team`、`tool-agent-team`、`ui-agent-team`、`tool-subagent-control`、`tool-subagent` 和 `tool-subagent-fork`，移除旧版安装所加的 `disabled: true` 覆盖项。若曾为旧版停用原生委派分组，也一并恢复。
3. 重新加载 DSH，按上表检查条目，然后新建根会话并启用 Agent Teams。旧版替代团队实现创建的会话保留为历史记录，可查阅原日志。旧团队的成员和任务不会迁入原生团队。

旧版替代实现及其 MIT 许可归档在源代码仓库的 `vendor/` 目录。`0.3.0` 发行包不包含这份归档。

## 派工与恢复

只有启用了 Agent Teams 的根会话可以调用 `spawn_teammate`。每次派工必须指定专家类别，并在派工信息中填写交付物、读写路径、允许工具、验收负责人和停止条件。需要验收员运行检查时，要给出原样命令。写入路径必须在读取范围内。`context: fresh` 是默认值，选择 `context: fork` 可继承主代理的对话记录。

无效派工在专家启动前会被拒绝。插件在专家开始工作前将派工信息写入其会话日志，恢复该原生专家会话时会重新加载派工信息。专家在 PTC preset 下也使用原生工具执行器，并通过 DSH 的 `send_message` 向主代理汇报，参数为 `agent: lead`。

权限检查约束已注册工具的调用范围。递归搜索可能沿链接访问其他位置，获准命令可以启动子进程，路径也可能在检查与执行之间发生变化。主代理仍需审核每条验收命令的实际影响。卸载插件会阻止已派工的专家继续调用工具。重新加载插件并重新打开相关会话后，再继续专家任务。

## 严格协调模式

在 `dsh-team` 中设置 `coordinatorMode: strict`，或在专家模型设置页打开开关。启用了 Agent Teams 的根会话仍可协调、派发专家和使用任务板。[协调工具允许列表](../src/policy.mjs#L98)限制主代理直接使用工作工具。关闭严格模式后，后续调用即可使用工作工具。如果该根会话原来使用 PTC，重新打开会话可恢复 preset 的执行器。卸载插件前先关闭严格模式。卸载后如果主代理仍受限，请重新打开会话。

## 验证

本包直接运行 ESM，无需构建。安装目标 DSH 依赖后运行 `npm test`。安装验收可按以下步骤检查。

1. 新建根会话，关闭再开启 Agent Teams。确认普通子代理工具按 preset 配置可用，开启 Agent Teams 后原生团队界面和任务板可用。
2. 分别用 fresh 和 fork 上下文派发有效任务。确认根会话收到回复，专家不能再派发专家，恢复专家会话后越界读取仍会被拒绝。
3. 在根会话切换严格模式，确认其禁止直接工作但允许协调，再在 PTC preset 中重复操作。分别测试已授权和未授权的模型组合。

自动化检查不代替桌面重启、登录或实际提供方调用的验收。

## 卸载

关闭严格模式，从 profile 依赖和 `dsh.profile.bundles` 中移除本包，删除本插件专用的覆盖项，再重启 DSH。原生团队组件仍可使用。历史派工记录保留在会话日志中。
