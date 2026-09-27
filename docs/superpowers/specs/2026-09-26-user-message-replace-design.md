# 给 agent 留言换资源 · 设计（2026-09-26）

> 状态：2026-09-26 按代码现状修订（待换改为独立表、新 run 类型 `replace_request`）。UI 设计经用户在 visual companion 里逐版确认（v1 → v2 → +④ 排队 → 配色修订），最终稿 `.superpowers/brainstorm/64860-1790419990/content/message-v5.html`。
> 背景：用户拿到的资源有问题时没有办法告诉 agent。123 盘的《耳语人》色调发蓝，115 盘的《奥德赛》是山寨公司拍的同名假片。删掉重新获取，agent 多半又会转回同一份。需要求往往很具体（换第 13、24 集；换分散在几季里的几集），做成表单穷举不完，所以用一句自然语言留言。

## 1. 目标与非目标

**目标**
- G1 用户在作品详情页（某块盘上的某部作品）给 agent 留一句话，指出哪几集或整部电影要换，以及为什么。
- G2 留言在 agent 开工前可以修改、撤回；默认等下次巡检处理，也可以「现在处理」立刻排队。
- G3 agent 读到留言，找一个**不同的**资源来替换。系统保证被拒的那份不会再转回来，换个链接分享的同一份也不行。
- G4 没换成的集标为「待换」（格子变红），之后每次巡检接着找，直到换成或用户点「不换了」。
- G5 处理结果以逐集回复写回留言下方：换好的用了哪个资源、多大；没换成的原因；旧文件路径。
- G6 处理中可以继续留言，新留言排队，这次结束后立刻接着处理。

**非目标**
- **旧文件不删。** 用户自己删（用户拍板：为了拿到新片，占点空间可以接受）。agent 的删除权限不扩大。
- 不做 agent 与用户的多轮对话。agent 只回复，不提问；用户有补充就再留一条。
- 不解析留言里的集数。集数由 agent 语义判断，UI 的「选集数」标签只是帮用户写得更清楚。
- 电影系列、多季批量等既有模型不变（见 AGENTS.md「有意设计」）。

## 2. 数据模型

新增一个存储端口 `UserRequestStore`（`packages/workflow/src/user-requests.ts`），`WorkflowRepository` 继承它，三套仓库各实现一份，共用契约测试。四张表：

### 2.1 `user_messages`

| 列 | 说明 |
|---|---|
| `id` | text PK，`msg_<uuid>` |
| `account_id` | text |
| `drive` | text NOT NULL，connected_storage_id，没有时存 `''` |
| `title_key` | text，等于 media title id（`tmdb_tv_283428` / `tmdb_movie_238`） |
| `body` | 用户原话，1–500 字 |
| `episode_tags` | JSON 文本，`["S01E13","S01E24"]`，可为空数组。只是提示 |
| `status` | `pending` / `processing` / `done` / `withdrawn` |
| `urgent` | bool。true = 不等巡检，队列空闲就处理（§3） |
| `run_id` | 处理它的 run，processing 起写入 |
| `reply` | JSON（§4.3），done 时写入；同一个 run 认领的几条留言写同一份 |
| `created_at` / `updated_at` / `processed_at` | ISO 文本 |

规则（存储层原子执行）：
- 只有 `pending` 能改、能撤回（条件更新 `WHERE status='pending'`，返回是否成功）。
- `claimUserMessages(scope, runId)`：把该作品该盘所有 `pending` 一次改成 `processing` 并写 `run_id`，返回认领到的。之后才写的留言留给下一轮。
- 发留言时，同一作品同一盘已有 `processing` 的留言 → 新留言 `urgent=true`（处理中追加，§5）。
- `releaseUserMessages(runId)`：run 失败时 `processing` 退回 `pending`，urgent 置 true（下次队列空闲就重试）。
- `finishUserMessages(runId, reply)`：`processing` → `done`，写 reply。

### 2.2 `pending_replacements`（「待换」）

**不放在 `EpisodeState` 上**：每次持久化都会用 `createEpisodeStates` 重建集状态，字段会被冲掉。

| 列 | 说明 |
|---|---|
| `account_id`, `drive`, `title_key`, `episode_code` | 复合主键；电影用 `MOVIE` |
| `message_id`, `requested_at` | |

- agent 汇报 `not_found` → 写入；`replaced` → 删除；用户「不换了」→ 删除。
- 集的 `obtained` 不变（文件在），进度条照算已获取。UI 看到这张表里有它就画成红色「待换」。

### 2.3 `rejected_resources`（拒绝名单）

| 列 | 说明 |
|---|---|
| `id` | PK |
| `account_id`, `title_key` | 作用域：**账号 + 作品**，不按盘分（假片在哪块盘都是假的） |
| `episode_code` | 被拒的是哪一集的来源；电影 `MOVIE` |
| `link_key` | `deadLinkKey(url)`，知道时才有 |
| `label` | 资源名 / 文件名（给 agent 看、给指纹用） |
| `size_bytes` | 知道时才有 |
| `reason` | 用户原话摘要 |
| `message_id`, `created_at` | |

过滤（`RealResourceProviderV2.search`，与死链过滤同一处，每次搜索重新读，本轮刚拒的立刻生效）：
- `link_key` 相同 → 剔除。
- 指纹：候选标题里带大小（PanSou 常见的 `[2.3G]`），且与某条拒绝记录大小相差 ≤2%，且两边标题规范化后相同（去掉方括号内容、扩展名、分辨率/编码词、标点空白、小写）→ 剔除。
- 其余哪怕看着像也不剔，交给 agent：拒绝名单原文会注入提示词。机械规则只做确定的事。

### 2.4 `episode_sources`（换上去的是哪份）

| 列 | 说明 |
|---|---|
| `account_id`, `drive`, `title_key`, `episode_code` | 复合主键 |
| `link_key`, `label`, `size_bytes`, `run_id`, `recorded_at` | |

只在 agent 汇报 `replaced` 时写（它指明是哪个候选，系统核对该候选本轮确实转存成功）。用处：同一集第二次被投诉时，拒绝名单能带上精确的 `link_key`。普通获取不写（设计上不做 文件↔集 的机械映射，§1.13）。第一次投诉的集没有来源记录，agent 用 `inspectTargetDir` 看到的真实文件（名字 + 大小）来拒，系统按 fileId 核对文件确实在目标目录里。

## 3. 触发与调度

所有留言处理走同一条路：**新的 run 类型 `replace_request`**（可被队列认领）。它覆盖这部作品在这块盘上**所有已追踪的季**，并加作品级互斥锁（`blockIfTitleHasActiveRun`），因为留言针对整部作品、可能跨季，而巡检是逐季跑、不锁整部作品。

入队的三个来源：
1. **巡检**：`patrolTrackedState` / `patrolMovie` 发现这部作品有 `pending` 留言或有待换集 → 入队 `replace_request`（已有活动 run 则跳过），并跳过这部作品各季本轮的普通巡检（`replace_request` 的需要集合本来就包含缺集）。
2. **「现在处理」**：该作品的 pending 留言置 `urgent=true`，尝试入队。
3. **队列空闲扫描**：`runNextQueuedWorkflow` 每次开头调用 `enqueueUrgentReplaceRequests`，给有 `urgent` pending 留言、当前没有活动 run 的作品入队。这一处同时覆盖「点现在处理时正好有别的 run 在跑」「处理中追加的留言」「失败重试」。

默认（非 urgent）的留言只由巡检入队，所以「默认等下次巡检」成立。

## 4. agent 侧

### 4.1 输入
- 需要集合 = 缺集 ∪ 待换集 ∪ 留言选集标签。`workflow-v2` 的「没有缺集就不跑 agent」短路在有留言或待换集时不生效。
- 提示词新增 `<user_requests>` 围栏段（不可信数据，同记忆的做法）：每条留言原话 + 选集标签 + 时间；拒绝名单原文；规则：
  - 目标是换成**与现在不同**的资源；同一发布组同一版本不算换。
  - 新文件放进同一季目录；**不删、不改名已有文件**，也不要按「保留较大的」去重掉旧文件。
  - 先 `inspectTargetDir` 看这些集现在的文件，再 `rejectCurrentSource`，然后再搜。
  - 结束前必须 `reportReplacement`。

### 4.2 新工具（只在有留言或待换集的 run 里注册）
- `rejectCurrentSource({ episodes, fileIds, reason })`：
  - 只接受 run 开工前就在目标目录里的文件；集号按本轮的季校验（电影只有 `MOVIE`）。系统用文件名 + 大小（以及 `episode_sources` 里已知的 link_key）写拒绝名单，文件原地不动。
  - 某集库里根本没有旧文件时，传该集 + `fileIds: []`：不写拒绝记录，只算这集「已处理」。
  - 把这些集加进本轮需要集合（留言没带标签、agent 从原话里读出来的集也能走完转存闸门）。
- **先拒再转**：每个请求集都被拒过（或声明没有旧文件）之前，`transferCandidate` / `transferUntilLanded` 一律拒绝。只有「待换复查」（本轮没有新留言、这集已有存量拒绝记录）可以免拒；开工前目标目录完全没有文件时也放行。
- `reportReplacement({ results: [{ episode, outcome: "replaced" | "not_found", candidateId?, fileIds?, note }] })`：
  - `replaced` 必须满足：该集本轮 `markObtained` 过；`candidateId` 本轮转存成功过；`fileIds` 指名这集自己的新视频文件（字幕可以一起报，只报字幕不算），且每个文件都是本轮由这个候选下载的、并且一个文件只能算一集。文件判断归 agent，系统只核对事实，不解析文件名。汇报时系统现场列一次目标目录：指名的文件有不在的（还在暂存，或移进去后又删了；电视剧要 `moveToSeason` 移进季目录）→ 这集记为 `not_found`（移进去后再报可升级）；在的文件里一个视频都没有，或其它不符 → 工具报错给 agent，整批不记录。
  - 系统删掉待换记录，写 `episode_sources`（先写来源、成功后再删待换，写失败待换保留）。
  - `not_found`：写待换记录。
  - 留言涉及、agent 却没汇报的集（选集标签或待换集），run 结束时系统按 `not_found` 处理。所有请求集汇报完之前，agent 的 `finish` 会被拒。剧集留言没带集数标签时，agent 要先从原话里认出是哪几集并对它们 `rejectCurrentSource`（库里没有旧文件的传 `fileIds: []`），本轮一次都没调过之前 `finish` 同样被拒——已有的待换集、别的留言带的标签都不算认出。
- **旧文件保护**：replace run 开始时系统记下各目标目录现有的文件（列目录失败就让 run 失败）；本轮删除、移动、重命名、flatten 都不能碰这些文件。
- **覆盖按集算**：请求集只有被报为 `replaced` 之后才算覆盖，也只有这时才作为本轮获取写回库；补到别的缺集不会让它「顺带满足」。只被标记、最后报 `not_found` 的请求集不会变成已获取（原本就已获取的照旧保持）。

### 4.3 回复
`reply = { results: [{ episode, outcome, label?, sizeBytes?, note }], oldFiles: [path], runId }`。系统用 `reportReplacement` + 转存记录 + `rejectCurrentSource` 时记下的旧文件路径组装；agent 只给 `note`。run 正常结束（含没换成）→ `finishUserMessages`；run 抛错 → `releaseUserMessages`。剧集留言没带集数标签、本轮一集都没认出来时，回复带 `unidentified: true`，这条留言不写待换（`results` 里可能还有待换集的结果），UI 请用户选好集数再发；留言照样 done，不退回重跑（重跑还是认不出来）。

### 4.4 复盘（记忆）
复盘照旧。事实摘要加一行「本轮处理了用户留言，结果：…」；复盘提示词加一句：用户拒掉的资源系统已经记住，不用写成笔记。

### 4.5 电影
- `need=["MOVIE"]`，电影目录就是暂存区，新文件和旧文件在同一目录，不删旧的。
- 电影 replace run 无论换没换成，作品都保持已获取（旧文件还在）。

## 5. 处理中又留言（排队）

- 认领只认领当时的 pending。之后的新留言保持 pending 且 `urgent=true`，UI 标「排队中 · 这次处理完接着处理」，照样能改、能撤回。
- 这次结束后，下一次队列空闲扫描（§3.3）发现它，立刻入队，不等巡检。
- 同一部作品同一时间只跑一个 run：`blockIfTitleHasActiveRun`。
- 后一条推翻前一条（「E13 其实不用换了」）：不打断当前 run。第二轮 agent 读到时 E13 可能已换好，回复里如实说明「已经换过，新旧两个文件都在」。

## 6. UI（详情页）

按最终设计稿实现，要点：
- 位置：季进度下面、agent 笔记上面，单独一个 `.thread` 卡片。
- 平时：胶囊输入框（Spotify 搜索栏 DNA）+ 绿色圆形发送钮。
- 写留言：展开成多行；下方常用说法 chip（画面偏色 / 假片 / 没有中字 / 画质太差 / 音画不同步）点一下填入；「选集数」开启后，上方集数格子可点选，**选中态用蓝色（`--info`）底和边**，留言里生成**绿色**集数标签。
- 等巡检：橙色「等巡检 · 明早 HH:MM」（取下一个巡检时间点）、修改、撤回、**绿色**「现在处理」。
- 处理中：锁定；agent 行显示跳动音柱 + 实时活动文字（复用 `workflow_runs.progress`，同活动页）。
- 处理完：逐集列表（集 / 这次用的资源 / 大小 / 结果）；没换成的行 hover（触屏常显）出现「不换了」；旧文件路径 + 复制（按钮文字变「已复制」，不弹 toast）。
- 待换：集格子红底红框 + 右上角红点，文字「待换」；标题徽章「N 集待换」/电影「待换资源」+ 红底提示条带「不换了」。
- 「不换了」：乐观更新，底部白色 toast 6 秒撤销（沿用笔记删除的延迟提交做法），提交时删掉该集的待换记录。
- 更早的留言折叠为「之前的留言 · N 条」。
- 移动端：列表收成两行，旧文件路径换行显示。

文案走 humanizer-zh + sepia，实现时再过一遍。

## 7. 错误处理

- run 抛错：留言退回 `pending`（urgent），UI 显示「排队中 · 马上处理」，队列空闲时自动重试。模型中断（content-filter）或预算耗尽但 run 正常收尾时，留言照常 done，没汇报的集按 `not_found` 进待换。都不会把集误标为「换好了」。
- 拒绝名单写失败：本轮继续，但回复里说明（尽力而为，不能让留言功能拖垮获取）。
- 盘被冻结（鉴权失效）：留言保持 `pending`，沿用现有冻结提示。
- 作品取消追踪：该作品的 `pending` 留言一并撤回；`episode_sources` / 拒绝名单保留（重新追踪时还用得上）。

## 8. 测试

- 三套仓库契约测试：留言状态机（改/撤回只在 pending、认领原子、失败回退）、`episode_sources` 覆盖、拒绝名单查询。
- 过滤：精确键剔除、指纹（标题+大小）剔除、只有标题相似不剔。
- 巡检：已全部入库但有 pending 留言 / 待换集的作品会被唤起；没有的照旧跳过。
- 排队：处理中追加的留言为 urgent，队列空闲扫描自动入队；同作品不并发。
- 旧文件保护：replace run 里删除开工前已在目标目录的文件被拒。
- `reportReplacement` 核对：未转存新东西的 `replaced` 被拒；未汇报的集按 `not_found`。
- UI：`build:web`；组件测试覆盖 pending/processing/done/待换/不换了+撤销。
- **端到端（生产）**：用黄泉的使者（123）留言换 E13、E24，走「现在处理」，确认新文件落盘、旧文件未动、回复与格子状态正确；奥德赛（115）留「假片」，确认拒绝名单生效、之后巡检不会再转同一份。

## 9. 分期

两个 PR：
1. **引擎 + 数据层**：四张表与契约测试、`replace_request` run、拒绝名单过滤、两个新工具、旧文件保护、提示词、巡检唤起与队列扫描。没有 UI 入口时它是惰性的（没人能发留言）。
2. **UI**：详情页留言卡片、选集、待换状态、不换了、现在处理。

之后生产端到端验证。

## 10. 评审中补上的约束（PR #279，2026-09-27）

实现过程中的代码审查和 Copilot 评审补了下面这些规则，和上文冲突时以这里为准：
- **拒绝名单对所有 run 生效**，不只换源 run：搜索结果过滤 + 转存时再查一次（按账号 + 作品）。读名单失败按空名单继续。死链名单不一样：读失败时这次搜索直接报错，已知死链不能因为一次读失败又露出来、被再转一遍。
- **普通 run 也保护换过源的作品**：作品有 `episode_sources` 记录时，之后的普通巡检开工前同样记下目标目录里已有的文件并禁止删除/移动，避免「保留较大的」去重删掉用户想留的那份。读来源记录失败时照样开保护（不点名集数）。
- **作品级互斥也管巡检**：巡检的预留带 `blockIfTitleHasActiveKinds: ["replace_request"]`；Postgres 在同一把 advisory lock 下判断，两个并发预留只会成功一个。
- **崩溃与取消**：同一 run 重新认领时收回自己的留言；run 被判失败或取消时释放留言（非紧急，交给巡检，避免 3 秒一轮空转）；处理中的留言在 run 结束 10 分钟后仍无人认领就放回 pending。取消排队中的换源 run 不会拆掉作品的追踪。
- **记账失败不丢请求**：写来源 / 待换失败会重试一次；再失败就把留言退回 pending，不写回复。
- **待换作品照样发现新集**：换源 run 开跑前先同步 TMDB（巡检会跳过有待换集的作品，只能在这里补）。
- **通知**：巡检触发的换源 run 进每日汇总；只有「什么都没换成、也没补到新集」才算例行不推送。
- **取消追踪**：整部取消时撤回 pending 留言、删待换记录；只取消一季时只删该季的待换记录。来源和拒绝名单保留。
- **未绑盘作品**：Postgres 读追踪季时把 `__unscoped__` 映射回 `null`，留言用 `""` 作为盘键，两边才能对上。
