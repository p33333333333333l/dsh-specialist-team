# dsh-specialist-team

[English](README.md) | 简体中文

主代理可以自己完成简单任务，也可以把工作派给职责、文件范围和工具权限明确的专家。本插件为 DSH 原生 Agent Teams 增加专家派工。普通子代理及分组控制、团队界面和共享任务板仍由 DSH 提供。

## 安装

`0.3.0` 要求 DSH 恰为 `0.2.2-rc.4`，且 Node.js 版本为 22 或更高。已有旧版安装的用户请先按[升级步骤](docs/maintenance.zh-CN.md#从-02x-升级)迁移。

1. 克隆本仓库，在仓库中运行 `npm pack`。在 DSH profile 的依赖中加入 `"dsh-specialist-team": "file:/absolute/path/to/dsh-specialist-team-0.3.0.tgz"`，将示例路径换为生成的包的绝对路径。
2. 将 `dsh-specialist-team` 加入 `dsh.profile.bundles`，安装 profile 依赖并重新加载 DSH。按[安装检查表](docs/maintenance.zh-CN.md#安装检查)核对插件条目。
3. 在根会话中使用 DSH 的会话开关启用 **Agent Teams**。根会话即可调用 `spawn_teammate`，每次都要填写 `specialist` 和结构化 `assignment`。默认的 `context: fresh` 使用全新上下文，选择 `context: fork` 可继承主代理的对话记录。

## 专家分工

| 专家 | 工作 |
| --- | --- |
| 设计师 | 设计布局和交互，修改指定界面 |
| 研究员 | 查找资料、核对证据，不修改文件 |
| 工程师 | 实现功能、编写测试，不运行检查 |
| 架构师 | 诊断问题、比较方案，不修改文件 |
| 验收员 | 独立检查结果，只运行获准的命令 |

需要独立复核时，主代理把结果交给另一位专家检查。专家不再派人。整合、提交和发布由主代理负责。工具权限只约束已注册的工具调用。授权前请检查命令及其子进程可能产生的影响。

## 设置专家模型

在插件管理器中打开**专家团队 → 专家模型设置**。派工时未指定模型、角色也未设置偏好时，专家沿用主代理的模型。

- 更换提供方后，再选择模型。在选定之前，旧配置继续生效。选定模型、调整推理强度或清除偏好都会自动保存。修改只影响新创建的专家。
- 只能使用根会话获准的提供方和模型组合。遇到授权错误时，检查子代理模型选择设置中的 `enabled` 和 `allowedModels`。推理强度以当前提供方为该模型列出的选项为准。

## 严格协调模式

默认关闭，主代理可以自己处理任务，也可以按需派工。开启严格模式后，已启用 Agent Teams 的根会话仍可协调、使用任务板和派发专家，但不能直接读取文件或执行命令。两种模式下，调用专家都可能增加模型费用。

切换作用于后续工具调用。卸载插件前先关闭严格模式，以便当前会话保留主代理的工作工具。

## 手动配置（可选）

也可在 profile 的 `cordis.patch.yml` 中，将两项设置都写在 `dsh-team` 下。将占位值换为当前会话已授权的提供方和模型 ID。

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

`models` 支持 `designer`、`researcher`、`engineer`、`architect` 和 `verifier`，每项可选填 `reasoningEffort`。两项设置均支持热更新。从设置页保存时，对应 YAML 块内的注释可能丢失。

## 维护与许可

发行包采用 [Apache-2.0](LICENSE) 许可。源代码仓库中的 `vendor/` 保留旧版使用的上游代码及其 MIT 许可，供归档查阅。发行包不包含这份归档。验证、会话恢复和卸载步骤见[维护指南](docs/maintenance.zh-CN.md)。
