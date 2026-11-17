# DSH 专家协作插件

[English](README.md) | [简体中文](README.zh-CN.md)

小任务由主代理直接完成，复杂任务交给职责明确的专家。插件自动加载分工规则，限制每位专家能使用的工具，无需手动触发技能。

基于 DeepSeek 的 [@deepseek-ai/dsh-experimental-agent-team-profile](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team-profile)，增加专家派工、模型偏好和工具权限限制。[查看源码来源](vendor/README.md)。

## 专家分工

| 专家 | 工作 |
| --- | --- |
| 设计 | UI 设计决策和指定的界面修改 |
| 研究 | 只读调研 |
| 实现 | 编写代码和指定的测试，不运行检查 |
| 架构 | 只读架构分析与问题诊断 |
| 验收 | 独立检查，只运行获准命令 |

主代理决定团队规模、分配文件和工具权限，并整合成果。专家不能继续派人或自行提交代码。

## 安装

需要 **DSH `0.2.1-rc.3`**、**Node.js 22+** 和上方链接的 Agent Team profile。其他 DSH 版本尚未验证。

1. 克隆本仓库，在 DSH profile 的依赖中加入 `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"`。
2. 将 `dsh-specialist-team` 加入 `dsh.profile.bundles`，安装依赖并重新加载 DSH。
3. 确认 `spawn_teammate` 包含 `specialist` 和 `assignment` 字段，并按[安装检查与冲突排查](docs/maintenance.zh-CN.md#安装检查)核对组件状态。profile 的 `cordis.patch.yml` 可覆盖插件默认值；不要重新启用已被替换的 `agent-team` 和 `tool-agent-team`，`ui-agent-team` 应保持启用。

插件替换 Team 服务和工具，保留 Team 界面，并停用普通子代理入口。成员默认继承模型；如需指定模型，在 `id: specialist-team-tools` 的 `config.models` 中配置，须使用已授权模型。

## 使用边界

工具权限限制不等于系统沙箱。获准命令和递归搜索仍可能访问指定范围外的文件，授权前须审核命令。如何分工、成果是否合格，仍由模型判断。

测试、恢复和卸载说明见[维护文档](docs/maintenance.zh-CN.md)。

## 许可证

本项目的原创贡献采用 [Apache-2.0](LICENSE)。随包提供的上游 DeepSeek Harness 代码保留 [MIT 许可](vendor/LICENSE-MIT)，我们对这些代码的原创修改采用 Apache-2.0。包元数据标记为 `Apache-2.0 AND MIT`，表示两种许可分别适用于各自部分，并非任选其一。归属及范围见 [NOTICE](NOTICE) 和[来源说明](vendor/README.md)。
