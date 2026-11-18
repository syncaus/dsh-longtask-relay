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
├── features.json   任务清单（只有 passes / evidence / notes 可以改）
├── PROGRESS.md     Done / In progress / Next / Errors / Notes
└── HANDOFF.md      给下一个会话的短交接
```

之后每完成一个功能，模型调用 `relay_checkpoint` 记录进度。会话空闲且上下文比例越过阈值时，插件先发一条收尾指令（做完当前单元、写进度、跑验证），下一轮空闲创建新会话并投递交接说明；新会话从真理源重建上下文，而不是复制旧对话。

## 工具

| 工具 | 作用 |
|---|---|
| `relay_start` | 开始一条链，当前会话成为 initializer |
| `relay_status` | 读出所有链的状态、进度、每个会话的上下文占用与压缩次数 |
| `relay_checkpoint` | 更新功能状态、追加进度、标记阻塞或 `ready` |
| `relay_finish` | 结束链；功能没全部通过时会被拒绝并列出剩余项 |
| `relay_control` | 暂停 / 恢复自动接力，或立即交接 |

## 面板

侧栏「长任务接力」：链列表（状态、进度、当前会话） + 展开后的会话时间线、功能清单、交接说明，以及暂停 / 恢复 / 立即交接。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: longtask-relay
  name: '@local/longtask-relay'
  config:
    handoffRatio: 0.70
    wrapupRatio: 0.55
    maxHandoffs: 32
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `truthDir` | `.relay` | 真理源目录，相对工作区 |
| `autoHandoff` | `true` | 是否允许自动交接 |
| `wrapupRatio` | `0.55` | 进入收尾的上下文比例 |
| `handoffRatio` | `0.70` | 直接触发收尾交接的比例；**必须低于 `compaction-basic` 的 `thresholdRatio`** |
| `handoffAfterCompactions` | `1` | 压缩过几次后，低比例也触发收尾 |
| `compactedRatioFloor` | `0.50` | 配合上一项的比例下限 |
| `hardCompactions` | `2` | 压缩达到几次后不等边界直接交接 |
| `maxHandoffs` | `32` | 单链交接上限 |
| `cooldownMs` | `5000` | 同一会话两次判定之间的最小间隔 |
| `wrapupTimeoutMinutes` | `10` | 收尾后空闲多久仍然强制交接 |
| `agentPreset` | 空 | 新会话使用的 preset；空表示继承当前会话 |
| `pauseGoalOnRetire` | `true` | 交接后暂停旧会话的 goal |
| `notifyOldSession` | `true` | 交接后给旧会话留一条退役说明 |

**重要**：`compaction-basic` 默认在上下文窗口的 0.8 处压缩。如果它先压缩，压力会被降到很低，本插件就不会触发。请保证 `handoffRatio < compaction.thresholdRatio`（默认 0.70 < 0.80），或者把压缩阈值调到 0.9、把 `handoffRatio` 调到 0.78。

## 已知限制

- 顶层会话之间没有父子关系，链结构完全由插件记录；手动归档会话会让链出现悬空引用。
- 新会话会重新支付一遍 system prompt 与工具 schema 的成本。
- 「功能是否真的通过」由 `features.json` 的 `passes` 与 `evidence` 约束，插件不能代替验证。
- 未加载的会话没有实时上下文数值，面板显示「未加载」。
- 一个 Host 进程内的状态不跨进程共享；链本身由文件持久化，重启后按工作区目录重新发现。
- 委派给 subagent 的调用会被工具拒绝。
