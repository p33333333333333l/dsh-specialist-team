# DSH 专家协作插件

[English](README.md) | [简体中文](README.zh-CN.md)

主代理把任务派给专家，每位专家有各自的范围、工具权限，也可以单独配置模型。分工规则自动加载，无需手动触发技能。可选的[严格协调模式](#严格协调模式)（默认关闭）会让主代理只负责派工。

基于 DeepSeek 的 [@deepseek-ai/dsh-experimental-agent-team-profile](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team-profile)，增加专家派工、模型偏好和工具权限限制。[查看源码来源](vendor/README.md)。

## 专家分工

| 专家 | 工作 |
| --- | --- |
| 设计 | UI 设计决策和指定的界面修改 |
| 研究 | 只读调研 |
| 实现 | 编写代码和指定的测试，不运行检查 |
| 架构 | 只读架构分析与问题诊断 |
| 验收 | 独立检查，只运行获准命令 |

默认（`coordinatorMode: off`）下主代理保留全部工具：局部、已知、易检查的工作自己做；遇到具体的专业缺口、需要独立检查或有多个独立工作面时才派专家。主代理选择团队、分配文件和工具权限，并把每项交付交给审查人。专家不能继续派人，也不能提交、整合或发布。

## 严格协调模式

默认关闭。在 `id: specialist-team` 条目的 `config` 中设置 `coordinatorMode: strict` 启用（见[配置](#配置)）。启用后主代理只负责派工、协调、向你提问和汇总，每项实际任务，哪怕只读一个文件，都交给全新的专家。主代理的每次工具调用在执行前都要通过按名称精确匹配的白名单，其余一律拦截，包括读文件、搜索、编辑、shell、git、网页、浏览器和 MCP 工具、会话检索、`subagent`、`subagent_fork`、`workflow`、`run_code` 和定时任务。未知或新增的工具在白名单审核前同样被拦截。

| 类别 | 允许的工具 |
| --- | --- |
| 派工与团队 | `spawn_teammate`、`list_subagent_models`、`list_agents`、`send_message`、`interrupt_agent`、`wait_agent`、`team_task_create`、`team_task_get`、`team_task_list`、`team_task_update` |
| 提问与计划 | `ask_user_question`、`todo_write`、`create_goal`、`get_goal`、`update_goal`、`exit_plan_mode`、`skill` |
| 上下文与任务 | `compress`、`decompress`（不得带 `toFile` 或 `imageRef`）、`search_context`、`acp_status`、`acp_cache`、`job_list`、`job_output`、`job_kill` |
| 交付 | `present` |

整合改动、提交和发布仍归主代理角色，但该模式下主代理没有对应工具，专家同样不得执行。遇到此类需求，主代理会作为与严格模式的冲突报告给你并询问处理方式，不会放宽实现或验收专家的权限。

插件卸载后拦截仍然有效，主代理需重启会话才能再次创建成员。旧的无派工成员保留原有行为。

## 安装

需要 **DSH `0.2.1-rc.3`**、**Node.js 22+** 和上方链接的 Agent Team profile。其他 DSH 版本尚未验证。

1. 克隆本仓库，在 DSH profile 的依赖中加入 `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"`。
2. 将 `dsh-specialist-team` 加入 `dsh.profile.bundles`，安装依赖并重新加载 DSH。
3. 确认 `spawn_teammate` 包含 `specialist` 和 `assignment` 字段，并按[安装检查与冲突排查](docs/maintenance.zh-CN.md#安装检查)核对组件状态。profile 的 `cordis.patch.yml` 可覆盖插件默认值；不要重新启用已被替换的 `agent-team` 和 `tool-agent-team`，`ui-agent-team` 应保持启用。

插件替换 Team 服务和工具，保留 Team 界面，并停用普通子代理入口。成员默认继承主代理的模型；如需为专家指定模型，见[配置](#配置)。

## 配置

配置写在 profile 的 `cordis.patch.yml` 中，两项都可选。

```yaml
- id: specialist-team
  config:
    coordinatorMode: strict   # off (default) | strict
- id: specialist-team-tools
  config:
    modelSelectionSettings: true
    models:
      researcher: { provider: huanling-deepseek, model: deepseek-v4.1-flash, reasoningEffort: high }
      engineer: { provider: huanling-cc-kiro-power, model: claude-sonnet-5-5, reasoningEffort: high }
      verifier: { provider: huanling-gpt-pro, model: gpt-6.1-sol, reasoningEffort: medium }
```

- `id: specialist-team` 的 `coordinatorMode`：`off`（默认）或 `strict`；其他值会在加载时报错。
- `id: specialist-team-tools` 的 `models`：按专家（`designer`、`researcher`、`engineer`、`architect`、`verifier`）各配一项，包含 `provider`、`model` 和可选的 `reasoningEffort`。未配置的专家继承主代理的模型。每个组合都必须在当前会话中获得授权（例如列入 `subagent-model-selection-settings.allowedModels`），`reasoningEffort` 必须是该模型支持的等级；否则 `spawn_teammate` 会报错并给出提示，不会自动换模型。
- 设置 `modelSelectionSettings: true` 后，已配置的偏好会写入 `spawn_teammate` 的说明，主代理能直接看到。主代理省略 `provider` 和 `model` 即使用偏好，只有你指定模型或任务确有需要时才显式传入。

## 使用边界

工具权限限制（包括严格模式下的主代理白名单）不等于系统沙箱，只检查已注册工具的调用。获准命令和递归搜索仍可能访问指定范围外的文件，授权前须审核命令；主代理白名单也不能阻止专家获准命令产生副作用。如何分工、成果是否合格，仍由模型判断。

测试、恢复和卸载说明见[维护文档](docs/maintenance.zh-CN.md)。

## 开发目录

| 位置 | 用途 |
| --- | --- |
| [`src/`](src/) | 插件入口、专家派工、提示词和工具权限规则。 |
| [`vendor/`](vendor/) | 随包提供的上游运行代码、本项目补丁及来源和许可说明；属于运行依赖，不能当作构建缓存清理。 |
| [`locale/`](locale/) | 插件、Team 服务和工具的中英文文案。 |
| [`docs/`](docs/) | 安装检查、测试、恢复及卸载的维护说明。 |
| [`test/`](test/) | 权限规则与插件集成的自动化检查。 |

根目录的 `package.json` 和 `cordis.patch.yml` 定义包入口与插件装配，`LICENSE` 和 `NOTICE` 记录许可与归属，保留在原位。测试命令为 `npm test`。

## 许可证

本项目的原创贡献采用 [Apache-2.0](LICENSE)。随包提供的上游 DeepSeek Harness 代码保留 [MIT 许可](vendor/LICENSE-MIT)，我们对这些代码的原创修改采用 Apache-2.0。包元数据标记为 `Apache-2.0 AND MIT`，表示两种许可分别适用于各自部分，并非任选其一。归属及范围见 [NOTICE](NOTICE) 和[来源说明](vendor/README.md)。
