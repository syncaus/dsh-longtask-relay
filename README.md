# 长任务接力（longtask-relay）

把长任务变成一条**会话链**：真理源落在工作区文件里，每个会话只承担一个阶段；上下文逼近上限时自动收尾、开新会话、交接，旧会话退役。侧栏面板监控每条链和每个会话。

## 为什么需要它

DSH 自身的自动压缩（`compaction-basic`）能在上下文吃紧时把旧历史摘要掉，让会话继续跑；`goal-round-driver` 能让同一会话自动续轮。但压缩是有损的，反复压缩会让长任务越跑越差，而顶层会话之间没有父子关系，一个会话无法看到或接管另一个会话。

这个插件补的是中间那一步：**在压缩变成常态之前换一个干净的会话，并把「已经做到哪」交接过去**。

## 用法

在任意会话里让模型调用：

```
relay_start(objective: "把订单导出从 CSV 改成流式 XLSX，覆盖 3 个入口，全部有测试")
```

当前会话成为 `initializer`，必须先把真理源写出来：

```
<workspace>/.relay/<chainId>/
├── features.json   任务清单（既有条目的 id/title 不可改；新工作只能追加）
├── PROGRESS.md     Done / In progress / Next / Errors / Notes
├── HANDOFF.md      给下一个会话的短交接（开头是 <!-- relay:state --> 状态块）
├── decisions.md    决策台账（追加式：是什么 / 为什么 / 什么情况下算错）
└── traps.md        坑台账（追加式：踩过又费时间的坑，带具体命令或语法）
```

`features.json` 根部还放三条项目级命令，供所有条目引用：

| 字段 | 作用 |
|---|---|
| `statusCheck` | **对账命令**：把真理源里的说法和代码对一遍（解析路由 / 用例 / 迁移清单）。收尾与新会话启动都要跑它 |
| `verifyFast` | 每次收尾跑得起的快速校验收（秒级） |
| `verifyFull` | 完整校验，`relay_finish` 前跑 |

每条功能还带一个 `coverage` 字段，说明**验证到了多少**：`full`（端到端）、`partial`（只覆盖部分分支 / 平台 / 视口 / 子命令）、`smoke`（只证明它能响）。偏低的覆盖率默认不允许自动通过——必须由人把 `acceptedBy` 置成 `human`。

这三条命令和覆盖率取值都与技术栈无关：Rust 的 `cargo test`、Java 的 `mvn verify`、前端 `tsc --noEmit`、Python 的 `pytest -q` 都能当 `verifyFast`/`verifyFull`；输出被识别为证据的形态包括比例（`41/41`）、退出码（`exit 0`）、结论词（`ok`/`passed`/`BUILD SUCCESS`/`通过`）。

之后每完成一个功能，模型调用 `relay_checkpoint` 记录进度。会话空闲且上下文比例越过阈值时，插件先发一条收尾指令（做完当前单元、写进度、跑验证），下一轮空闲创建新会话并投递交接说明；新会话从真理源重建上下文，而不是复制旧对话。

## 工具

| 工具 | 作用 |
|---|---|
| `relay_start` | 开始一条链，当前会话成为 initializer |
| `relay_status` | 读出所有链的状态、进度、每个会话的上下文占用与压缩次数 |
| `relay_checkpoint` | 更新功能状态 / 证据 / 覆盖率，追加发现的新功能，记录阻塞，标记 `ready` |
| `relay_finish` | 结束链；功能没全部通过时会被拒绝并列出剩余项 |
| `relay_control` | 暂停 / 恢复自动接力、立即交接，或删除已停止（paused / done / failed）的链 |

## 面板

侧栏「长任务接力」：链列表（状态、进度、当前会话） + 展开后的会话时间线、功能清单、交接说明，以及暂停 / 恢复 / 立即交接 / 删除。删除需要二次确认，会连链目录（功能清单、进度、交接说明、审计）一起删掉；进行中的链必须先暂停。会话里另有「下游」「我的任务」两个标签页：「下游」列出本会话派发的子会话；「我的任务」列出分配给本会话的功能，以及它当前的 goal 阶段、轮次和是否会自动继续。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: longtask-relay
  name: '@local/longtask-relay'
  config:
    handoffRatio: 0.70
    wrapupRatio: 0.50
    maxHandoffs: 32
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `truthDir` | `.relay` | 真理源目录，相对工作区 |
| `autoHandoff` | `true` | 是否允许自动交接 |
| `wrapupRatio` | `0.50` | 进入收尾的上下文比例（留一半窗口给收尾本身） |
| `handoffRatio` | `0.70` | 收尾后仍到这个比例就强制交接；**必须低于 `compaction-basic` 的 `thresholdRatio`** |
| `handoffAfterCompactions` | `1` | 压缩过几次后，低比例也触发收尾 |
| `compactedRatioFloor` | `0.50` | 配合上一项的比例下限 |
| `hardCompactions` | `2` | 压缩达到几次后不等边界直接交接 |
| `maxHandoffs` | `32` | 单链交接上限 |
| `cooldownMs` | `5000` | 同一会话两次判定之间的最小间隔 |
| `wrapupTimeoutMinutes` | `10` | 收尾后空闲多久仍然强制交接 |
| `agentPreset` | 空 | 新会话使用的 preset；空表示继承当前会话 |
| `pauseGoalOnRetire` | `true` | 交接后暂停旧会话的 goal |
| `seedGoalOnHandoff` | `false` | 交接后给新会话建一个 goal，让目标轮驱动继续跑；需要目标服务可用 |
| `goalRoundsPerHandoff` | `16` | 给新会话 goal 分配的续轮上限 |
| `notifyOldSession` | `true` | 交接后给旧会话留一条退役说明 |
| `pauseOnExternalBlocker` | `true` | 遇到「只有人能解」的阻塞（`kind=external`）时暂停该链 |
| `requireStrongEvidence` | `true` | 通过的功能是否必须带「像命令结果」的证据；输出是自由文本的项目可关掉 |
| `requireHumanAcceptedCoverage` | `true` | 低覆盖率是否必须由人确认；把部分覆盖当常态的项目可关掉 |

**重要**：两个比例分工不同 —— `wrapupRatio`（默认 0.50）开始收尾，`handoffRatio`（默认 0.70）在收尾之后仍然到点就强制交接；前者必须小于后者，配置校验会拒绝反过来的组合。`compaction-basic` 默认在上下文窗口的 0.8 处压缩，如果它先压缩，压力会被降到很低，本插件就不会触发。请保证 `handoffRatio < compaction.thresholdRatio`（默认 0.70 < 0.80），或者把压缩阈值调到 0.9、把 `handoffRatio` 调到 0.78。

## 证据与阻塞的规矩

- **`passes` 必须有可用证据**：`evidence` 里要出现命令、退出码或计数。`relay_finish` 会拒绝「通过但证据不足 8 个字符或缺数字」的条目；`relay_checkpoint` 在写入 `passes=true` 时先挡一道（`evidence_too_weak`）。
- **数字不许手写**：真理源里的计数必须来自 `statusCheck` 的输出引用，否则下一棒会把过时数字当事实。
- **阻塞分三类**：`external`（等人：账号、机器、只有 owner 能做的决定）、`code`（等自己修）、`decision`（等一个选择）。`external` 会暂停链并写下「谁要做哪件事才解开」，避免继续开新会话空转。
- **与桌面端目标功能的关系**：目标（goal）管一个会话内的自动续轮，接力管换会话，两者串行互补。开启 `seedGoalOnHandoff` 后，交接会给新会话按链目标和当前进度建一个 goal，新会话由目标轮驱动继续，而不是跑完交接说明就停住。反过来，链头会话的 goal 进入 `blocked` 时（例如轮次耗尽），链会被记为 external 阻塞并暂停；在目标条里恢复或清除 goal 后，链的这条阻塞会自动解除。把 `pauseOnExternalBlocker` 关掉时只记录阻塞、继续交接，让新会话重新拿到轮次预算。
- **发现新工作只能追加**：`relay_checkpoint` 的 `addFeatures` 需要 `reason`，追加动作会写进 `PROGRESS.md`，让「初始化时没想到」这件事留下痕迹。

## 已知限制

- 顶层会话之间没有父子关系，链结构完全由插件记录；手动归档会话会让链出现悬空引用。
- 新会话会重新支付一遍 system prompt 与工具 schema 的成本。
- 「功能是否真的通过」由 `features.json` 的 `passes` 与 `evidence` 约束，插件不能代替验证；插件只校验证据的形状，不校验它是否真实。
- 未加载的会话没有实时上下文数值，面板显示「未加载」。
- 一个 Host 进程内的运行态不跨进程共享：峰值压力、判定冷却、交接中的忙标记。压缩次数、收尾时间、`ready` 和链结构都持久化在链文件里，重启或重载后恢复，不会重复收尾。
- 委派给 subagent 的调用会被工具拒绝。
