# 维护与验证

[English](maintenance.md) | [简体中文](maintenance.zh-CN.md) · [首页](../README.zh-CN.md)

## 开发

本包直接运行 ESM 源码，无需构建。准备好 DSH 依赖后运行 `npm test`。开发仓库使用已安装 runtime 的依赖，确保 Cordis 服务共享同一实例。

当前支持的基线是 DSH `0.2.1-rc.3`。适配其他版本前，需验证实际 Loader 配置组合、工具参数和成员恢复。随包提供的 Team 代码来自该版本，模型路由改动和 MIT 许可见[来源说明](../vendor/README.md)。

## 已有验证

最近记录的回归测试为 11 项全部通过，覆盖结构化派工、路径与符号链接检查、额外参数掩盖实际路径、精确验收命令及其首轮上下文、非法历史记录、fresh/fork 请求、冷恢复、主代理缺失、插件卸载和写入失败后的清理。

集成测试使用真实 Cordis、AgentLoop、工具执行层和 JSONL 存储，模型由本地模拟，不调用远程模型。

另一次真实模型验收创建了验收专家，使用 `huanling-deepseek/deepseek-v4.1-flash-1017` 和 `medium` 推理等级，保存的描述符记录了该选择。成员收到职责、工作目录和原样命令清单；追加未授权命令的尝试被拒绝，随后执行指定命令，通过全部 11 项测试并向主代理汇报。这次验收没有覆盖桌面应用完全重启后的所有交互。

## 安装检查

开发 profile 通过本地链接引用本仓库，依赖和 bundle 配置组合检查没有跳过项或警告。运行会话已收到分工规则，`spawn_teammate` 包含必填的 `specialist` 和 `assignment` 字段。

安装或升级后，在插件页面核对以下状态：

| 组件 ID | 预期状态 | 作用 |
| --- | --- | --- |
| `agent-team`、`tool-agent-team` | 停用 | 已由本插件替换的原版团队服务与工具 |
| `tool-subagent`、`tool-subagent-fork` | 停用 | 普通子代理入口 |
| `ui-agent-team` | 启用且正常运行 | 保留使用的上游团队界面 |
| `specialist-team-service`、`specialist-team-tools`、`specialist-team` | 启用且正常运行 | 本插件的团队服务、工具和分工策略 |

`specialist-team-tools` 的 `config.models` 偏好须使用当前授权的 provider/model 组合。授权变化后需同步调整偏好；无效选择会报错，不会自动换模型。

### 原版团队组件报错或成员创建异常

本插件的 `cordis.patch.yml` 默认停用上表中的四个原版服务或工具入口，但 profile 自身的 `cordis.patch.yml` 可在之后覆盖这些设置。例如，桌面 profile 中残留的 `disabled: false` 会重新启用原版组件。原版与替代实现会重复注册 `agentTeams` 服务和同名工具；已观察到 `agent-team`、`tool-agent-team` 报错，而团队界面和三个替代组件仍正常运行的情况。

检查当前 profile 的 `cordis.patch.yml`（桌面默认路径为 `~/.dsh/profiles/desktop/cordis.patch.yml`），移除重新启用原版组件的覆盖项，或将其改为停用。本次冲突对应的修复示例：

```yaml
- id: tool-agent-team
  disabled: true
- id: agent-team
  disabled: true
```

同时确认 `tool-subagent`、`tool-subagent-fork` 保持停用，`ui-agent-team` 保持启用。不要为了消除原版组件的报错而停用三个 Specialist Team 组件。

保存后等待配置热重载，重新核对上表状态，并实际创建一个带 `specialist` 和 `assignment` 的成员、下发任务，确认成员能回复；如果配置未自动加载，再重新加载 DSH。2026-11-17 的桌面故障按此方法修复后，运行状态检查、成员创建与消息通信均通过，现有 11 项回归测试全部通过；未覆盖完整桌面重启后的所有交互。

包标识仍为 `dsh-specialist-team`。显示文案使用 `locale/en.json` 和 `locale/zh.json`；DSH 中文语言键是 `zh`，不因页面 HTML 的语言为 `zh-CN` 而改变。

## 派工与恢复

每次创建成员都必须提供专家类别和派工信息：交付物、可读写路径、允许工具、验收负责人、停止条件，以及验收专家可执行的原样命令。无效派工会在成员启动前被拒绝。工作开始前，派工先写入主代理日志，再复制到成员日志。

工具执行前，guard 会检查已注册工具的调用，并解析路径，拒绝直接访问范围外文件。主代理使用 PTC 时，专家使用原生工具，不开放任意代码执行入口。

这些检查不是操作系统沙箱。递归搜索可能沿链接访问其他位置；获准命令及其子进程可以访问同一系统；文件也可能在检查与执行之间发生变化。主代理仍须审核命令及其副作用。

恢复成员时沿用已保存的派工和模型设置。如果主代理未加载，需先恢复父 Team 会话。卸载策略后，已有成员仍会被拦截，需要重启对应会话。旧的无派工成员保留原有行为。

## 卸载

从 profile 的依赖和 `dsh.profile.bundles` 中移除本包，恢复原 Agent Team 配置，再重启 DSH。历史派工记录保留用于审计，普通 Team 实现会忽略这些扩展记录。
