# 进阶参考

[快速上手](../README.zh-CN.md) · [English](advanced.md)

## 直接调用派工工具

在开启 Agent Teams 的主会话中调用 `spawn_teammate`。选择专家角色，填写交付物、可读写路径、可用工具、验收负责人和停止条件。给验收员派工时，列出它可以运行的完整命令。验收后由主代理负责整合改动。

名称须唯一，并以所选角色开头，例如 `researcher-read-docs`。使用小写英文字母和数字，各段用单个连字符连接，最长 32 个字符。如果创建时提示名称有误，检查角色前缀、格式，以及团队里是否已用了同一个名字。

需要共享主会话的对话记录时，使用 `context: fork`。省略可选模型字段时，优先使用角色设置，没有角色设置则沿用主代理的模型。空白模型字段按省略处理。直接指定模型时，同时传入 `provider` 和 `model`。如需传入 `reasoning_effort`，请使用该组合支持的推理强度。

工具和路径限制只约束已注册的工具调用。指派验收命令前，检查命令及其子进程能读取或修改哪些文件，以及是否会访问网络。

## 关联任务卡与验收回执

创建原生任务卡后，可将任务 ID 填入 `spawn_teammate` 的 `assignment.task_id`。任务的依赖须已完成。专家启动后，主代理须在任务板上将该卡指派给专家，专家才能发送回执。未填写任务 ID 的派工沿用原有流程。

关联任务的专家可以调用 `report_specialist_result`，填写 `status`、`summary`，以及适用的 `checks` 和 `limits`。`expected_failure`、`passed` 和 `failed` 由验收员使用，须列出实际执行的检查。其他状态为 `delivered`、`not_run` 和 `blocked`。回执通过原生消息发给主代理，任务编号取自派工记录。主代理审阅回执，再在任务板上完成对应任务。

## 核对派工限制

只有主代理可以派出专家。插件在主代理的系统提示里提供 DSH 当前的深度上限、根代理树的活动总容量和协调模式。整棵树共享活动容量，实际可用名额取决于已启动的队友。读不到活动上限时，以 DSH 启动队友时的检查为准。用户要求嵌套派工或指定并发数时，系统提示要求主代理先核对限制，并在采用替代方案前征得同意。

## 手动修改配置文件

在当前配置的 `cordis.patch.yml` 中添加或更新 `dsh-team` 条目。把示例中的 ID 换成 DSH 允许使用的提供方和模型。

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

角色键可用 `designer`、`researcher`、`engineer`、`architect` 或 `verifier`。每个角色还可设置 `reasoningEffort`。通过设置页保存可能会移除所编辑 YAML 块中的注释。

## 恢复程序化工具调用

如果主代理在启用严格协调模式前使用程序化工具调用（PTC），关闭严格协调模式后重新打开会话，即可恢复原工具执行器。

## 验证源码

在源码目录先运行 `npm install`，再运行 `npm test`。
