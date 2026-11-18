# dsh-specialist-team

[English](README.md) | 简体中文

给专家分派任务时，可以指定交付物、文件范围和可用工具。专家加入 DSH 原生 Agent Teams，与普通队友共用团队树、消息和任务板。

## 安装并试用

`0.3.3` 要求 **DSH `0.2.2-rc.4`** 和 **Node.js 22 或更高版本**。安装包见 [v0.3.3 发行页](https://github.com/p33333333333333l/dsh-specialist-team/releases/tag/v0.3.3)。

1. 在 DSH 插件管理器中用 `.tgz` 地址安装，或运行下面的命令。如果使用其他配置（profile），请替换 `web`。

   ```sh
   dsh plugin --profile web add https://github.com/p33333333333333l/dsh-specialist-team/releases/download/v0.3.3/dsh-specialist-team-0.3.3.tgz
   ```

2. 打开根会话，开启 **Agent Teams**。如果插件管理器提示有待应用的变更，先重新加载 DSH。
3. 给主代理一个范围明确的任务，比如「请研究员只读项目 README，告诉我它要求哪个 DSH 版本」。主代理通过 `spawn_teammate` 指定专家角色，并填写交付物、读写路径、可用工具、验收负责人和停止条件。专家默认从空白上下文开始。需要继承主代理的对话记录时，使用 `context: fork`。

新建专家时，名称须唯一，并采用 `角色-任务短名` 格式，例如 `researcher-read-docs`。用单个连字符连接小写英文字母或数字组成的各段，总长不超过 32 个字符。角色或格式不符时，`spawn_teammate` 会拒绝创建。

## 选择专家

| 角色 | 适合的工作 |
| --- | --- |
| 设计师 | 设计布局和交互，修改指定界面。 |
| 研究员 | 使用只读工具查找来源、核对证据。 |
| 工程师 | 实现功能、编写测试。测试执行交给验收员。 |
| 架构师 | 使用只读工具诊断问题、比较方案。 |
| 验收员 | 独立检查结果，执行派工单指定的命令。 |

主代理负责整合、提交和发布。需要独立验收时，把检查交给另一位专家。工具和路径限制约束已注册的工具调用。指派验收命令前，先确认命令及其子进程会影响哪些文件和操作。

## 设置专家模型

打开 **插件 → 专家团队 → 专家模型设置**。为需要单独配置的角色选择提供方和模型。修改会自动保存，并用于新创建的专家。如果派工和角色都没指定模型，专家就沿用主代理的模型。派工工具中的空白可选模型字段视为未填写。

![专家团队插件页，显示专家模型设置入口和运行中的 dsh-team 组件](docs/specialist-settings.jpg)

如果 DSH 拒绝某个提供方与模型的组合，请开启子代理模型选择，把该组合加入允许列表，再打开一个新根会话。推理强度从当前提供方为该模型提供的选项中选择。如果模型不再支持已保存的强度，可选择「不指定推理强度」清除旧值，保留提供方和模型。

## 让主代理只做协调

在**专家模型设置**中开启**严格协调模式**，主代理可派工、协调和使用任务板。开启 Agent Teams 后，读文件或运行命令等工作由专家执行。严格模式默认关闭，主代理可以直接完成这些工作。两种模式下，调用专家都可能增加模型费用。

插件停用期间，已打开的专家会话会暂停使用工具。重新启用后，这些会话按原派工权限继续。卸载前先关闭严格模式。如果主代理原先使用程序化工具调用（PTC），关闭严格模式后重新打开会话，即可恢复原执行器。

## 用 YAML 配置

手动设置时，在当前 profile 的 `cordis.patch.yml` 中使用 `dsh-team` 条目。把示例里的提供方和模型 ID 换成 DSH 已授权的组合。

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

`models` 支持 `designer`、`researcher`、`engineer`、`architect` 和 `verifier`，每项还可设置 `reasoningEffort`。通过设置页保存可能会移除对应 YAML 块里的注释。

## 源码与许可

在源码目录运行 `npm install` 和 `npm test` 即可验证。参见 [Apache-2.0 许可证](LICENSE)和[版权归属声明](NOTICE.zh-CN)。
