# 进阶参考

[快速上手](../README.zh-CN.md) · [English](advanced.md)

## 直接调用派工工具

在开启 Agent Teams 的主会话中调用 `spawn_teammate`。选择专家角色，填写交付物、可读写路径、可用工具、验收负责人和停止条件。给验收员派工时，列出它可以运行的完整命令。验收后由主代理负责整合改动。

名称须唯一，并以所选角色开头，例如 `researcher-read-docs`。使用小写英文字母和数字，各段用单个连字符连接，最长 32 个字符。如果创建时提示名称有误，检查角色前缀、格式，以及团队里是否已用了同一个名字。

需要共享主会话的对话记录时，使用 `context: fork`。省略可选模型字段时，优先使用角色设置，没有角色设置则沿用主代理的模型。空白模型字段按省略处理。直接指定模型时，同时传入 `provider` 和 `model`。如需传入 `reasoning_effort`，请使用该组合支持的推理强度。

工具和路径限制只约束已注册的工具调用。指派验收命令前，检查命令及其子进程能读取或修改哪些文件，以及是否会访问网络。

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
