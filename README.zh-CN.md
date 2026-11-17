# DSH 专家团队插件

[English](README.md) | 简体中文

主代理可以自己完成简单任务，也可以把工作派给有明确职责、文件范围和工具权限的专家。分工规则随插件加载，不需要调用技能。

## 安装

适用基线：DSH `0.2.1-rc.3`、Node.js 22+。其他版本尚未验证。

1. 克隆本仓库，在 DSH profile 的依赖中加入 `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"`，将示例路径换为本地仓库的绝对路径。
2. 将 `dsh-specialist-team` 加入 `dsh.profile.bundles`，安装 profile 依赖并重新加载 DSH。
3. 在插件页按[安装检查表](docs/maintenance.zh-CN.md#安装检查)核对组件。确认专家工具已加载：`spawn_teammate` 应包含 `specialist` 和 `assignment` 两个字段。

## 专家分工

| 专家 | 工作 |
| --- | --- |
| 设计师 | 设计布局和交互，修改指定界面 |
| 研究员 | 查找资料、核对证据，不修改文件 |
| 工程师 | 实现功能、编写测试，不运行检查 |
| 架构师 | 诊断问题、比较方案，不修改文件 |
| 验收员 | 独立检查结果，只运行获准的命令 |

需要独立复核时，主代理把结果交给另一位专家检查。专家不再派人；整合、提交和发布由主代理负责。工具权限只约束已注册的工具调用，不是操作系统沙箱：授权命令前仍须检查命令及其子进程可能影响哪些文件。

## 设置专家模型

在插件管理器中打开**专家团队 → 专家模型设置**。未指定模型的专家默认沿用主代理模型。

![插件管理器中，「专家模型设置」入口位于三个运行中的组件上方。](docs/specialist-settings.jpg)

截图中的“专家协作”为旧版组件名称。

- 更换提供方后，再选择模型；在选定之前，旧配置继续生效。选定模型、调整推理强度或清除偏好都会自动保存。修改只影响新创建的专家，已有成员沿用原配置。
- 只能使用当前会话获准的模型组合。此页面不会修改授权名单；遇到授权错误时，检查子代理模型选择设置中的 `enabled` 和 `allowedModels`。推理强度以当前提供方为该模型列出的选项为准。

## 严格协调模式

同一设置页也可以切换严格协调模式，默认关闭。开启后，主代理仍可派发和跟进任务，但能直接调用的工具会减少。需要主代理使用被此模式拦截的工具时，关闭开关即可；你也可以自行完成操作。

切换作用于后续工具调用，不会中断已经开始的操作。如果准备卸载插件，请先关闭严格模式；否则当前主代理会话仍会受限，且无法再创建专家，直到重启会话。

## 手动配置（可选）

也可以编辑 profile 的 `cordis.patch.yml`。将下面的占位值替换为当前会话已授权的提供方和模型 ID：

```yaml
- id: dsh-team-tools
  config:
    modelSelectionSettings: true
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
```

`models` 支持 `designer`、`researcher`、`engineer`、`architect` 和 `verifier`，每项可选填 `reasoningEffort`。`models` 和 `coordinatorMode` 支持热更新；从设置页修改时，对应 YAML 块内的注释可能丢失。修改 `interrupt`、`freshProvider`、`forkProvider` 或 `modelSelectionSettings` 则会重启工具插件。

## 维护与许可

[维护指南](docs/maintenance.zh-CN.md)包含组件冲突排查、运行测试、会话恢复和卸载步骤。本项目原创贡献采用 [Apache-2.0](LICENSE)；随包分发的上游代码保留 [MIT 许可](vendor/LICENSE-MIT)。来源和修改范围见[来源说明](vendor/README.md)及 [NOTICE](NOTICE)。
