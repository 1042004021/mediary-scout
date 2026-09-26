# 给 agent 留言换资源 · 设计（2026-09-26）

> 状态：UI 设计经用户在 visual companion 里逐版确认（v1 → v2 → +④ 排队 → 配色修订），最终稿 `.superpowers/brainstorm/64860-1790419990/content/message-v5.html`。
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

### 2.1 新表 `user_messages`（三套仓库各一份，共用契约测试）

| 列 | 说明 |
|---|---|
| `id` | text PK，`msg_<uuid>` |
| `account_id` | text |
| `connected_storage_id` | text，可空（同 tracked_seasons 的语义） |
| `title_key` | text，`tmdb_<mediaType>_<tmdbId>`，复用 `requireMemoryTitleKey` |
| `body` | 用户原话，≤ 500 字 |
| `episode_tags` | text[]/JSON，UI「选集数」生成的 `S01E13` 这类标签，可空。只是提示，agent 以原话为准 |
| `status` | `pending` / `processing` / `done` / `withdrawn` |
| `run_id` | 处理它的 workflow run，processing 起写入 |
| `reply` | JSON，agent 的逐集回复（§4.3），done 时写入 |
| `created_at` / `updated_at` / `processed_at` | ISO 文本 |

规则：
- 只有 `pending` 能改、能撤回。改或撤回用条件更新（`WHERE status='pending'`），与认领竞争时认领赢，UI 收到「已开始处理」。
- 认领：run 开工时把同一 `(account, drive, title_key)` 下所有 `pending` 原子改为 `processing` 并写 `run_id`。开工之后才写的留言保持 `pending`，留给下一轮（§5）。
- run 失败或被取消时，`processing` 退回 `pending`，不丢留言。

### 2.2 集状态新增「待换」

`EpisodeState` 新增可选字段 `replaceRequested?: { messageId: string; requestedAt: string }`。

- `obtained` 仍为 `true`：文件确实在，进度条照算已获取（24/24）。
- 有 `replaceRequested` 的集进入巡检的「需要」集合（§3.3），UI 渲染为红色「待换」。
- 电影同样用它的单集锚点（`MOVIE`）承载，标题显示「待换资源」。
- 「不换了」清除该字段；「换好了」由 agent 在处理后清除（§4.2）。

### 2.3 资源来源记录 `episode_sources`（不会被 30 天清理）

运行记录和转存记录会被 30 天回收（`pruneFinishedWorkflowRuns`），不能靠它们知道「上次拿的是哪个」。新增一张小表，按集记录当前落在库里的资源：

| 列 | 说明 |
|---|---|
| `account_id`, `connected_storage_id`, `title_key`, `episode_code` | 复合键 |
| `resource_title` | 候选标题（例如 `[喵萌奶茶屋] 黄泉的使者 13 [1080p]`） |
| `size_bytes` | 落盘文件大小 |
| `link_key` | `deadLinkKey(url)` 的结果（115 分享码 / 磁力 infohash / …），可空 |
| `file_path` | 在库里的相对路径（给回复里「旧文件还在」用） |
| `recorded_at`, `run_id` | |

写入时机：`markObtained` 成功后，orchestrator 用本次转存记录 + 该集落盘文件回填。同一集换了新资源就覆盖（旧那条进 §2.4 的拒绝名单，不丢）。存量没有来源记录的集，第一次处理留言时由 agent 读 `inspectTargetDir` 看文件名，照样能工作，只是指纹只有文件名和大小。

### 2.4 拒绝名单 `rejected_resources`

用户说「这份不行」之后，这份资源进这部作品的拒绝名单，**由系统在搜索结果交给 agent 之前剔掉**（与现在的死链过滤同一处，`RealResourceProviderV2.search`）。

| 列 | 说明 |
|---|---|
| `account_id`, `title_key`, `episode_code`（可空=整部） | 作用域 |
| `link_key` | 精确键：同一个链接 |
| `fingerprint` | 模糊键：规范化标题 + 大小，识别「换个链接分享的同一份」 |
| `reason` | 用户原话摘要 |
| `message_id`, `created_at` | |

- **精确键**命中直接剔除，不进 agent 视野。
- **指纹**：`normalizeTitle(resource_title)`（去掉括号里的发布组 / 画质 / 分辨率 / 空白）+ 大小 ±1%。大小只有在候选标题里带大小时可用（PanSou 标题常带 `[2.3G]`）；带大小的候选指纹命中才剔除，只能靠标题判断的不剔，交给 agent（§4.1 会把拒绝名单原文给它看）。机械规则只做确定的事，模糊的留给 agent（`agent-node-design-principles`）。
- 拒绝名单按**账号 + 作品**共享，不按盘隔离：同一份假片在 115 和 123 上都是假的。（来源记录 §2.3 则按盘，因为文件落在具体某块盘上。）

## 3. 触发与调度

### 3.1 留言入口
- 服务端 action：`postUserMessage` / `editUserMessage` / `withdrawUserMessage` / `processMessageNow` / `keepEpisodeAsIs`，全部走 `requireAuthenticatedAccountId` + `assertNotDemo`，参数里的作品与盘必须属于当前账号。

### 3.2 「现在处理」
- 为这部作品在这块盘上入队一个 run（电视剧 `type3_monitor`，电影 `movie_init`），和手动获取同一条队列、同一个认领逻辑。已有进行中的 run 时不重复入队，UI 显示「排队中」（§5）。

### 3.3 巡检
- 现在巡检会跳过「已全部入库」的季和已获取的电影（`patrolTrackedState` / `patrolMovie`）。改为：**有 `pending` 留言或有 `replaceRequested` 集的作品也要跑**。
- 需要集合 = 缺集 ∪ 待换集 ∪ 留言涉及的集（后者由 agent 判定，系统只负责把作品唤起）。
- `syncSeasonNeed` 保持纯计算，新增 `replaceRequested` 输入：待换集进入 `missing` 之外单独的 `toReplace` 列表，传给 agent 的目标里分开写，提示词里说清楚两者的区别（缺的是没有文件，待换的是有文件但用户不满意）。
- 巡检并行（#276）按盘分键的规则不变。

## 4. agent 侧

### 4.1 输入
提示词新增一段 `USER REQUESTS`（放在 `<user_requests>` 围栏里，按不可信数据处理，同记忆的 `fenceRunFacts` 做法）：
- 每条待处理留言：原话、选集标签、时间。
- 每个涉及集的当前来源（§2.3）：资源标题、大小、文件路径。没有记录就写「未记录，请用 inspectTargetDir 看文件名」。
- 这部作品的拒绝名单原文。
- 规则：
  - 目标是**找一个与当前来源不同的资源**替换留言点名的集。换成同一个发布组的同一版本不算换。
  - 新文件落到同一季目录，**不删旧文件、不改旧文件名**。
  - 用户说的是「这部是假片」一类整部否定时，把当前来源整份报告为拒绝。

### 4.2 新工具
- `rejectCurrentSource({ episodes, reason })`：把这些集的当前来源写进拒绝名单。agent 读懂留言后第一步调用，之后本轮搜索立即生效。
- `reportReplacement({ results: [{ episode, outcome: "replaced" | "not_found", note }] })`：结束前逐集汇报。
  - `replaced`：必须是本轮 `markObtained` 过、且确有新转存落盘的集，系统核对，不符合就拒。系统清掉该集 `replaceRequested`，覆盖 `episode_sources`。
  - `not_found`：系统给该集打上 `replaceRequested`（若还没有）。
- 留言涉及但 agent 没汇报的集，系统按 `not_found` 处理，不能静默丢。

「换好了」必须由 agent 判定，但系统要核对它确实转存了新东西（`no-mechanical-mark-coverage`：判定归 agent，事实核对归系统）。

### 4.3 回复
`reply` = `{ results: [{ episode, outcome, resourceTitle?, sizeBytes?, note }], oldFiles: [path], summary }`。由系统从 `reportReplacement` + 本轮转存记录 + `episode_sources` 旧值组装，agent 只提供 `note`（一句中文，说为什么没换成之类）。UI 把它渲染成逐集列表。

### 4.4 复盘（记忆）
复盘轮照旧跑。事实摘要里加「本轮处理了用户留言：…」，提示词加一句：用户拒掉的资源已由系统记住，不用再写成笔记。

## 5. 处理中又留言（排队）

- 认领时只认领当时的 `pending`。之后的新留言保持 `pending`，UI 标「排队中 · 这次处理完接着处理」，照样能改、能撤回。
- run 结束（任何结局）后，worker 检查这部作品在这块盘上还有没有 `pending` 留言，有就立刻为它入队一个新 run，不等下次巡检。
- 同一部作品同一时间只跑一个 run：现有 `reserveWorkflowRun` 的「已有活动 run 则 skipped_active」保证。
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
- 「不换了」：乐观更新，底部白色 toast 6 秒撤销（沿用笔记删除的延迟提交做法）。
- 更早的留言折叠为「之前的留言 · N 条」。
- 移动端：列表收成两行，旧文件路径换行显示。

文案走 humanizer-zh + sepia，实现时再过一遍。

## 7. 错误处理

- run 失败 / 模型中断（content-filter）/ 预算耗尽：留言退回 `pending`，UI 显示「上次没处理完，下次巡检会再试」；不会把集误标为「换好了」。
- 拒绝名单写失败：本轮继续，但回复里说明（尽力而为，不能让留言功能拖垮获取）。
- 盘被冻结（鉴权失效）：留言保持 `pending`，沿用现有冻结提示。
- 作品取消追踪：该作品的 `pending` 留言一并撤回；`episode_sources` / 拒绝名单保留（重新追踪时还用得上）。

## 8. 测试

- 三套仓库契约测试：留言状态机（改/撤回只在 pending、认领原子、失败回退）、`episode_sources` 覆盖、拒绝名单查询。
- 过滤：精确键剔除、指纹（标题+大小）剔除、只有标题相似不剔。
- 巡检：已全部入库但有 pending 留言 / 待换集的作品会被唤起；没有的照旧跳过。
- 排队：run 结束后自动入队下一条；同作品不并发。
- `reportReplacement` 核对：未转存新东西的 `replaced` 被拒；未汇报的集按 `not_found`。
- UI：`build:web`；组件测试覆盖 pending/processing/done/待换/不换了+撤销。
- **端到端（生产）**：用黄泉的使者（123）留言换 E13、E24，走「现在处理」，确认新文件落盘、旧文件未动、回复与格子状态正确；奥德赛（115）留「假片」，确认拒绝名单生效、之后巡检不会再转同一份。

## 9. 分期

一个功能、一个 spec，按依赖分成若干 PR：
1. 数据层：三张表 + `EpisodeState.replaceRequested` + 契约测试。
2. 引擎：拒绝名单过滤、来源记录回填、两个新工具、提示词、巡检唤起、排队续跑。
3. UI：详情页留言卡片、待换状态、不换了。
4. 生产端到端验证。
