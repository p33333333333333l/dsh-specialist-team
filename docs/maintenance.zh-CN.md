# 维护与验证

[English](maintenance.md) | [简体中文](maintenance.zh-CN.md) · [首页](../README.zh-CN.md)

## 开发

本包直接运行 ESM 源码，无需构建。准备好 DSH 依赖后运行 `npm test`。开发仓库使用已安装 runtime 的依赖，确保 Cordis 服务共享同一实例。

当前支持的基线是 DSH `0.2.1-rc.3`。适配其他版本前，需验证实际 Loader 配置组合、工具参数和成员恢复。随包提供的 Team 代码来自该版本，模型路由改动和 MIT 许可见[来源说明](../vendor/README.md)。

## 已有验证

最近一次回归测试（`npm test`，即 `node --test test/*.test.mjs`，分支 `feat/coordinator-only-20261117`，2026-11-17 验证）22 项全部通过。覆盖结构化派工、路径与符号链接检查、额外参数掩盖实际路径、精确验收命令及其首轮上下文、非法历史记录、fresh/fork 请求、冷恢复、主代理缺失、插件卸载和写入失败后的清理，以及严格协调模式和配置项的用例。

这 22 项包含策略用例（`test/policy.test.mjs` 中的白名单矩阵）和围绕 `coordinatorMode` 的集成用例：严格模式 guard 行为、默认（`off`）下主代理不受限且使用宽松提示词、非法模式被拒绝，以及 `spawn_teammate` 说明中的模型偏好摘要（`test/integration.test.mjs`），均已通过。桌面应用的真实手动验收（默认模式检查和“严格协调模式”中的第 2–5 步）尚未运行；本次改动时该插件已在桌面 profile 中停用。

集成测试使用真实 Cordis、AgentLoop、工具执行层和 JSONL 存储，模型由本地模拟，不调用远程模型。

早期历史记录（早于严格协调模式，当时测试共 11 项）：另一次真实模型验收创建了验收专家，使用 `huanling-deepseek/deepseek-v4.1-flash-1017` 和 `medium` 推理等级，保存的描述符记录了该选择。成员收到职责、工作目录和原样命令清单；追加未授权命令的尝试被拒绝，随后执行指定命令，通过全部 11 项测试并向主代理汇报。这次验收没有覆盖桌面应用完全重启后的所有交互。

## 安装检查

开发 profile 通过本地链接引用本仓库，依赖和 bundle 配置组合检查没有跳过项或警告。运行会话已收到分工规则，`spawn_teammate` 包含必填的 `specialist` 和 `assignment` 字段。

安装或升级后，在插件页面核对以下状态：

| 组件 ID | 预期状态 | 作用 |
| --- | --- | --- |
| `agent-team`、`tool-agent-team` | 停用 | 已由本插件替换的原版团队服务与工具 |
| `tool-subagent`、`tool-subagent-fork` | 停用 | 普通子代理入口 |
| `ui-agent-team` | 启用且正常运行 | 保留使用的上游团队界面 |
| `dsh-team-service`、`dsh-team-tools`、`dsh-team` | 启用且正常运行 | 本插件的团队服务、工具和分工策略 |

这三个组件 ID 在 2026-11-18 之前叫 `specialist-team-service`、`specialist-team-tools` 和 `specialist-team`。如果 profile 的 `cordis.patch.yml` 仍使用旧 ID，请改成新 ID；沿用旧 ID 的条目不会作用于新组件。

`dsh-team-tools` 的 `config.models` 偏好须使用当前授权的 provider/model 组合。授权变化后需同步调整偏好；无效选择会报错，不会自动换模型。曾出现过这类故障：偏好写了已下线的模型 id `deepseek-v4.1-flash-1017`，`spawn_teammate` 被拒绝，主代理随后给所有成员自选了自己的模型。现在报错信息会指出 `dsh-team-tools` 的 `config.models`。推理等级也必须是模型支持的值，例如 `claude-sonnet-5-5` 只支持 `off`、`high`、`xhigh`。

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

## 严格协调模式

严格模式需主动启用：在 `id: dsh-team` 条目的 `config` 中设置 `coordinatorMode: strict`（`src/index.mjs` 的 `Config`，默认 `off`；其他值会抛出 `specialist-team: coordinatorMode must be one of off, strict`）。`off` 时不安装主代理 guard，使用宽松路由提示词（`src/prompts.mjs` 的 `routingPrompt('off')`）。两种模式下专家的派工检查都生效。

`src/index.mjs` 中的主代理 guard 在主代理每次调用工具前，调用 `src/policy.mjs` 的 `leadToolDenial`。`COORDINATOR_TOOLS` 是按名称精确匹配的列表，不支持前缀或通配符。未知、改名和新增的工具一律拒绝，直到有人审核该列表和测试矩阵。`decompress` 只有在不带 `toFile` 和 `imageRef` 时才允许，因为这两个参数会写文件或图片。主代理同时使用原生工具展示，PTC 宿主不会给它 `run_code`。

guard 先于分工提示词注册，其释放函数刻意不放入卸载清理。策略卸载后，主代理仍使用同一白名单，并且不能再调用 `spawn_teammate`，因为此时创建的成员没有派工限制；需重启主代理会话才能再次创建成员。专家和无派工的旧成员走各自的路径，不受主代理 guard 影响。

整合、提交和发布仍是主代理角色的职责，但该模式下主代理和所有专家都没有对应工具。主代理会把此类需求作为与严格模式的冲突报告给用户。不要为了绕开而放宽实现或验收专家的派工。需要提交或发布时，请在未启用本插件的会话或 profile 中，或在 DSH 之外，审阅专家报告后进行。

安装或修改白名单后的验收步骤（先设置 `coordinatorMode: strict`；默认 `off` 时改为确认主代理仍可直接读文件、运行命令）：

1. 运行 `npm test`，确认严格协调模式的用例通过。
2. 在主代理会话中请求读取一个简单文件。主代理应创建研究专家，而不是直接调用；直接调用 `read`、`bash`、`edit` 或 `git_*` 应被拒绝，提示含 “Strict coordinator mode”。
3. 要求主代理提交代码。它应向你报告冲突，不运行 git，也不委派提交。
4. 确认 `spawn_teammate`、`ask_user_question`、`todo_write` 和任务板仍可用。
5. 完全重启并恢复主代理会话后，重复第 2 步。

白名单只检查已注册工具的调用，不是操作系统沙箱：专家的获准命令及其子进程仍作用于真实系统，以白名单内名称注册的工具也会被放行。

## 卸载

从 profile 的依赖和 `dsh.profile.bundles` 中移除本包，恢复原 Agent Team 配置，再重启 DSH。历史派工记录保留用于审计，普通 Team 实现会忽略这些扩展记录。
