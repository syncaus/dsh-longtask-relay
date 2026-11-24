# 长任务接力：门禁与交付核验（1.6.0，1.6.1 修边界）

状态：已实现（分支 `feat/relay-gates`），未在真实 DSH 里实跑，见第 6 节
需求方原话：「任务创建后的门禁和约束，就是人工和模型都可以随便改也可以欺骗说完成了，然后代码交付后也需要做核验是否和设计一致，目前是模型说什么是什么。你看下还有哪些类似的问题，完善下。」
已拍板（2026-11-24）：篡改 → 拒绝 + 人工裁决；设计核验 → 独立评审会话；完成 → 必须人工确认。之后的设计选择按推荐做，记在文末裁定台账。

## 1. 改前的漏洞（读实现得出）

| # | 漏洞 | 位置 |
|---|---|---|
| 1 | 冻结只记 id + title；`passes`、`evidence`、`coverage`、`verify`、`assignedSessionId`、`dependsOn` 直接改文件不被发现 | `fingerprints.js`、`engine.js` 的 `verifyFrozen` |
| 2 | 冻结前 `features.json` 可随便写，初始化会话可以把 `passes:true` + 假证据预置进去，冻结时不检查 | `engine.js` 的 `freezeFeatures` |
| 3 | 人工验收只看 `acceptedBy === 'human'` 且 `acceptedAt` 是字符串，可手写伪造 | `engine.js` 的 `finish` |
| 4 | `relay.json` 在工作区，引擎读回只校验格式；改 `status:"done"`、`maxHandoffs`、`sessions`、`currentSessionId` 都生效 | `chain-store.js` 的 `validateChain`、`engine.js` 的 `locate` |
| 5 | `PLAN.md` / `SPEC.md` 冻结后仍可改，等于挪验收标准 | 无快照 |
| 6 | `audit.jsonl` 在工作区，可删可截 | `chain-store.js` 的 `appendAudit` |
| 7 | 插件从不执行验证命令，「证据」只是正则查文本里有数字和 pass/exit 等词 | `evidence.js` |
| 8 | `verify` 可以为空；feature 通过后再提交的代码把它弄坏，finish 也不重跑 | `engine.js` 的 `finish` |
| 9 | 集群 worker 报 pass 后只给链头发「请重跑」通知，没有强制 | `engine.js` 的 `notifyClusterHead` |
| 10 | 没有对照 SPEC/PLAN 的交付核验 | DESIGN.md 的 reviewer 一直没做 |
| 11 | 模型 `relay_finish` 后链直接 done，不需要人 | `engine.js` 的 `finish` |
| 12 | 提示词明确允许直接改 `features.json` 的 passes/evidence/coverage/notes | `prompts.js` 的 `renderInitializerPrompt` |

## 2. 方案

### 2.1 宿主侧封存（治 1–6、12）

- 新文件 `lib/seals.js`：`SealStore`，每条链一份 `~/.dsh/longtask-relay/seals/<chainId>.json`，内存缓存 + 原子写。
- 封存内容：`relay.json`（链建立起）、`features.json` + `PLAN.md` + `SPEC.md`（冻结起）的规范化全文；已批准的验证命令；当前篡改记录。
- 比对用规范化内容（JSON 按键排序重排，文本统一 LF 并去首尾空白），git 改换行不算篡改。
- 插件自己的写入（`ChainStore.writeChain`、`writeFeatures`）写完即刷新封存。
- 读取（`ChainStore.readChain`、`readFeatures`，以及链读取时顺带检查 PLAN/SPEC）发现不一致：
  1. 记一条篡改记录（哪些文件、何时），审计 `truth.tampered`；
  2. 读取返回**封存版本**（引擎按可信状态判断），磁盘上的改动原样保留作证据；
  3. 该链所有工作区写入被拒（`truth_tampered`），监督不再动作，链头 goal 暂停；
  4. 面板标红并给出封存版本与磁盘版本，人选「恢复封存版本」或「采纳磁盘改动（必填理由）」，裁决写审计。
- 已有链首次被读到时按当前磁盘内容补封存（已冻结的链连 features/PLAN/SPEC 一起），审计 `truth.sealed`。
- 冻结时把没有插件验证记录的 `passes:true` 全部打回 false，审计 `feature.unverified-reset`（治 2）。
- 审计同时追加一份到宿主侧 `~/.dsh/longtask-relay/audit/<chainId>.jsonl`，面板和 `relay_audit` 读宿主侧这份（治 6）。

### 2.2 插件执行验证（治 7–9）

- 新文件 `lib/verify.js`：在链的 cwd 里用 shell 执行命令，带超时（`verifyTimeoutSeconds`，默认 900），超时杀进程树；保留输出尾部 2000 字符、退出码、耗时、git HEAD。
- `verify` 写 `statusCheck` / `verifyFast` / `verifyFull` 时解析成文档根上的命令。
- `relay_checkpoint` 标 `passes:true` 时插件先跑该 feature 的命令，退出码 0 才翻转，验证记录写进 feature 的 `verification` 字段（受封存保护）；模型写的 evidence 只当备注。
- 模型不能提交 `verification` 字段；`verify` 只能在原本为空时补一次，改已有命令要人在面板采纳。
- **命令审批**：插件跑命令时不在会话沙箱里，模型写的命令等于沙箱外执行。所以每条命令首次执行前必须由人在面板批准（`requireCommandApproval`，默认开）；未批准时 checkpoint 返回 `verify_unapproved` 并在面板列出待批命令。批准按「命令 + 用途」记：人看到的是「这条命令验证 F001、F002」，之后新增的 F003 复用同一条命令要重新批准，免得「F003 的验证其实只是 lint」被藏住。
- finish 时把所有 feature 的命令（去重）和 `verifyFull` 在当前 HEAD 重跑；某 feature 的命令失败 → 该 feature 重开（审计 `feature.regressed`）并拒绝 finish。
- worker 的 pass 走同一路径，不再依赖链头自觉重跑。

### 2.3 独立评审会话（治 10）

- finish 的机器门禁全过后，链进入 `reviewing`，插件新开一个评审会话：角色 `reviewer`、计划模式（只读）、不是任何实现过的会话。
- 评审提示词给出 SPEC/PLAN/features/decisions 路径和链起点提交（`baseCommit`，建链时记录），要求对每个 feature 给 `match | mismatch | missing`，并列出 SPEC 里没有 feature 覆盖的需求。
- 新工具 `relay_review`：只有当前评审会话能调；必须覆盖每个 feature；mismatch/missing 必须写发现。
- 结果：
  - 全部 match 且无未覆盖需求 → `awaiting_acceptance`；
  - 否则 → 对应 feature 重开（发现写进 notes），未覆盖需求写进 PROGRESS，链回 `active`，通知链头；
  - 提交并判为不通过的评审累计达到 `maxReviewRounds`（默认 3）→ 不再开新评审，直接进 `awaiting_acceptance`，面板写明「连续 N 轮未通过」，由人决定。被取消、没启动成功的评审不计数。
- 评审会话提交后退役；所有写工具对 reviewer 拒绝（`reviewer_read_only`）。
- Host 不能建会话时，跳过评审直接进 `awaiting_acceptance`，面板标「未经独立评审」。

### 2.4 人工终验（治 11）

- `awaiting_acceptance` 只能由面板「确认完成」变成 `done`（这时才完成 goal），或「驳回（必填理由）」回 `active` 并通知链头。
- `requireHumanFinish` 默认开；关掉时评审通过直接 done。

### 2.5 状态机增量

| 从 | 到 | 谁 | 前置条件 |
|---|---|---|---|
| active / paused | reviewing | finish（模型链头或面板） | 门禁全过、重跑全过、`independentReview` 开 |
| active / paused | awaiting_acceptance | finish | 同上，评审关闭或不可用 |
| reviewing | awaiting_acceptance | relay_review | 全部 match |
| reviewing | active | relay_review | 有 mismatch/missing/未覆盖 |
| reviewing | paused（manual） | 面板暂停（只有人） | 取消这轮评审，评审会话退役，不计轮数 |
| reviewing | paused（review-failed） | startReview | 评审会话建不起来或投递失败 |
| reviewing / paused（review-failed） | reviewing | 面板「重新评审」 | 评审会话卡住或没起来 |
| active / paused | awaiting_acceptance | finish | 不通过的评审已达 `maxReviewRounds` |
| awaiting_acceptance | done | 面板「确认完成」 | — |
| awaiting_acceptance | active | 面板「驳回」 | 理由非空 |

`reviewing` / `awaiting_acceptance` 下：checkpoint、交接、派发都拒绝；`reviewing` 只有人能暂停（等于取消评审），`awaiting_acceptance` 不能暂停或恢复，只能确认或驳回。

## 3. 闭环链

一句话闭环：模型直接改 `features.json` 把未做的 feature 标成通过并调 `relay_finish` 之后，在面板看到这条链被标为「真理源被篡改」，finish 被拒；正常做完的链，在面板看到「待验收」和评审结论，点「确认完成」后才是 done。

| 环 | 发生什么 | 由谁触发或生产 | 正向可观测量 | 失败时谁看得见 |
|---|---|---|---|---|
| 1 入口 | 模型调 `relay_checkpoint` / `relay_finish`，或人点面板按钮 | `lib/tools.js`、`client.js` | 工具返回 / 面板请求 | 工具返回 `ok:false` 和码 |
| 2 门禁 | 篡改比对、命令审批、插件跑验证 | `lib/seals.js`、`lib/verify.js`、`engine.js` 的 `verifyFeatures` | feature 上出现 `verification`；或返回 `truth_tampered` / `verify_failed` | 审计 + 工具返回 |
| 3 落盘 | 封存刷新、状态迁移、审计双写 | `chain-store.js` 写入口、`SealStore` | `seals/<chainId>.json` 变化、宿主侧审计 +1 | 写失败抛 `truth_io_failed` |
| 4 评审 | 新建评审会话，评审提交 | `engine.js` 的 `startReview` / `submitReview` | 链上出现 reviewer 会话、`review` 记录、REVIEW.md 一节 | 建会话失败 → 链暂停 `review-failed`，面板可重试 |
| 5 用户可见 | 面板：篡改卡、待批命令卡、评审卡、验收卡 | `client.js` | 对应卡片与按钮出现 | 面板错误条 |

输入清单

| 输入 | 生产代码里的写入方 | 现状 |
|---|---|---|
| feature 的 `verify` 命令 | 初始化会话写 features.json（冻结前） | 已有 |
| SPEC/PLAN | 初始化/规划会话 | 已有 |
| `baseCommit` | `engine.js` 的 `beginChain` | 本期补 |
| 人工批准、裁决、验收 | 面板 Remote | 本期补 |

实跑剧本（给不了解实现的人）：见文末「实跑记录」，交付时填写。

## 4. 已知限制

- **插件验证运行本身是沙箱外执行**（待需求方拍板，见第 7 节）：人批准的是命令字符串（如 `npm test`），不是它实际跑的代码。模型可以在沙箱里改测试文件或 `package.json` 的脚本，让被批准的命令在 Host 进程里去改 `~/.dsh` 下的封存、宿主审计或 profile 配置。所以封存挡得住「直接改真理源文件」，挡不住「借验证命令执行任意代码」。
- 会话是完全访问权限时，它也能直接改 `~/.dsh` 下的封存文件；防完全访问只能靠沙箱。
- 在工作区里 `git checkout` / `stash` / `reset` 到旧提交，或仓库级格式化（`prettier --write .`）改到 `.relay/*/PLAN.md`，都会被当成篡改，需要人裁决。这是有意的取舍，见裁定台账。
- 评审会话的结论仍是模型判断，独立上下文只是减少自我放水；最终由人工终验兜底。
- 计划模式是否真的禁止评审会话写文件取决于 DSH 的计划模式实现；没有计划模式服务时只靠提示词。
- 不可用命令验证的 feature（纯视觉、人工评审）需要把 `pluginVerify` 关掉或写一条能跑的检查脚本。

## 5. 裁定台账（按推荐）

格式：决定 — 理由 — 错了的代价

- 封存比对规范化内容而不是原始字节 — git 换行转换不该触发篡改 — 极端情况下只改空白的篡改不被发现，无害。
- 篡改后读取返回封存版本、磁盘保持原样 — 引擎按可信状态判断，同时保留证据给人看 — 人恢复前工作区和面板显示的内容不一致，面板已标红说明。
- 篡改后阻断该链全部工作区写入（含 PROGRESS/HANDOFF） — 避免在被污染的状态上继续推进 — 链在人裁决前完全停住。
- 冻结时打回未经插件验证的 passes — 治「冻结前预置完成」 — 迁移进来的老链里本来正确的 pass 要重跑一次。
- 验证命令需人工审批 — 插件在沙箱外执行模型写的命令 — 每条链开工后要人点一次批准，不批准就不能标通过。
- finish 重跑全部 feature 命令（去重）而不是只跑 verifyFull — 治「通过后又被改坏」 — finish 变慢，耗时等于去重后的命令总耗时。
- 重跑失败的 feature 自动重开 — 失败就是没通过，保持真理源诚实 — 偶发失败（flaky）会重开一个其实没问题的 feature，重跑即可。
- 评审轮数上限 3 — 防止评审和实现来回烧钱 — 第 4 轮需要人介入。
- Host 不能建会话时跳过评审进入待验收并明确标注 — 不让链永远无法结束 — 这类 Host 上设计核验只剩人工。
- 宿主侧审计为准、工作区 audit.jsonl 继续写 — 工作区那份给 git 和人看，宿主侧那份防删改 — 两份内容可能不同，以宿主侧为准。
- 不改 `coverage` 缺省为 full 的规则 — 有封存和插件验证后，coverage 只影响要不要人签字，不再是能否完成的唯一依据 — 初始化会话漏写 coverage 时会少一次人工签字。
- 冻结时打回所有不是本次 checkpoint 亲自跑出的 `verification`，并清掉所有 `acceptedBy` — 冻结前文件可以随便写，里面的验证记录和签字都可能是伪造的 — 冻结前在面板点过的「接受」要重新点一次。
- 只有人能取消评审，取消和没启动成功的评审不计入轮数 — 否则链头可以靠「取消 → 重新 finish」把轮数耗完、绕过评审 — 评审会话真卡住时人得手动处理。
- 封存的 truthDir 比对在 Windows 上不区分大小写；原位置还在时，其他目录里的同 id 副本一律不认 — 堵住「换个写法 / 复制一份目录」绕过比对 — 同一工作区用两种写法的路径打开时只认封存时那一个。
- 冻结时 PLAN.md / SPEC.md 不存在也封存为「不存在」 — 单任务链默认没有 SPEC，事后补写一份等于改设计 — 初始化会话冻结后再想补 SPEC 要人采纳。
- 评审提示词把 decisions.md 当作实现方的记录而不是设计，记在里面的偏差照样判 mismatch — decisions.md 不封存，实现方可以事后补理由 — 有些有意的偏差会多一轮人工判断。
- 验证命令以退出事件为准，输出管道最多再等 1 秒，并设 `超时 + 10 秒` 的兜底 — 测试拉起的后台进程会一直占着输出管道，原来会把通过判成超时，甚至让这条链的验证队列永远卡住 — 退出后 1 秒内没写完的输出尾部会丢。

## 6. 实跑记录

2026-11-24，提交 `eb46a7b`，Windows 11 本机，Node 24.14.1，执行者：实现方（不是独立代理）。

| 环 | 状态 | 说明 |
|---|---|---|
| 1 入口（工具 / 面板接口） | 替身实跑 | `test/smoke.mjs` 通过真实的 `registerTools` 和 `RelayRemote` 调用；DSH 会话、建会话服务、goal 服务是替身 |
| 2 门禁 | 替身实跑 | 封存比对用真实文件系统；验证命令是真实的子进程（`node -e ...`），含超时、孤儿进程 |
| 3 落盘 | 替身实跑 | 真实写 `relay.json` / `features.json` / 封存 / 宿主审计，宿主目录指向临时目录 |
| 4 评审 | 替身实跑 | 评审会话由替身 `sessionController` 建；提示词内容、`relay_review` 的判定和状态迁移是真实代码 |
| 5 用户可见（面板） | 仅单测 | `test/hooks-render.mjs` 用假 React 渲染卡片并检查按钮接线；没在真实 DSH 面板里看过 |

现跑命令（插件目录下）：`node test/smoke.mjs && node test/hooks-render.mjs && node test/client-boot.mjs`。

未做：在真实 DSH 里安装插件，让真实模型会话跑一条链（建链 → 改文件被拦 → 插件验证 → 评审 → 面板确认）。需要改 profile 并消耗模型调用，等需求方授权。

## 7. 待需求方决定

验证命令在 Host 进程里执行、不受会话沙箱约束（第 4 节第 1 条）。可选：

1. 接受现状并写进文档：门禁防的是「改文件 / 自报完成」，不防「借测试执行任意代码」。成本为零。
2. 改为让验证命令在会话自己的沙箱里执行（通过 DSH 的作业或 shell 服务），插件只读取退出码。最彻底，但要先查 DSH 有没有可供插件调用、能拿到退出码的沙箱执行接口；本仓库里没有 DSH 源码，没法确认。
3. 折中：验证子进程去掉 `DSH_HOME` 等环境变量，封存文件改成只追加的哈希链并加宿主侧签名。能提高门槛，但同一用户身份下的代码仍然能改任何文件，挡不住有意的攻击。

## 8. 残留（已登记，未修）

- `market/index.json` 没有登记 1.6.0 / 1.6.1：登记需要发布提交的完整哈希，属于发版动作，等需求方确认。

已修（原残留）：篡改时暂停链上所有已加载会话的 goal（含集群 worker），暂停记录存进宿主侧封存，重载后裁决仍会恢复；回收站里的链在原位置被重建时不当作活链读出。

### 1.6.1 修的边界（复审 1.6.0 实现时发现）

- `engine.verifyFeatures` 的 `saveVerifyDrafts`：补 verify 与标 passes 同一次调用时先把新命令写进 features.json，否则面板列不出待批命令、checkpoint 永远 `verify_unapproved`；改一条已有命令改为明确拒绝（`verify_locked`），不再谎称「已记录」。
- `chain-store.writeSealed`：写工作区后刷新封存失败时回滚到写入前内容并抛 `truth_io_failed`，避免插件自己的合法写入被下一次读判成篡改；`writeChain` 的建目录失败也包成 RelayError。
- `engine.reclaimDelegation` / `acceptCoverage` / `acceptCoverageMany` / `recordBlocker`：`reviewing` / `awaiting_acceptance` 期间拒绝改列表、改覆盖签字、把链暂停。
- `engine.finishVerified` 的 `finishingChains`：finish 跑命令期间拒绝交接（`handoffNow` / `handoff`）、暂停（`setPaused`）、第二个 finish，`evaluate` 也不再动这条链；面板从 status 的 `finishing` 标志禁用按钮。
- `engine.freezeFeatures`：宿主指纹丢失时从封存重建（`restoreFingerprintFromSeal`），不再把所有已通过功能打回。
- `engine.evaluate` / `completeChainGoal`：`reviewing` / `awaiting_acceptance` 补暂停链头 goal，`done` 补完成 goal（head 会话晚加载的路径）。
- 提示词：wrap-up / handoff 不再引导模型手改已封存的真理源；worker 报告通知的 JSDoc 与实现对齐。
- `relay_status` 紧凑投影补 `tamper`、`review`、`commandsPending`、`finishing`；面板在 `reviewing` / `awaiting_acceptance` / 正在结束时禁用会失败的按钮；`paused(review-failed)` 进「需要你处理」。
