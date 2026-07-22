# 模块边界审计与改进建议

本文审计当前主工作区的模块化程度，目标是减少多跳查阅、控制文件数量、降低修改半径。建议不追求“每个接口一个文件”，而是让一个文件自然承载一组功能，并对外提供稳定入口。

## 审计结论

当前代码同时存在两类问题：

- 少数文件承担过多职责，成为高 fan-out 的中心调度点。
- 若干目录把同一功能拆成过多小文件，开发者需要在 args、bootstrap、presentation、handler、support 之间频繁跳转。

`src` 下共有 332 个 TypeScript 文件。生产代码中热点目录如下：

| 模块 | 文件数 | 80 行以下文件数 | 总行数 | 中位行数 | 判断 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/bridge/command` | 39 | 10 | 9768 | 173 | 命令功能拆分偏细，存在多跳链路 |
| `src/bridge/session` | 27 | 11 | 5525 | 165 | session use case 与展示 helper 粒度偏碎 |
| `src/bridge/turn` | 17 | 3 | 3578 | 133 | 交互 turn 已形成子域，但 runner 仍偏重 |
| `src/bridge/mirror` | 11 | 2 | 2964 | 161 | 粒度较合理，适合作为保留样板 |
| `src/runtime/codex/session-index` | 13 | 6 | 2756 | 87 | session index 内部 helper 拆得偏散 |
| `src/operator-ui` | 16 | 3 | 7040 | 200 | `shell.ts` 和 `assets.ts` 偏大 |
| `src/configuration` | 17 | 5 | 3074 | 147 | 重构后边界清晰，文件数可接受 |

最大文件和高 fan-out 入口：

| 文件 | 行数 / import 数 | 风险 |
| --- | ---: | --- |
| `src/channels/feishu/adapter.ts` | 6612 行 | Feishu API、事件解析、卡片状态、发送、下载等聚在一起，修改半径过大 |
| `src/bridge/host/manager.ts` | 3382 行 / 53 imports | Bridge lifecycle、adapter 管理、dispatch、mirror、startup notice 混在主协调器 |
| `src/operator-ui/shell.ts` | 3186 行 | UI shell、DOM 操作、事件绑定和渲染逻辑聚合过重 |
| `src/bridge/command/dispatch.ts` | 922 行 / 31 imports | slash command 分发中心知道太多命令内部细节 |
| `src/bridge/session/support.ts` | 521 行 / 18 imports | runtime 配置读取、展示 fallback、session helper 交叉 |

## 好的边界样板

### 配置模块

`src/configuration` 是当前较好的样板：一组功能按 `schema / fields / sources / merge / service / migrations` 聚合，文件数量不算少，但每个文件承担的是一个稳定子职责。业务代码主要通过 `ConfigService` 进入，不需要知道 TOML I/O、source chain、node-config 合并和 migration 的内部细节。

保留原则：

- `service.ts` 是统一入口。
- `sources.ts` 承担来源和文件 I/O。
- `merge.ts` 承担合并和 provenance。
- `schema.ts` / `fields.ts` 承担 shape 与字段注册。
- 业务语义不下沉到配置层。

### Mirror 模块

`src/bridge/mirror` 的粒度基本合适。它按 runtime、turns、delivery-plan、feedback-controller、subscription-registry、suppression 等稳定子功能组织，文件数没有失控，入口和内部 helper 的关系也较自然。

保留原则：

- 不再继续拆出 trivial helper 文件。
- 新增 mirror 行为优先落到现有子功能文件。
- 只有形成独立生命周期或状态机时才新增文件。

## 主要问题

### 1. Bridge 命令模块拆分过细

`src/bridge/command` 当前有 39 个文件，同一命令常跨越 handler、args、bootstrap、presentation、options、callback 多个文件。例如终端类命令会在 `tmux.ts`、`tmux-args.ts`、`runtime-bootstrap.ts`、`runtime-session.ts`、`presentation.ts`、`dispatch.ts` 间跳转；runtime 配置命令也会穿过 `runtime-settings.ts`、`runtime-settings-options.ts`、`runtime-settings-bootstrap.ts`、`provider-settings.ts`、`global-settings.ts`。

这类拆分降低了单文件复杂度，但增加了认知成本。开发者要修改一个命令时，经常需要先追分发，再追参数解析，再追展示，再追 session/runtime 副作用。

建议把命令按功能包聚合，而不是按技术层拆分：

- `runtime-command.ts`：`/runtime`、`/provider`、`/model`、`/mode`、`/sandbox`、`/network`、`/r` 的解析、写入和回显。
- `terminal-command.ts`：`/tmux`、`/pty`、`/shell` 的参数解析、执行和展示。
- `session-command.ts`：`/new`、`/t`、`/clear`、`/takeover`、session/thread 选择和确认。
- `diagnostics-command.ts`：`/status`、`/doctor`、诊断展示。
- `command-dispatch.ts`：只做 alias、conversation barrier、路由和错误兜底，不直接理解每个命令的内部执行细节。

迁移时优先把 80 行以下的纯转发或单函数文件合并到对应功能包，例如 `runtime-settings-options.ts`、`runtime-settings-bootstrap.ts`、`pty-args.ts`、`tmux-args.ts`、`shell-args.ts`、`clear-confirmations.ts`、`takeover-confirmations.ts`。不要先抽新接口，先让相关代码落到同一功能文件中，再看是否需要导出小的测试入口。

### 2. Session use case 分散在过多小文件

`src/bridge/session/command-use-cases` 有 12 个文件，其中 `types.ts`、`clear-confirmation.ts`、`takeover-confirmation.ts`、`status-guards.ts`、`local-runtime-list.ts` 都很小。线程绑定、切换、目标解析、source 读取、args 解析又分别落在多个文件。

建议收敛为 3 个功能文件：

- `session-thread-commands.ts`：thread target、source、binding、switch。
- `session-lifecycle-commands.ts`：new、clear、takeover、confirmation、status guard。
- `session-list-commands.ts`：local runtime list 和展示入口。

这样开发者处理 `/t` 或 `/new` 时可以从一个文件读完主要流程，再按需跳到 registry/store，而不是在 use case 目录里来回定位。

### 3. Codex session-index helper 文件过碎

`src/runtime/codex/session-index` 有多个偏小 helper 文件。`paths.ts`、`discovery-scanner.ts`、`workspace-filter.ts`、`file-readers.ts`、`archive-store.ts` 都是同一个 session index source discovery 的组成部分。

建议按读路径聚合：

- `sources.ts`：paths、workspace filter、file readers、discovery scanner、archive store。
- `events.ts`：jsonl types、history parser、event mirror parser、tool-call events、internal control events。
- `core.ts`：保留 public list/read/reconcile 入口，隐藏 sources/events 细节。

这样仍保持 3 个有意义的内部边界，同时减少“为了一个路径 helper 跳一个文件”的成本。

### 4. Feishu adapter 过大

`src/channels/feishu/adapter.ts` 是当前最大的生产文件，超过 6600 行。它的问题不是“需要无限拆分”，而是多个生命周期混在同一个文件：

- Feishu API request 包装和错误处理。
- webhook / message / card callback 入站解析。
- rich card / streaming card 的 desired state 与 shadow state。
- 文件下载和附件处理。
- startup reconciliation 辅助行为。

建议按 Feishu adapter 的自然功能边界拆成少数几个文件：

- `adapter.ts`：只保留 `FeishuAdapter` 对外生命周期、接口实现和组合装配。
- `events.ts`：Feishu webhook、消息、卡片 callback 解析。
- `card-runtime.ts`：streaming/rich card desired state、shadow state、flush 和 sync plan。
- `api-client.ts`：Feishu API request、错误归一化、timeout、日志。
- `resources.ts`：文件下载、图片、附件资源处理。

这会增加少量文件，但显著减少单文件修改半径。不要继续把每个 API endpoint 拆成文件；API client 内部用函数分组即可。

### 5. Bridge host manager 职责过宽

`src/bridge/host/manager.ts` 有 3382 行，且 import 数最高。它是 Bridge 的中心协调器，但目前同时了解 adapter lifecycle、startup notice、message dispatch、mirror reconcile、session cleanup、hot update source 等行为。

建议先做“职责下沉”，不要再横向拆很多 manager helper：

- adapter 启停和同步计划下沉到 `channels/adapter-runtime` 已有模块。
- startup notice 和 channel chat reconciliation 收口到现有 `bridge/startup-notice-target.ts` 或新增一个 `startup.ts`。
- mirror reconcile 调用只通过 `bridge/mirror/runtime.ts` 的统一接口。
- manager 保留组合装配、依赖注入和顶层生命周期。

目标不是把 manager 拆成十几个文件，而是让 manager 不再直接理解每个子系统内部细节。

### 6. Operator UI shell 过大

`src/operator-ui/shell.ts` 和 `assets.ts` 承担了大量 HTML、DOM 查询、事件绑定和 API 调用。由于当前 UI 是非框架式静态 shell，不能简单按组件库方式细拆，但仍可以按页面功能包聚合：

- `shell.ts`：启动、路由、全局事件和页面切换。
- `session-view.ts`：session 列表、详情、表单和操作。
- `config-view.ts`：全局配置、channel 配置和校验展示。
- `runtime-view.ts`：runtime/provider 状态和命令入口。
- `ui-api.ts`：fetch wrapper 和 payload 类型。

这里的拆分应以页面工作流为单位，不要按每个按钮/表单控件拆文件。

## 推荐推进顺序

### P0：建立模块化评审规则

新增或维护一份轻量规则，作为 review checklist：

- 一个文件优先承载一组功能，而不是一个接口或一个函数。
- 80 行以下文件如果只是单函数转发、常量或薄 wrapper，优先合并回所在功能包。
- 超过 1000 行文件需要明确内部分区；超过 2000 行文件应评估是否存在多个生命周期。
- 分发层只做路由，不理解业务细节。
- service/facade 可以存在，但必须减少调用方认知，而不是制造更多跳转。

### P1：收敛 Bridge 命令目录

优先处理 `src/bridge/command`，因为它文件数最高且是开发者常改入口。建议先选一个纵向功能做样板，例如 terminal 命令或 runtime 配置命令。

成功标准：

- 修改 `/tmux` 或 `/provider` 不需要跨 5 个以上 command 文件。
- `dispatch.ts` 的 import 数下降。
- 小文件数量减少，而不是新增 facade。

### P2：收敛 Session command-use-cases

在命令目录有样板后，把 `command-use-cases` 合并成 thread/lifecycle/list 三组。这个阶段应保持测试不变，主要移动代码和整理导出。

成功标准：

- `/t` 相关主流程集中在一个功能文件。
- confirmation/status guard 这类小 helper 不再独立成文件。

### P3：整理 Codex session-index

把 discovery/source 相关小文件合并为 `sources.ts`，把 JSONL/event 解析相关逻辑合并为 `events.ts`。这个阶段适合配合 runtime 文档更新。

成功标准：

- session-index 目录从 13 个文件降到约 4 到 6 个文件。
- `core.ts` 只面向 public list/read/reconcile，不再散落路径和 reader 细节。

### P4：拆解 Feishu adapter 的生命周期

这是收益大但风险高的阶段，应在命令/session 收敛后做。拆分要少而稳定，优先提取 card runtime 和 API client。

成功标准：

- `adapter.ts` 降到 2000 行以内。
- card flush/sync plan 的状态和 API 调用集中在 `card-runtime.ts`。
- 入站事件解析集中在 `events.ts`。

### P5：Operator UI 按页面工作流整理

UI shell 的拆分应最后做，因为它容易引入细碎“组件文件”。按 session/config/runtime 页面工作流拆，而不是按控件拆。

成功标准：

- `shell.ts` 只负责启动和页面切换。
- 每个页面工作流有单一入口。
- API payload 类型和 fetch wrapper 不散在 DOM 操作中。

## 不建议做的事

- 不要为了降低单文件行数，把每个函数、常量、按钮或 callback 拆成文件。
- 不要新增只转发一次的 facade；如果调用方仍要继续跳到实现文件，facade 没有降低认知成本。
- 不要把业务 fallback 下沉到底层工具模块，配置重构已经证明这会让边界变厚。
- 不要一口气重排所有目录。每次选择一个功能包，先建立可验证的重组样板。

## 验证建议

模块化整理以移动代码为主，验证应覆盖被整理功能的使用场景：

- 命令目录：`npm test -- --unit --grep "command|runtime|provider|tmux|pty|shell"`，再跑 `npm test -- --mock-e2e`。
- session use cases：session registry、channel router、command workflow 定向测试。
- session-index：Codex session index、mirror parser、history parser 定向测试。
- Feishu adapter：Feishu adapter unit/e2e、streaming card、rich card 和 doc-as-chat 相关测试。
- UI shell：operator-ui route/application 单测和 `npm run docs:build`。

每个阶段完成后更新对应架构文档，尤其是 [当前架构](current.md)、[开发者源码地图](../product/developer-map.md) 和本审计文档。
