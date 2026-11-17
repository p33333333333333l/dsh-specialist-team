# 维护与验证

[English](maintenance.md) | [简体中文](maintenance.zh-CN.md) · [首页](../README.zh-CN.md)

## 开发

本包直接运行 ESM 源码，无需构建。准备好 DSH 依赖后运行 `npm test`。开发仓库使用已安装 runtime 的依赖，确保 Cordis 服务共享同一实例。

当前支持的基线是 DSH `0.2.1-rc.3`。适配其他版本前，需验证实际 Loader 配置组合、工具参数和成员恢复。随包提供的 Team 代码来自该版本，模型路由改动和 MIT 许可见[来源说明](../vendor/README.md)。

## 已有验证

运行 `npm test`。权限测试检查工具、路径和命令范围；集成测试使用本地模拟模型验证派工、恢复和热更新；设置页测试覆盖自动保存、写入冲突、断线和中英文控件。自动化测试不能代替桌面重启、登录和实际提供方调用的验收。

## 安装检查

开发 profile 通过本地链接引用本仓库，依赖和 bundle 配置组合检查没有跳过项或警告。运行会话已收到分工规则，`spawn_teammate` 包含必填的 `specialist` 和 `assignment` 字段。

安装或升级后，在插件页面核对以下状态：

| 组件 ID | 预期状态 | 作用 |
| --- | --- | --- |
| `agent-team`、`tool-agent-team` | 停用 | 已由本插件替换的原版团队服务与工具 |
| `tool-subagent`、`tool-subagent-fork` | 停用 | 普通子代理入口 |
| `ui-agent-team` | 启用且正常运行 | 保留使用的上游团队界面 |
| `subagent-model-selection-settings` | 已加载 | 默认工具配置依赖此服务；缺失时团队工具无法初始化。使用模型偏好还需开启模型选择并授权对应组合。 |
| `dsh-team-service`、`dsh-team-tools`、`dsh-team` | 启用且正常运行 | 本插件的团队服务、工具和分工策略 |

这三个组件 ID 在 2026-11-18 之前叫 `specialist-team-service`、`specialist-team-tools` 和 `specialist-team`。如果 profile 的 `cordis.patch.yml` 仍使用旧 ID，请改成新 ID；沿用旧 ID 的条目不会作用于新组件。

`dsh-team-tools` 的 `config.models` 偏好须使用当前授权的 provider/model 组合。授权变化后需同步调整偏好；无效选择会报错，不会自动换模型。这类故障出现过：偏好写了已下线的模型 id `deepseek-v4.1-flash-1017`，`spawn_teammate` 被拒绝，主代理随后给所有成员自选了自己的模型。现在报错信息会指出 `dsh-team-tools` 的 `config.models`。推理等级也必须是模型支持的值，例如 `claude-sonnet-5-5` 只支持 `off`、`high`、`xhigh`。

### 原版团队组件报错或成员创建异常

本插件的 `cordis.patch.yml` 默认停用上表中的四个原版服务或工具入口，但 profile 自身的 `cordis.patch.yml` 可在之后覆盖这些设置。例如，桌面 profile 中残留的 `disabled: false` 会重新启用原版组件。原版与替代实现会重复注册 `agentTeams` 服务和同名工具；已观察到 `agent-team`、`tool-agent-team` 报错，而团队界面和三个替代组件仍正常运行的情况。

检查当前 profile 的 `cordis.patch.yml`（桌面默认路径为 `~/.dsh/profiles/desktop/cordis.patch.yml`），移除重新启用原版组件的覆盖项，或将其改为停用。本次冲突对应的修复示例：

```yaml
- id: tool-agent-team
  disabled: true
- id: agent-team
  disabled: true
```

同时确认 `tool-subagent`、`tool-subagent-fork` 保持停用，`ui-agent-team` 保持启用。不要为了消除原版组件的报错而停用本插件的三个组件。

保存后等待配置热重载，重新核对上表状态，并实际创建一个带 `specialist` 和 `assignment` 的成员、下发任务，确认成员能回复；如果配置未自动加载，再重新加载 DSH。2026-11-17 的桌面故障按此方法修复后，运行状态检查、成员创建与消息通信均通过，现有 11 项回归测试全部通过；未覆盖完整桌面重启后的所有交互。

包标识仍为 `dsh-specialist-team`。显示文案使用 `locale/en.json` 和 `locale/zh.json`；DSH 中文语言键是 `zh`，不因页面 HTML 的语言为 `zh-CN` 而改变。

## 派工与恢复

每次创建成员都必须提供专家类别和派工信息：交付物、可读写路径、允许工具、验收负责人、停止条件，以及验收专家可执行的原样命令。无效派工会在成员启动前被拒绝。工作开始前，派工先写入主代理日志，再复制到成员日志。

工具执行前，guard 会检查已注册工具的调用，并解析路径，拒绝直接访问范围外文件。主代理使用 PTC 时，专家使用原生工具，不开放任意代码执行入口。

这些检查不是操作系统沙箱。递归搜索可能沿链接访问其他位置；获准命令及其子进程可以访问同一系统；文件也可能在检查与执行之间发生变化。主代理仍须审核命令及其副作用。

恢复成员时沿用已保存的派工和模型设置。如果主代理未加载，需先恢复父 Team 会话。卸载策略后，已有成员仍会被拦截，需要重启对应会话。旧的无派工成员保留原有行为。

## 严格协调模式

通过设置页切换严格模式，或在 `dsh-team` 的配置中设置 `coordinatorMode: strict`。开启时，主代理的工具调用受 [允许列表](../src/policy.mjs) 限制；关闭后不再施加这项限制。两种模式下专家的派工检查都有效。若在严格模式下卸载，主代理仍受限，也不能创建新专家，直到重启会话。

安装或修改白名单后的验收步骤（先设置 `coordinatorMode: strict`；默认 `off` 时改为确认主代理仍可直接读文件、运行命令）：

1. 运行 `npm test`，确认严格协调模式的用例通过。
2. 在主代理会话中请求读取一个简单文件。主代理应创建研究专家，而不是直接调用；直接调用 `read`、`bash`、`edit` 或 `git_*` 应被拒绝，提示含 “Strict coordinator mode”。
3. 要求主代理提交代码。它应向你报告冲突，不运行 git，也不委派提交。
4. 确认 `spawn_teammate`、`ask_user_question`、`todo_write` 和任务板仍可用。
5. 完全重启并恢复主代理会话后，重复第 2 步。

白名单只检查已注册工具的调用，不是操作系统沙箱：专家的获准命令及其子进程仍作用于真实系统，以白名单内名称注册的工具也会被放行。

## 卸载

从 profile 的依赖和 `dsh.profile.bundles` 中移除本包，恢复原 Agent Team 配置，再重启 DSH。历史派工记录保留用于审计，普通 Team 实现会忽略这些扩展记录。
