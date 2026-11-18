# dsh-longtask-relay 设计方案

状态：草案（待批准后实施）
目标版本：DSH 0.2.2-rc.3（Desktop profile）
作者：lead / 2026-11-18

---

## 0. 一句话

把「一个长任务」变成「一条会话链」：真理源落在工作区文件里，每个会话只承担一个阶段，上下文逼近上限时自动收尾、自动开新会话、自动交接，旧会话退役；一个 Host 侧服务负责判定与执行，一个侧栏面板负责监控。

---

## 1. 问题定义

### 1.1 用户诉求

1. 长任务连续执行，不受单会话上下文限制。
2. 有一个「真理源」作为所有会话的原点。
3. 有一个主会话做统筹，其余会话的状态与执行情况可监控。
4. 自主判断上下文情况，决定是否开新会话。
5. 新会话的任务衔接必须可靠。

### 1.2 DSH 现状（已读实现，非文档推断）

| 机制 | 实现位置 | 已有能力 | 缺口 |
|---|---|---|---|
| 自动压缩 | `@deepseek-ai/dsh-compaction-basic` | `agent/pre-step` 检查压力，越过阈值摘要压缩；`CONTEXT_WINDOW_EXCEEDED` 后压缩重试 | 有损；反复压缩质量递减；不换会话 |
| 自动续轮 | `@deepseek-ai/dsh-goal-round-driver` | `agent/status` idle 时向同一会话 `followup()` 下一轮，goal 状态持久化 | 同会话内循环，不解决上下文 |
| fresh agent 循环 | `@deepseek-ai/dsh-tool-ralph` | 每轮新子 agent，只传有界报告，workspace 当长期记忆 | 子 agent、前台阻塞、用户不可见、无真源 |
| 定时投递 | `@deepseek-ai/dsh-schedule` | `sessionController.create()` + prompt 投递，可每次新开会话 | 只是投递，无衔接、无上下文判定 |
| 团队任务板 | `@deepseek-ai/dsh-agent-team` | 任务 CAS、成员消息 | 成员只能是 subagent，覆盖不到顶层会话 |
| 上下文测量 | `@deepseek-ai/dsh-token-meter` | `contextPressure(session)`、`measure(session)`、`projectedTokens`、`contextWindow` | 无「该换会话了」的判断 |

### 1.3 四个真正的缺口

1. **判定缺失**：压缩是「保命」，换会话是「保质」。没人决定何时从前者升级到后者，而压缩默认在窗口 0.8 抢先发生，等看到 0.85 时上下文已被压到 0.3。
2. **跨会话不可见**：顶层会话之间没有父子关系（`SessionCreateRequest` 无 `parentSession`，`fork` 也刻意不写），`list_agents`/`send_message` 的路由只覆盖 subagent 树。跨会话统筹必须由插件当 broker。
3. **衔接协议缺失**：新会话要么空手开始，要么 fork 复制旧历史（后者正是错的方向——把噪音一起搬过去）。需要「从真理源重建」的协议。
4. **真源与链无人维护**：会话链、角色、轮次、交接记录、任务清单都没有归属者。

---

## 2. 行业对照与采纳

### 2.1 Anthropic《Effective harnesses for long-running agents》

来源：https://www.anthropic.com/research/effective-harnesses-for-long-running-agents

核心结论：
- 单靠 compaction 不够，跨上下文窗口时模型会「一次做太多」，导致下一个会话面对半成品且无文档；后期还会「过早宣布完成」。
- 解法是双角色：**initializer agent** 第一次运行搭好环境，**coding agent** 每次只做增量并留下清晰工件。
- 四件套：feature list（JSON，只允许改 `passes` 字段）、进度文件、`init.sh`、初始 git 提交。
- 会话开头的固定热身：`pwd` → 读进度文件 → 读 feature list → `git log` → 跑一次基本测试。
- 结束前写进度 + 提交，留下「可合并」的干净状态。

**采纳**：initializer/worker 双角色；四件套；热身步骤；一次一个 feature；JSON 作为任务清单（模型更少乱改）；proof before passing。

### 2.2 Manus 六条上下文工程原则

来源：https://manus.im/de/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Memus

1. 文件系统即外部记忆——大内容进文件，上下文只留路径；压缩必须可逆。
2. 靠重复读取计划文件对抗 lost-in-the-middle（约 50 次工具调用后原目标会淡出）。
3. 保留失败痕迹，不隐藏重试。
4. 避免 few-shot 过拟合。
5. 稳定前缀利于 KV cache。
6. append-only，不改写历史。

**采纳**：交接 prompt 只放路径 + 短摘要；每轮开头重读 `PROGRESS.md`；`PROGRESS.md` 保留 `## Errors`；注入只 append。

### 2.3 Phase boundaries（切换时机的判断树）

来源：https://raw.githubusercontent.com/asymmetric-al/core/8ed81f5561c389fa47a576cd4c00d2d03e868fc9/docs/ai/skills/ask-matt/PHASE-BOUNDARIES.md

- 切换只在**阶段边界**决策，mid-phase 压缩会让 agent 丢线。
- 判断顺序：Continue → `/clear` → `/handoff` → subagent → `/compact`；越靠前越便宜、越不失真。
- 每次非 Continue 的动作都把「一手来源」换成「二手摘要」，只在停留的代价更高时才付这个损失。

**采纳**：不在任意 turn 结束就切；先要求当前会话收尾到边界（收尾轮），再交接；上下文里明确「本阶段已结束、下一阶段从文件重建」。

### 2.4 Ralph loop（goose 实现）

来源：https://github.com/aaif-goose/goose/blob/main/documentation/docs/tutorials/ralph-loop.md

- 每轮 fresh context，状态只经文件传递：`task.md`、`iteration.txt`、`review-feedback.txt`、`work-complete.txt`。
- 工作轮与评审轮分离。

**采纳**：链元数据里的 `iteration`；`HANDOFF.md` 作为每轮输入；M3 的 reviewer 角色。

### 2.5 第三方 Claude Code 插件（阈值与交接）

- `context-handoff`：超过约 150K 上下文时提醒，任务结束时写 handoff note，`/clear` 后从 note 恢复。
- `claude-saver`：150K 后开始提醒，新话题时给「开新对话」按钮。
- `claudetto`：hook 直接写 handoff 文件（不花模型调用），再 `/clear` + resume。

**采纳**：交接笔记必须能在**不额外调模型**的情况下写出来（插件机械生成 + 模型可选补充），避免「快满了还要再跑一轮总结」。

### 2.6 多 worker 编排（M3 参照）

- `sol-luna-orchestrator`：主 agent 规划、worker 在独立 worktree 执行、独立验证、worker 不可再派发。
- `agent-orchestrator`：feature 分支 + 失败分类 + 独立验证 agent。

**采纳**（M3）：worker 任务范围互斥、独立 worktree、reviewer 独立验证、worker 禁止再派发。

### 2.7 我们不采纳的

- 不采纳「每次切换都让模型写总结」：临界上下文下这次调用最容易失败。改成插件机械生成 + 模型可选的 `relay_checkpoint` 补充。
- 不采纳「无限 fresh loop」：必须有 `maxHandoffs`，否则一次跑飞就是无限烧钱。
- 不采纳「fork 旧会话」作为接力手段：历史噪音会被完整复制，直接违背换会话的目的。

---

## 3. 核心概念与数据模型

### 3.1 链（RelayChain）

一条链 = 一个长任务的全部生命。字段（`chain.json`，插件私有）：

```jsonc
{
  "version": 1,
  "chainId": "chain-<uuid>",
  "objective": "用户原话/需求一句话",
  "cwd": "D:\\project\\x",
  "truthDir": "D:\\project\\x\\.relay",
  "status": "initializing | active | paused | done | failed",
  "createdAt": "2026-11-18T03:00:00.000Z",
  "updatedAt": "2026-11-18T05:00:00.000Z",
  "sessions": [
    {
      "sessionId": "session-<uuid>",
      "role": "initializer | worker | reviewer | leader",
      "index": 0,
      "joinedAt": "...",
      "retiredAt": "...",
      "retireReason": "handoff | done | paused | manual",
      "compactions": 1,
      "peakPressureRatio": 0.71,
      "handoffsIn": 0
    }
  ],
  "currentSessionId": "session-<uuid>",
  "handoffCount": 3,
  "maxHandoffs": 32,
  "featuresTotal": 12,
  "featuresDone": 4,
  "lastError": null
}
```

### 3.2 真理源四件套（工作区内）

目录：`<cwd>/.relay/`（可配置；建议进 `.gitignore` 或显式提交，二选一由用户定）

1. **`features.json`** — 任务清单，机器可校验，硬约束来源。

```jsonc
{
  "version": 1,
  "objective": "...",
  "features": [
    {
      "id": "F001",
      "title": "登录接口返回 401 时前端跳转登录页",
      "priority": 1,
      "passes": false,
      "evidence": null,
      "verify": "pnpm test auth/redirect.spec.ts",
      "notes": ""
    }
  ]
}
```

约束：模型只能用 `relay_checkpoint` 改 `passes` / `evidence` / `notes`；不得增删条目（插件校验并拒绝）。新增需求只能通过 `relay_add_feature`（M1 可不做，先由 initializer 一次写全）。

2. **`PROGRESS.md`** — 人类可读进度，模型每轮必读必写。

```markdown
# PROGRESS
## Done
- F001 ...
## In progress
- F002 当前在做什么、做到哪
## Next
- F003 下一个要做的 feature id
## Errors
- [2026-11-18 12:10] 测试 X 失败：原因 → 修法
## Notes
- 关键决策、环境坑
```

3. **`HANDOFF.md`** — 每次交接重写，短（≤ 60 行），只给下一个会话看。上一份全文由插件自动追加到 `history.md`（带会话 id、原因、时间），可用 `relay_recall` 检索。

```markdown
# HANDOFF
Chain: chain-xxx  Handoff #3  上一会话: session-yyy
目标: ...
本阶段完成: F001, F002
下一阶段第一件事: F003（读 features.json 的 F003）
验证命令: pnpm test
未解决的坑: ...
不要做: 不要重写已通过的部分；不要改 features.json 的条目
```

4. **git 状态** — 建议每次交接前提交；是否强制由 `requireCleanGit` 配置（默认 false，只提示不阻断）。

### 3.3 角色

| 角色 | 何时出现 | 职责 |
|---|---|---|
| `initializer` | 第一个会话 | 读需求 → 写 `features.json`（尽量穷举，全部 `passes:false`）→ 写 `PROGRESS.md` → 确定验证命令 → 首次提交 → 开始第一个 feature |
| `worker` | 每次接力 | 读四件套 → 热身验证 → 一次做一个 feature → 更新 `PROGRESS.md` → 收尾 |
| `reviewer` | M3 | 只读 + 跑验证，输出 `passes` 建议；不写业务代码 |
| `leader` | M3 | 统筹多个 worker，读链状态，汇总；自己也是 worker（会被接力） |

### 3.4 状态机

会话级（插件内存 + 链文件）：

```
watching ──(压力到达 wrapup)──> wrapping ──(边界确认 或 到达 handoff)──> handing_off
   │                                                                        │
   └──(链暂停/完成)──> retired <──(新会话创建成功)───────────────────────────┘
```

链级：`initializing → active → (paused) → done | failed`。
每次迁移写链文件并广播 `relay/changed`（M2 给面板）。

---

## 4. 架构

```
Host 插件 @local/longtask-relay
├── ctx.relay (Service)
│   ├── ChainStore     真源文件读写 + 校验（原子写：临时文件 + rename）
│   ├── Supervisor     事件订阅 + 判定（每会话一个状态机）
│   ├── Handoff        创建会话 / 命名 / 挂 workspace / 投递交接 prompt
│   ├── Tools          relay_start · relay_status · relay_checkpoint · relay_finish · relay_handoff_now
│   └── Projection     relaySession（每会话瘦视图，进 list summary 供面板）
└── client half
    ├── main 面板（全局一级侧栏入口）+ sidebar.panellist 图标
    └── Remote 命名空间 relay（listChains / chainDetail / pause / resume / handoffNow / finish / openSession）
```

### 4.1 依赖注入

```js
export const name = 'longtask-relay'
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt']
// 可选（ctx.get）：tokenMeter, sessionController, sessionProjections, sessionTitle,
//                  workspaceRegistry, goals, llm, jobs, sessionQuery, sessionPersistence
```

`sessionController` 缺失时：接管与判定仍可用，但自动接力退化为「只提示不执行」，`relay_handoff_now` 返回错误。`tokenMeter` 缺失时：只用压缩计数与 turn 计数判定。

### 4.2 事件订阅（全部挂在根 ctx，作用于所有会话，按链过滤）

```js
ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') scheduleEvaluate(agent) })
ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/end') { onTurnEnd(session, event) }
  if (event.type === 'compaction/start') { bumpCompactions(session) }
  if (event.type === 'compaction/end' && event.data.error === undefined) { markCompacted(session) }
})
ctx.on('agent/request-error', async ({ agent, failure }, next) => {
  if (failure.code === 'CONTEXT_WINDOW_EXCEEDED' && isRelaySession(agent)) { markEmergency(agent) }
  return next()   // 必须交出恢复权，压缩逻辑归 compaction-basic
})
ctx.on('agent/disposed', ({ agent }) => { ... })
```

要点（读实现得出）：
- `turn/end` 先于 `agent/status('idle')`，`turn/end` 里 `agent.status` 仍是 `running`；判定放 `agent/status`。
- `agent/status` 只在状态真变化时 emit，`runMaintenance`（含 compactNow）不 emit idle —— 判定不必依赖它，但要防重入（自己加锁）。
- 判定前必须确认 `agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0`，否则用户输入会被接力打断。
- 不抢 `agent/request-error` 的恢复权，压缩仍由 `compaction-basic` 负责；我们只在事后决定换会话。

### 4.3 判定（Supervisor）

每次 idle 且无排队输入，且该会话属于某条 `active` 链时：

```
1. 幂等锁：同会话同时只跑一次 evaluate
2. 冷却：距上次判定 < cooldownMs（默认 5s）则跳过
3. 状态：
   pressure  = tokenMeter.measure(session).totalTokens      （拿不到则用 contextPressure().pressureTokens）
   window    = tokenMeter.contextPressure(session).contextWindow
   ratio     = pressure / window
   compacts  = 本会话 compaction/end 成功次数（自己的投影计数）
   features  = 读 features.json：done / total
4. 决策：
   - 链不是 active → 不动作
   - ratio >= handoffRatio (0.70)                    → 进入 wrapping，注入收尾指令
   - compacts >= handoffAfterCompactions (1) 且 ratio >= 0.50 → 进入 wrapping
   - 已 wrapping 且（收尾轮已结束 且 features 无 in_progress 且 ratio >= wrapupRatio) → 执行交接
   - 已 wrapping 且收到模型 relay_checkpoint(ready=true) → 执行交接
   - 硬兜底：compacts >= hardCompactions (2) 或 收到 CONTEXT_WINDOW_EXCEEDED → 立即交接（不等边界）
5. features.done == features.total 且 HANDOFF 有证据 → 链置 done，不交接
```

为什么阈值是 0.70 而不是贴近 0.85：`compaction-basic` 默认 `thresholdRatio = 0.8`。判定必须留出一个完整收尾轮的余量（收尾轮要读文件、改代码、跑测试、提交，可能吃掉 5–10%）。0.70 给收尾轮留约 10%，同时离 0.8 的压缩线还有距离。若用户把 compaction 阈值调到 0.9，本插件可把 `handoffRatio` 同步调到 0.78（配置项，文档里写建议值）。

### 4.4 收尾指令（wrapping 阶段注入，`agent.inject` 不唤醒）

用 `inject` 而不是 `followup`：收尾要求搭在当前轮次末尾，不额外开轮。若当前已 idle（边界刚过），用 `followup` 开一轮收尾。

```markdown
<relay_wrapup>
This session is nearing its context limit and will be handed off to a fresh session.
Before the handoff, do exactly this and nothing new:
1. Finish the single feature you are on, or stop at a clean boundary and leave it partially done with notes.
2. Write .relay/PROGRESS.md: Done / In progress (what exactly remains) / Next (the next feature id) / Errors / Notes.
3. Run the project's verification command once and record the result in PROGRESS.md.
4. Update .relay/HANDOFF.md (≤ 60 lines) for the next session: what you completed, the exact next action, the verification command, and any trap you hit.
5. Do not start a new feature. Do not delete or rewrite existing entries in features.json.
6. When done, call relay_checkpoint with ready=true and a one-paragraph summary.
</relay_wrapup>
```

### 4.5 交接执行（Handoff）

```js
async function handoff(chain, oldAgent) {
  // 1. 读到最新的四件套
  const truth = readTruth(chain.truthDir)          // features + PROGRESS + HANDOFF
  // 2. 创建新会话（同目录、同 preset）
  const { sessionId } = await ctx.sessionController.create({
    cwd: chain.cwd,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
  // 3. 命名 + 挂到同一 workspace（失败只告警）
  ctx.get('sessionTitle')?.rename(session, `${chain.title} · 接力 ${n}`)
  await ctx.get('workspaceRegistry')?.resolveByPath(chain.cwd).then(w => w?.attachSession(sessionId))
  // 4. 投递交接 prompt（queue 模式；该会话此刻 idle）
  await ctx.sessionController.prompt({
    requestId: `relay-${chain.chainId}-${n}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: renderHandoff(chain, truth) }],
  })
  // 5. 更新链文件：旧会话 retired、新会话为 current、handoffCount++
  // 6. 旧会话收尾：pause 其 goal（若挂载）、注入退役说明、不再参与判定
  // 7. 广播 relay/changed（面板刷新）
}
```

失败处理：`create` 成功但 `prompt` 失败 → 保留链文件中的 `pendingHandoff`，在旧会话注入「交接失败，请重试或手动处理」，链置 `paused`，不自动重试（避免重复建会话烧钱）。

### 4.6 交接 prompt 模板（逐字）

结构遵循 Manus「上下文只放路径」。整段控制在 1200 字符内。

```markdown
<relay_handoff>
You are taking over a long-running task from a previous session. That session's conversation is NOT yours;
rebuild context from the files below instead of guessing.

Objective: <一句话>
Chain: <chainId>   Handoff: #<n>   Previous session: <oldSessionId>
Truth directory: <absolute path to .relay>
Progress: <done>/<total> features passing. Last handoff summary: <3 行以内>

Do this first, in order, before any other work:
1. pwd; confirm the working directory is <cwd>.
2. Read <truthDir>/HANDOFF.md, then <truthDir>/PROGRESS.md, then <truthDir>/features.json.
3. Run the project's verification command once (<verify>) so you start from a known state. If it fails, fix
   that first and record why in PROGRESS.md.
4. Pick the single highest-priority feature with "passes": false and work on that one only.

Rules for this session:
- One feature at a time. Do not start a second one.
- Update <truthDir>/PROGRESS.md before you stop for any reason.
- Only change `passes`, `evidence`, `notes` in features.json. Never remove or rewrite entries.
- Mark a feature passing only after running its `verify` command and seeing it pass.
- Treat the workspace and these files as authoritative. Prior narration is not evidence.
- When the whole objective is verified done, call relay_finish with evidence. If you hit a blocker,
  call relay_checkpoint with blocked=true and the concrete blocker.
</relay_handoff>
```

### 4.7 工具面

注册方式：`ctx.tools.register(defineTool({ ... }))`，scope 跟随插件挂载点。

| 工具 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `relay_start` | `objective`（必填）、`cwd`（默认当前会话目录）、`maxHandoffs`、`featuresFile`（可导入已有清单） | 创建链、把当前会话设为 `initializer`、生成 `.relay/` 骨架、注入初始化指令 | `{ chainId, truthDir, firstSteps }` |
| `relay_status` | `chainId?`（省略=全部） | 读链 + 实时会话状态（running、ratio、compacts、role） | 链数组（≤ 8 条，超出要求 chainId） |
| `relay_checkpoint` | `chainId?`、`nextStep?`、`summary?`、`blocked?`、`ready?`、`featureUpdates?` | 更新 PROGRESS/HANDOFF/features；`ready=true` 触发交接 | `{ ok, featuresDone, featuresTotal }` |
| `relay_finish` | `chainId?`、`evidence`（必填） | 校验全部 features `passes`，否则拒绝并返回未完成清单 | `{ ok } | { code:'features_incomplete', pending:[...] }` |
| `relay_handoff_now` | `chainId?` | 手动立即交接 | `{ newSessionId }` |

工具全部拒绝 `delegationDepthOf(agent) > 0` 的调用者（subagent 不能操作链）。

---

## 5. 监控面板（M2）

### 5.1 Host 侧：一个瘦投影

```js
const handle = await ctx.sessionProjections.register({
  key: 'relaySession',
  stateVersion: 1,
  stateSchema: /* relay 字段 */,
  init: () => ({ chainId: null, role: null, compactions: 0, pressure: 0, window: 0, handoffs: 0, lastActivity: 0 }),
  apply: (s, e) => /* compaction/start、compaction/end、assistant/message、turn/end；其余返回 s */,
  wire: { viewSchema, view: s => s },
})
```

关键：`contextPressure` / `contextBreakdown` 是 `SessionProjectionSummaryExcluded`，**不进** `session/list` 的每一行。要面板对所有会话显示压力，必须自有投影且不设 `summary:false`。`relaySession` 的 `apply` 里同时累计压缩次数——DSH 没有官方「第几次压缩」序号，只能自己数（`compaction/start` 计数，`compaction/end` 且 `error === undefined` 计成功）。

### 5.2 Client 侧

- 全局一级面板：`main` keyed slot（`key: 'relay'`）+ `sidebar.panellist` 图标行（同一个 id）。
- 数据：`useSessions()`（有 running / updatedAt / projectionValues） + `useSessionStatus()` + 自有投影值；链元数据走 `remote.relay.listChains`。
- 三块布局：
  1. 链列表：目标一行、状态徽标、进度条 `featuresDone/Total`、当前会话标题、最近活动。
  2. 链详情（点开）：会话时间线（每个会话：角色、轮次、终态原因、峰值占用、压缩次数），当前会话高亮。
  3. 操作：暂停/恢复自动接力、立即交接、结束链、跳到会话（`ctx.layout.selectPanel(null)` + 打开会话）。
- 样式只用 `--dsw-alias-*` / `--dsh-*` token；文案走 `ctx.locale.register`（zh + en 基线）；组件做错误边界，避免整个 slot entry 崩掉。

### 5.3 Remote

```js
class RelayRemote extends TypertRemoteService {
  @Remote('listChains')  async listChains() { ... }
  @Remote('chainDetail') async chainDetail({ chainId }) { ... }
  @Remote('pause')  async pause({ chainId }) { ... }
  @Remote('resume') async resume({ chainId }) { ... }
  @Remote('handoffNow') async handoffNow({ chainId }) { ... }
  @Remote('finish') async finish({ chainId, evidence }) { ... }
}
```

变更时 `ctx.emit('relay/changed', payload)`，Client `ctx.remote.$on('relay/changed', refresh)`。

---

## 6. 多会话编排（M3，用户原始设想中的「主会话统筹」）

### 6.1 角色扩展

- `leader`：一个链可以同时挂多个 `worker` 子链（每条子链有自己的 `.relay/` 目录或同一目录下的 `workers/<id>.json`）。
- 分工：leader 持有 `features.json` 的主清单，把 `worker-eligible` 且互不冲突的 feature 分给 worker；每个 worker 在独立 git worktree 中执行。
- 汇总：worker 的 `relay_checkpoint` 会 `agent.inject` 一条进度消息到 leader（不唤醒），leader 在下次空闲时读取并更新主清单。
- 完成判定：leader 调用 `relay_finish` 时要求每个 worker 都已 `retired(done)` 且 reviewer 已验证。

### 6.2 约束（来自行业教训）

- worker 不能继续派发（`relay_spawn_worker` 拒绝非 leader 调用者）。
- 每个 worker 有独立 worktree（`dsh-experimental-worktree` 或插件自建 `git worktree`），避免写冲突。
- reviewer 只读：`ctx.tools.restrict()` 在 reviewer 的 agent scope 内移除写工具。
- 并发上限 `maxWorkers`（默认 2），超出排队。
- leader 自身也会被接力（leader 的上下文同样会满）。

### 6.3 为什么不做成 subagent

subagent 的路由、目录、命名都服务于「委派」语义，用户无法把它当独立对话继续；而本需求的核心是「用户能在侧栏看到、能随时进去接管」。所以 worker 必须是顶层会话，代价是插件必须自己维护 membership（没有官方父子关系可用）。

---

## 7. 配置

```yaml
- id: longtask-relay
  name: '@local/longtask-relay'
  config:
    truthDir: .relay            # 相对 cwd
    autoHandoff: true
    wrapupRatio: 0.55           # 进入收尾
    handoffRatio: 0.70          # 收尾后仍到点就强制交接
    handoffAfterCompactions: 1  # 压缩过 1 次后，ratio ≥ 0.50 也触发
    hardCompactions: 2          # 立即交接，不等边界
    maxHandoffs: 32             # 单链上限，防跑飞
    cooldownMs: 5000
    maxWorkers: 2               # M3
    agentPreset: ''             # 空 = 继承创建者的 preset
    requireCleanGit: false      # true 时交接前检查 git 是否干净
    notifyOldSession: true      # 旧会话注入「已交接给 X」
    pauseGoalOnRetire: true     # 旧会话有 armed goal 时 pause
    seedGoalOnHandoff: false    # 新会话按链目标建 goal，交给目标轮驱动
    goalRoundsPerHandoff: 16    # 给新会话 goal 的续轮上限
```

---

## 8. 失败模式与对策

| 失败模式 | 来自 | 对策 |
|---|---|---|
| 一次做太多，下一会话面对半成品 | Anthropic | 交接 prompt 强制「一次一个 feature」；收尾指令要求停在干净边界并写清剩余 |
| 过早宣布完成 | Anthropic | `relay_finish` 校验 features 全部 passes；passes 只允许在 verify 通过后改 |
| 收尾轮自己撞上上下文上限 | 本地推演 | `handoffRatio` 留 10% 余量；硬兜底允许不等边界直接交接；交接内容来自文件而非模型总结 |
| compaction 抢先压缩、判定永远不触发 | 本地推演 | 阈值必须低于 compaction 的 0.8；同时用压缩计数作为触发源 |
| 交接时用户正在输入 | 本地推演 | 只在 `inbox.nextTurn/nextStep` 为空时切换；有排队输入则推迟到下一空闲 |
| 新会话「重新发明」已完成的工作 | Anthropic | 交接 prompt 第 2 步强制读三份文件 + 第 3 步跑验证；PROGRESS 里写明 `不要重写已通过的部分` |
| 交接 prompt 太长又吃掉上下文 | Manus | 只给路径 + ≤ 3 行摘要 + 下一步，整段 ≤ 1200 字符 |
| 创建成功但投递失败 | DSH schedule 的同类教训 | 记录 `pendingHandoff`，链置 paused，不自动重试 |
| 无限接力烧钱 | 本地推演 | `maxHandoffs`；每次交接在链文件留审计记录 |
| 冷会话读不到压力 | DSH 实现 | 面板对未加载会话显示「未加载」，不重放全日志 |
| 旧会话的 goal 继续自动跑 | DSH goal-round-driver | 交接后 `ctx.goals.pause(agent, ref)`；旧会话标记 retired 后不参与判定 |
| 目标阻塞后链仍显示「进行中」 | DSH goal | 判 idle 时读链头 goal；`blocked` 记 external 阻塞并暂停链（`pauseOnExternalBlocker=false` 时只记录、继续交接），goal 恢复后这条阻塞自动解除 |
| 面板组件崩溃导致空面板 | DSH UI 约束 | 错误边界 + 空态文案 |

---

## 9. 分期交付与验证判据

### M1 单链自动接力（核心闭环）

| 步骤 | 内容 | 验证判据 |
|---|---|---|
| M1-1 | 包骨架（package.json / cordis.patch.yml / locale / icon / README） | `plugin_manager` 安装返回 `application: applied`；`cordis_inspect_query` 能看到 row |
| M1-2 | `ChainStore` + 四件套读写 + schema 校验 | 单测：写→读→改；非法 features 被拒；原子写不产生半截文件 |
| M1-3 | `relay_start` / `relay_status` / `relay_checkpoint` / `relay_finish` 工具 | 在临时目录实跑：`relay_start` 后 `.relay/` 三文件存在且可解析；`relay_finish` 在 features 未全通过时返回 `features_incomplete` |
| M1-4 | Supervisor 判定 + 收尾注入 | 单测注入假 tokenMeter：ratio 0.6 时无动作；0.72 时注入一次 wrapup 且只注入一次；inbox 非空时不动作 |
| M1-5 | Handoff 执行 | 集成测试：mock `sessionController`，断言 create 的 cwd/preset、prompt 内容含 truthDir 与 next feature、链文件迁移正确、旧会话收到退役注入 |
| M1-6 | 端到端 | 真实跑一个需要 3+ 个 feature 的小任务，把 `handoffRatio` 调到 0.35 强制提前交接，观察：新会话出现、首条消息正确、新会话能继续推进、旧会话不再自动动作 |

### M2 监控面板

| 步骤 | 内容 | 验证判据 |
|---|---|---|
| M2-1 | `relaySession` 投影 | 单测 fold：压缩事件计数正确；会话行 summary 里出现该 key |
| M2-2 | Remote | 面板调用返回与链文件一致 |
| M2-3 | 面板 UI | 侧栏出现图标；点开列出 ≥1 条链；按钮操作后链状态变化；刷新页面数据仍正确；深浅色都正常 |

### M3 主 + worker 编排

| 步骤 | 内容 | 验证判据 |
|---|---|---|
| M3-1 | worker 派发与 worktree 隔离 | 两个 worker 同时改不同文件不冲突；worker 调用派发工具被拒 |
| M3-2 | leader 汇总 | worker checkpoint 后 leader 下次空闲读到进度注入 |
| M3-3 | reviewer 验证 | reviewer 无写工具；reviewer 的 `passes` 建议能被 leader 采纳 |

### M4 可选

- 自适应阈值（按剩余 feature 数动态调整 handoffRatio）
- 跨日/跨机器链迁移（导出/导入 chain.json 与四件套）

---

## 10. 已知限制（必须接受）

1. **顶层会话没有父子关系**：DSH 不会替我们维护会话间的从属，链结构完全由插件记录；用户手动归档/删除会话会让链出现悬空引用（插件降级为「该会话不可用」）。
2. **新会话是全新上下文**：它会重新付一遍 system prompt + 工具 schema 的成本，这是换会话的固有价格。
3. **交接质量依赖模型遵守指令**：`features.json` 是硬约束，但「是否真的跑了验证」只能靠证据字段与人工审查。
4. **冷会话不可观测**：未加载的会话没有 Agent，压力读不到；面板显示「未加载」而不是假数据。
5. **compaction 与 relay 是两套机制**：如果用户把 compaction 阈值调到低于 `handoffRatio`，接力永远不会触发；配置文档必须写明「handoffRatio < compaction.thresholdRatio」。
6. **子 agent 不能操作链**：工具侧主动拒绝，避免一个 subagent 把整条链搅乱。
7. **单进程**：链状态在 Host 内存 + 文件，不支持多个 Host 同时操作同一链（M4 才有讨论价值）。

---

## 11. 待定问题（需要用户拍板）

1. ~~`.relay/` 是否提交进 git？~~ 已定：提交进 git。
2. ~~首版是否需要「reviewer 独立验证」？~~ 已定：M3 再说。
3. ~~自动接力的默认 throttle：`maxHandoffs` 默认 32 够不够？~~ 已定：32，可配。
4. ~~新会话是否沿用当前会话的 agent preset？~~ 已定：沿用，`agentPreset` 可覆盖。

---

## 12. 实现状态（2026-11-18）

### 已实现

| 模块 | 文件 | 说明 |
|---|---|---|
| 真源存储 | `lib/chain-store.js` | 四件套读写、原子写、feature 变更约束、`ChainIndex` 跨生命周期索引 |
| 判定与交接 | `lib/engine.js` | 压力/压缩判定、收尾、创建会话、投递交接、旧会话退役、失败回退 |
| 工具 | `lib/tools.js` | `relay_start` / `relay_status` / `relay_checkpoint` / `relay_audit` / `relay_recall` / `relay_spawn` / `relay_finish` / `relay_control`（pause / resume / handoff / delete） |
| 投影 | `lib/projection.js` | `relaySession` 每会话视图（压缩次数、轮次），进会话列表摘要 |
| Remote | `lib/remote.js` | 手写 Typert 绑定与原型标记，命名空间 `relay` |
| 面板 | `client.js` | `main` 面板 + `sidebar.panellist` 入口，链列表/详情/暂停/交接 |
| 配置 | `lib/config.js` | Standard Schema 手写校验，无外部依赖 |

纯 JS、零依赖：profile 无法解析 `@deepseek-ai/*`，因此工具用原始 JSON Schema、投影 schema 用鸭子类型、Remote 用原型标记、配置用手写 `~standard`。

### 已验证

- 单测 13/13（`node test/smoke.mjs`）：真源读写、feature 变更约束、索引、判定阈值、收尾只发一次、ready 交接、压缩强制交接、finish 拒绝、失败回退。
- 真实端到端：`schedule` 投递 → 新会话调用 `relay_start` → 真源文件生成 → 模型写入 `features.json` → 手动 `relay_control(handoff)` → 新会话创建（同 cwd、preset standard）→ 首条消息为 `<relay_handoff>`（含真源绝对路径、进度、下一个 feature）→ 新会话开始工作；链文件 `handoffCount=1`、旧会话 `retiredAt`/`retireReason` 正确。
- 插件安装返回 `application: applied`，行 `include:longtask-relay` 为 active。

### 未验证

- **面板渲染**：DSH Web 需要登录凭证，自动化浏览器拿到 401，无法截图确认。面板代码已通过语法检查、Host 侧 Remote 与投影已随插件 active，但「侧栏出现入口、点开有数据」需要用户在应用内刷新页面确认。
- **自动触发**：真实会话跑到 70% 上下文才触发收尾与自动交接。单测覆盖了判定逻辑，但真实模型会话下的完整自动链路尚未跑到（端到端用的是手动交接）。
- **压缩计数投影**：真实会话发生一次自动压缩后才能观察到 `relaySession` 的值。

### 已知问题

- E2E 的 initializer 会话（`session-b0378d27`）在写入 `features.json` 后长时间保持 running，未继续后续步骤；退役后仍显示 running。这与插件无关（插件不阻塞该会话的任何操作），但说明用 `schedule` 驱动多步任务的可靠性一般。
- 链的 cwd 与会话 cwd 不同时，重启后依赖 `ChainIndex` 发现；若索引文件被删，只能通过打开该链的会话重新发现。

