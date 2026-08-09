# QQ 音乐评论查询专项记忆

本文件只维护当前已实现的 QQ 音乐领域事实、共享边界和安全不变量，不记录旧共享实现、浏览器验收或发布结论。QQ 代码改变身份、上游接口、分页、并发、代理、状态、结果或活动语义时，必须在同一修改阶段更新本文件并删除过时描述。

`docs/qq-music-integration-design.md` 仅保留历史迁移与设计决策；当前实现契约只以本文件、`qq-music-architecture.md`、源码和测试为准。不得把历史文档中的旧共享实现、版本基线或交付状态重新复制为当前事实。共享接线的当前事实只在文末专章维护。

本文件和本地测试只记录实现契约，不代表任何 commit、push、Release 或安装包已经存在；发布状态必须以 Git 与 GitHub Release 的实际记录为准。

显示品牌为“乐评寻踪 / MUSIC COMMENT TRACE”，`productName` 为“乐评寻踪”，但技术身份保持稳定：package name `ncm-comment-finder`、appId `cn.local.ncm.commentfinder`、仓库 `RocXOvO/ncm-comment-finder`、artifact stem `NCM-Comment-Finder`。`electron-main` 显式把 `userData` 固定到 `appData/ncm-comment-finder`；品牌改名不得迁移或分叉 QQ/网易云检查点、日志、结果和更新状态目录。

## 产品边界

- QQ 音乐是独立平台适配。它不复用网易云的时间游标、时间分片、source state、target-v3 JSONL 或歌曲覆盖账本。
- 当前任务只有 `song` 和 `likes`：指定一首 QQ 歌曲扫描，或发现公开“我喜欢”歌曲后跨歌曲扫描。
- 当前目标输入为数字 QQ 号、QQ 音乐个人主页 URL 或 `EncryptUin`；评论作者只按完整 `EncryptUin` 精确相等匹配。
- 当前不保存 QQ Cookie/musickey，不做扫码登录、私密喜欢列表、未经验证的公开听歌记录或同一歌曲多页并发。
- QQ CGI 不是稳定公开 SDK。常规测试必须使用 stub 或回环服务；未经用户明确要求，不做高频实网验证。

## 模块所有权

- `src/qq-music/**` 拥有 QQ Client、类型、SeqNo 扫描器、状态、结果 writer、QQ TransportGate、代理 fetch 和离线 benchmark；不得依赖 Server 或 DOM。
- `src/qq-cli.ts` 只组装 CLI 所需的 QQ 领域对象，不复制 Dashboard manager。
- QQ domain 当前复用 `atomic-file`、Governor、LaneRecovery、`worker-topology` 与 `LaneAllocator`，但保持自己的 SeqNo 分页、状态、TransportGate 和结果 writer；不得抽象出伪统一的分页/状态 Scanner。

## 身份、来源与上游接口

- 生产扫描 parser 与单次解码实验隔离：正式 start 的数字 QQ 或 URL 数字通过独立 8 秒本机直连辅助 Lane 解析为 canonical `EncryptUin`；直接 opaque EncryptUin 或 URL 中的 opaque EncryptUin 原样作为 canonical 值并保持本地零请求，不要求可被实验字符表反解。安全与实验细节见“EncryptUin / 官方主页单次解析实验”；实验结果绝不替换扫描 task key、generation、状态/结果路径或作者匹配条件。
- 评论读取使用 `music.globalComment.CommentRead.GetNewCommentList`。评论 `pageSize` 新任务范围为 `1..25`，默认 `25`。
- 公开喜欢歌曲使用 `music.srfDissInfo.DissInfo.CgiGetDiss` 的 offset 分页；`likedPageSize` 范围为 `1..500`，默认 `500`。它与评论页大小是两个独立参数。
- 歌曲详情使用 QQ 歌曲详情接口，只补充 MID、名称和艺人。Client 将十进制 ID 作为字符串 `song_id` 发送并以字符串规范化响应；Scanner 始终以原 `requestedSongId` 建立 song 任务，不能被响应 ID/MID 替换，也不能经 JavaScript `Number` 转换。
- 歌曲搜索优先使用 `music.search.SearchCgiService.DoSearchForQQMusicDesktop`。只有主响应结构完整且 `body.song.list` 合法为空时，才用同一 `fetch` 和取消 signal 回退到官方 `smartbox_new.fcg`；主列表非空但任意记录畸形时必须报协议错误，不能用回退掩盖。Dashboard 的歌名/数字歌曲查询强制使用一条 8 秒有界的本机直连 Lane，不读代理池或表单手动代理；前端同关键词单飞、缓存 60 秒且显示加载/失败状态。Smartbox 只取 `limit` 内的 `data.song.itemlist`，ID/MID 保持字符串，`singer` 规范化为单元素 artists 数组。该回退依据一次低频实网兼容性观察，常规验证仍只使用 stub。
- `zzcSign` 仅是为可能需要签名的请求准备的完整性 token，不提供加密；QRC 歌词 3DES 与评论查询无关。

## SeqNo 分页与完成语义

```text
page 0, cursor "" -> 本页最后 SeqNo A
page 1, cursor A  -> 本页最后 SeqNo B
page 2, cursor B  -> ...
```

- 输入 cursor、每条评论 SeqNo 和响应 `nextCursor` 都必须是十进制字符串。
- `HasMore=true` 必须有非空 `nextCursor`；从第二页起，新 cursor 必须严格小于请求 cursor。
- 下一 cursor 的唯一权威来源是响应原始顺序中最后一条规范化评论的 SeqNo。页内相等或局部乱序允许且全部保留；恢复页每一条 SeqNo 都必须老于请求 cursor。跨页边界不安全时只隔离当前歌曲，保持 cursor/pageNo 不动，likes 的其他歌曲继续。
- 同一歌曲最多一个在途评论页。并发只发生在不同歌曲之间；普通失败或 Lane 故障保留原 cursor，只有成功且协议完整的页才能推进 cursor/pageNo。
- `song` 始终只有一条活动 SeqNo 链，但成功页可以在健康 Lane 间公平轮转。增加出口是轮转和故障切换，不代表同曲并行。
- 只有明确的歌曲资源 HTTP `404/410` 才将该歌标记 `done + truncated`；QQ 协议、业务、结构或 cursor 错误使任务 `paused`，不得归一化为空页或完整覆盖。
- `coverageComplete` 只在来源完整且全部歌曲自然完成、没有来源错误或任意截断时成立。终态与完整覆盖必须分开表达。

## Worker、Lane 与限速

- 一条 `QQCommentLane` 拥有一个 Client、一个 Lane 专属 Governor，并引用任务唯一的 `QQMusicTransportGate`。
- 生产 Governor 的 `minDelayMs` 是同 Lane 相邻请求开始的真实最小间隔；Worker 不会除掉它。QQ 新任务默认 `300 ms + U[0,100) ms`，旧 QQ v2 自定义值原样保留。
- QQ Gate 按任务 profile 构建：song 固定 `1` 个在途，likes 总在途上限等于 `hostConcurrency`（范围 `1..32`），两者聚合开始间隔均为50ms。Gate 只额外延后，不能弱化单 Lane Governor；song 仍是一条 SeqNo 链。
- QQ likes 的唯一 GUI Worker 容量是 `hostConcurrency`；选定出口后 Manager 自动派生 `workersPerLane = ceil(hostConcurrency / selectedLanes)`，所以单出口也不会自动降为一个 Worker。QQ song 保留同一主机设置供展示/恢复，但运行时固定一个 Worker/SeqNo 链。
- Worker ID 是本次调用内的 `worker-N`，不绑定 Lane。每页通过共享 `LaneAllocator` 公平获取 Lane，单 Lane permit 不超过 `workersPerLane`；hard cap 不能通过裁掉后半段 Lane 实现，全部选中健康出口都必须可达。
- QQ song 无论配置如何只运行一个 Worker/SeqNo 链；likes Worker 才负责跨歌曲并发。
- 正数 `requestBudget` 是任务级 logical comment-page 预算，不按 Lane 倍增；`0` 表示无限。身份、来源、元数据控制请求和 Governor retry attempt 必须与 logical page 分开计数。
- 请求活动中的 configured lanes/workers、实际参与的唯一 lanes/workers、当前活动数与同时在途峰值是不同指标，不能混用。

## 代理、故障切换与取消

- `maxProxyLanes=0` 使用全部有序已验证出口；正数只限制本任务子集，不缩容或重建共享池。
- 共享池现有验证只证明出口/IP 和网易云探测通过，不代表 QQ 域已验证；UI 不得把它标记为“QQ 已验证”。当前不增加强制 QQ 启动探针。
- 使用共享池或显式代理承载 QQ 请求时必须独立 fail-closed。HTTP 转发和 HTTPS CONNECT 的拒绝、超时、取消或永久代理错误都不能回退本机直连；只有用户明确启用 `allowDirect` 且任务没有选择代理承载时才允许直连。
- 普通网络或可重试上游失败保留工作并触发 LaneRecovery；永久代理 4xx（不含限流/可重试状态）只下线当前 Lane，原 cursor 交给健康 Lane。
- `403/429` 按 Governor 冷却语义结算并保留工作。全部 Lane 不可用时任务明确 `paused` 并保留检查点。
- Scanner 同时接受外部任务 signal，并以共享 Gate signal 作为内部取消屏障：外部 abort 会取消全部 Lane/Governor/Gate；Gate abort 会停止队列、LaneAllocator、LaneRecovery 和槽位等待。`executeLane` 在请求前后检查 Gate，JSONL `sync()` 后、状态提交前再次检查同一任务屏障；停止后不得迟到启动请求、提交页状态或重新入队。
- `RequestExecutionError` 必须保留 `cause`，状态分类遍历 cause 链，禁止解析错误文本。网易云 `301 -> AuthenticationRequired` 只能由平台策略启用，不能无条件作用于 QQ。

## 状态、结果与耐久顺序

QQ 数据位于独立命名空间：

```text
data/qq/state-<stable-task-key>.json
data/qq/comments-<stable-task-key>.jsonl
data/logs/qq-<job-id>.jsonl
```

- `stableQQMusicTaskKey` 是稳定路径 key 的唯一生成器：先 trim canonical EncryptUin，再对 JSON 数组 `[mode, target, mode === "song" ? requestedSongId : ""]` 做 SHA-256，取前 24 个十六进制字符。CLI 与 Manager 必须调用同一 helper，不能各自复制算法；song 必须给十进制 requestedSongId，likes 禁止携带它。
- 状态固定标识为 `version: 1`、`kind: "qq-comment-scan"`、`commentPagination: "seqno-v1"`。
- QQ `CmId` 跨歌曲全局唯一没有可靠证据。去重域固定为结构化 `(songId, commentId)`，内部使用经过验证的 `songId:commentId` key；状态字段是 `seenCommentKeys`，JSONL 分别保留原始 songId/commentId。
- 单页成功后的耐久顺序固定为：规范化和匹配 -> 通过长期持有的 append `FileHandle` 串行写入新命中并 `sync()` -> 再检查取消 -> 同步提交页计数、`seenCommentKeys`、cursor/完成标记 -> 等待对应 checkpoint revision -> 释放槽位并决定是否重新入队。Writer cleanup 先等待 append tail，再关闭该 handle。
- 取消发生在 JSONL 同步和状态提交之间时，允许 JSONL 领先状态，但禁止推进 cursor。恢复重读该页时必须补齐 checkpoint ownership，不能重复追加或重复计数。
- writer 初始化必须流式读取已有 JSONL，隔离损坏/不完整尾行，串行追加。`onMatch`/SSE/UI/日志均为最佳努力，失败不能影响耐久写、计数或扫描。
- Writer 将首次 append `write` 或 `sync` 故障锁存为 `QQMusicResultPersistenceError`；该实例后续 append 直接抛出同一错误，不再次写、不加入内存 key，也不发布 `onAppend`。Scanner 把它与 checkpoint 写失败视为全局持久化故障：锁存 `persistenceFailed`、结算 `paused`，取消 LaneRecovery、LaneAllocator、Governor/Gate、队列和 revision waiters；当前页不得换 Lane 或在本轮重放。
- `sync` 失败时 JSONL 可能已经包含完整记录而状态仍未拥有它。下一次恢复重新流式加载 JSONL，以 `(songId, commentId)` 复合 key 对账并重读原页，只补齐 `seenCommentKeys`/matchCount，不重复写结果。
- 持久化故障会立即拒绝 revision waiter，但当时已经开始的 likes 原子 checkpoint I/O 仍可能在途。Scanner `cleanup()` 在任何报告/异常返回前等待当时的 `flushLoop` settle，再关闭 writer；旧任务因此不能先返回、让恢复任务写入新状态后，又由旧 flush 越过任务生命周期覆盖该状态。
- `song` 每个成功页立即原子保存。`likes` 评论页按 `400 ms` 或 `4` 个脏页先到者刷盘，并用与动态 Gate 总在途上限相同数量的 pre-request 槽位限制未持久页；所有终态强制 flush。
- 首次持久化失败锁存全局 `paused`，取消请求和等待者，拒绝后续 revision，禁止保存风暴。
- Decoder 为兼容可读取旧评论 `pageSize=1..100`；Scanner 必须在任何远程请求或 finished 早退前先把 `26..100` 单向持久化为 `25`。迁移保存失败时远程请求数必须为零。
- Decoder 还必须验证模式/目标兼容、song 模式基数和 requestedSongId、十进制 cursor、重复歌曲/命中 key、任务计数等于歌曲求和、`pageNo == pagesProcessed`、`truncated => done` 和有效 ISO 时间；完成字段由状态推导，不盲信缓存布尔值。
- `onCheckpoint` 若发生在原子写前只能称为 live snapshot，不能冒充 durable acknowledgement。

普通 Lane 退避后的 allocator 唤醒使用 `LaneRecovery.waitUntilReady(taskSignal)`。默认运行时内部 timeout 在正常到期、`recordSuccess()` 提前唤醒、Recovery cancel 或 task abort 的所有出口都于 `finally` 清理；扫描结束不得遗留仅用于恢复通知的活跃 timer。

## 活动与结果字段

- 评论页 `QQMusicRequestActivity` 的 `start` 带 operation、workerId、lane、songId/名称、从 1 开始的 page 和 ISO `startedAt`；`success|failure` 沿用同一身份并补充耗时、attempts、comments/total/hasMore 或 status/rateLimited/error。回调异常不影响执行。
- `QQMusicSongActivity`/`onSongProgress` 当前携带 songId、可选 MID/名称/艺人、pages、comments、可选 total、done 和 truncated；它在页提交、页上限截断和资源截断等状态变化后发布，回调仍是最佳努力。
- QQ 结果至少包含 `platform:"qq"`、目标 EncryptUin、歌曲 ID、评论 ID/SeqNo、作者 EncryptUin、正文和捕获时间；MID、名称、艺人、发布时间和统计字段可选。
- Writer 保存 songId/commentId 原始字段并可补充 QQ 歌曲链接；代理凭据、Cookie、状态和结果不得进入专项测试输出或发布资产。

## QQ domain 验证路由

- Client/State/Writer：`node --import tsx --test test/qq-music-client.test.ts test/qq-music-state.test.ts test/qq-music-result-writer.test.ts`，覆盖字符串歌曲 ID、主搜索/Smartbox 严格协议和取消、整页 SeqNo、stable key、复合命中 key、write/sync/callback/close 顺序和持久化故障锁存。
- Scanner：`node --import tsx --test test/qq-music-scanner.test.ts`，覆盖单歌 Lane 轮转、likes hard cap 且全部 Lane 可达、task logical page budget、双取消屏障、JSONL 后提交屏障、持久化失败全局暂停、恢复 timer/flush 清理、歌曲元数据生命周期、迁移/恢复和错误分类。
- 全部 QQ 专项：`node --import tsx --test test/qq*.test.ts`；同时覆盖 CLI、JobManager、离线 benchmark、HTTP/HTTPS 代理、共享 QQ Gate 和 generation。测试数量是易变实现细节，不写入长期记忆。

## EncryptUin / 官方主页单次解析实验

- `src/qq-music/user-input.ts` 拥有生产/共享的官方 URL 严格提取器，`src/qq-music/target-display.ts` 只派生展示；两者都不能改变 canonical EncryptUin。任何直接纯数字（包括 19 位）、官方 URL 数字与可逆 8/12/16 字符 classic EncryptUin 都显示完整 `QQ <number>`；只有可逆 28 字符 classic Token 显示“微信用户”，不显示其解码内部 ID，也不称为微信号或 QQ 号；其他生产 parser 接受的 opaque 值显示完整 `EncryptUin <value>`。官方 URL 本身不回显。
- 共享 URL 提取器的 allowlist 只有 `https://y.qq.com/n/ryqq/profile/<identity>`、`https://y.qq.com/n/ryqq_v2/profile?uin=<identity>`、`https://y.qq.com/portal/profile.html?uin=<identity>`。拒绝 HTTP、非精确 host、userinfo、任何显式端口、fragment、非 profile path、缺失/空/重复 `uin`、任意 `id` 或额外查询参数、非法百分号编码、短链和重定向。用户 URL 只被当作本地字符串解析，从不作为 fetch 目标。
- loopback-only `POST /api/qq/encrypt-uin/decode` 的 Dashboard 请求是 `{input}`，返回 `{inputKind,resolution,format,identityKind,encryptUin,identifier,maskedIdentifier}`。裸/链接 EncryptUin 的 `resolution=local` 不准备 Lane 也不联网；直接/链接数字的 `resolution=network` 在用户点击后由 `QQJobManager.resolveClassicEncryptUinInput` 经一条本机直连 Lane 的 lookup lease、Governor、TransportGate、8 秒超时/取消获得 canonical EncryptUin，再与原数字对账。服务端忽略代理池、表单手动代理和旧代理字段。QQ Client 设置 `redirect:"error"`，只请求固定 QQ 公开资料端点。
- Dashboard 的 QQ song/likes 表单共用一个单次手动弹窗。可逆 QQ 候选会直接显示完整数字，复制仍需显式操作；微信登录身份只显示“微信用户”并禁用内部 ID 的显示/复制。输入改变、弹窗关闭或 `pagehide` 清除完整值及相关 DOM，并取消在途解析/验证。不得增加批量导入、枚举、爬取、历史记录或批量反查。
- loopback-only `POST /api/qq/encrypt-uin/verify` 由 `QQJobManager.verifyClassicEncryptUin` 通过一条 8 秒有界的本机直连 Lane，以原 canonical EncryptUin 和解码候选发出两次公开资料请求，比较 EncryptUin、昵称和头像；只返回 `{format,identityKind,status,maskedIdentifier,checks}`。解析/验证不创建或改变扫描 generation。格式失败、网络/限流失败、上游不可验证和 mismatch 必须分开呈现；match 不证明所有权或私密数据访问权。
- 可信本地界面按展示规则允许出现完整 QQ 或 opaque EncryptUin；日志、错误、诊断、导出文件名、真实文档示例和 Release 说明仍不得泄漏这些值。直接 19 位数字仍完整显示为 QQ；只有 28 字符 Token 解码出的内部 ID 不在界面显示。测试只用合成向量，必须覆盖完整 QQ/opaque、“微信用户”、三个 URL 正例与全部 URL 拒绝边界、本地零网络、数字/验证固定直连且绕过池与手动代理、8 秒上限、超时/取消/lease 释放、match/mismatch、普通目标后台资料补全不阻塞 scanner、微信用户零补全请求/固定展示，以及 generation/checkpoint 不变。

## 共享 JobManager、HTTP/SSE、Dashboard 与恢复

### Manager 与快照

- `src/qq-job-manager.ts` 是独立应用层；`src/server.ts` 只实例化 Manager 并组合路由。Manager 通过 `QQJobManagerOptions` 注入 runtime paths、`TaskCoordinator`、Client factory、runner、pool reader/verifier 和报告快照 reader，便于无实网测试。
- `QQJobGeneration` 是 `{ platform:"qq", mode:"song"|"likes", jobId, target:{ kind:"encryptUin", value } }`；内部 generation 额外绑定 `statePath/outputPath`。目标解析成 canonical EncryptUin 后才发布新 generation；新启动预检失败时保留上一个可读结果 generation。
- `QQJobSnapshot` 实际分组字段为：任务身份/时间（id、mode、generation、完整 `targetLabel`、可选 `targetIdentity`、songId/name、started/finished/elapsed）；持久进度（songs、songsProcessed、pagesProcessed、commentsInspected、matches、requestsTotal、coverageComplete）；实时性能（commentsPerSecond 与 `PagePerformanceSnapshot`）；拓扑（configured/participated lanes/workers、peakInFlight、laneSelection、workersPerLane、hostConcurrency、QQ Gate 参数）；以及 activeSongs、logPath、note/error。普通 QQ/opaque 目标的昵称与受信头像在 scanner promise 建立后经独立 8 秒本机直连辅助 Lane 后台补全，失败或悬挂不阻塞扫描启动，也不占扫描代理 Lane；`微信用户` 不发补全请求，`targetIdentity` 固定为该称谓、元信息和默认头像。
- 活动行合并 `QQMusicRequestActivity` 的瞬时 Worker/页/开始时间和 `QQMusicSongActivity` 的稳定页数/评论数/总数/完成语义；上限 64 行，`done/truncated` 移除进度行。只有成功 `comment-page` 更新 CommentRate/PagePerformance，身份解析、来源发现和元数据不计入读取速度。
- `TaskCoordinator` 的 `qq` lease 覆盖代理准备、目标解析、扫描、用户探测、歌曲详情查询和歌曲搜索。Dashboard 普通查询、正式 start 的数字 canonical 解析和 post-scanner 资料补全都复用 Governor/Gate、8 秒超时和取消语义，但显式跳过代理池/手动代理，只建独立本机直连辅助 Lane；opaque canonical 与 `wechat-user` 保持本地零请求。这些辅助请求不改写扫描 generation/results/checkpoint，只有评论/来源分页进入正式代理 Lane。HTTP 连接中止会传入 Manager controller；新 lookup 通过单调版本号取消并等待旧 lookup 释放后接替，绝不能抢占正式扫描。`stop()` 可取消正在进行的 resolve、lookup/search 和 scanner；所有租约均幂等释放。

### HTTP、generation 与报告

- QQ 路由是 `GET|POST /api/qq/job`、`POST /api/qq/job/stop`、lookup-only `POST /api/qq/user`、`GET /api/qq/song`、`GET /api/qq/song/search?q=&limit=`、loopback-only `POST /api/qq/encrypt-uin/decode|verify`、`GET /api/qq/results?jobId=`、`GET /api/qq/results/stream?jobId=` 和 `GET /api/logs?mode=qq&jobId=`。普通查询固定本机直连并忽略代理字段；搜索 `q` 为 `2..80` 字符、`limit` 为 `1..10`。Results/logs 在异步读取前后复核 generation；SSE 发送 `{ generation, comment }`，不发送无归属的裸评论，并在连接提前 close 时幂等清理订阅。正式 `POST /api/qq/job` 才按任务配置选择代理/直连，代理路径保持 fail-closed。
- 两平台搜索统一返回 `{ platform, query, songs:[{ id, mid?, name, artists, album?, durationMs? }] }`。网易云 `/api/song/search` 使用 `cloudsearch` 单曲类型，并与纯数字 `/api/song` 一样使用 8 秒有界本机直连；启动前 `/api/user` 也固定直连。三者都不读代理池或手动代理。搜索的前端请求世代、旧响应丢弃、Canvas 切换与选中态由 GUI 层负责，后端不把搜索绑定到扫描 generation。NetEase Live Task `/api/user/profile` 仍必须携带 `mode + jobId` 并在请求前后复核 UID/generation，但资料请求本身固定本机直连，不复用 source/parallel Lane、Governor 或 Gate。
- `/api/tasks/active` 与 `/api/tasks/stop` 是全局任务状态和停止操作的权威入口；后端按 `TaskCoordinator.activeMode()` 停止真实扫描 Manager，前端不从当前平台/view猜测目标，并持续轮询到 Manager 返回、Lease 释放和强制终态检查点结算。普通 stop/prepare-update 遇 `activeMode=pool` 时不绕过 pool lease，也不调用 `stopMihomoPool`；prepare 屏障继续阻止新任务并返回 active pool 供前端提示等待，用户取消后释放。Windows `installUpdate` 同步返回和异步 error 也都会释放该屏障。
- Electron 只允许一个实例，第二次启动只唤回主窗口。`desktop-settings.json` 在稳定 `userData` 下原子保存 `closeBehavior: ask|background|exit`；全局设置可保存/恢复默认，原生关闭问询可选择退出、转入托盘或取消并记住选择。托盘创建失败必须保持窗口可见；窗口、托盘和最后实例的退出都经同一个 45 秒有界 graceful-quit，先停止活动扫描并等待检查点。Windows 使用 assisted NSIS，安装时提供桌面快捷方式复选框，完成页保留“立即运行”复选框。
- 完整报告使用固定字节截止点的 JSONL 快照，读取前后校验 platform/mode/jobId/canonical target/outputPath。导出 DTO 是 NetEase UID 与 QQ EncryptUin 的判别联合；route、Electron IPC、隐藏窗口 meta 与 fonts-ready 后校验使用同一 generation。选定路径后 renderer 显示持久阶段、累计耗时和取消操作；读取/字体/打印/原子写入共享取消信号并各自有界，所有成功/取消/失败路径都关闭隐藏窗口、清理监听和释放单飞锁。QQ 完整目标可在 UI 显示，但 PDF 文件名和诊断继续脱敏。旧网易云 `?mode=&jobId=&uid=` 报告 URL 仍归一为 `platform=netease,targetKind=uid`；QQ 报告只从验证过的 MID/十进制 songId 重建官方链接。

### Dashboard 双平台工作区

- 顶栏全局 tabs 在网易云与 QQ 两个隔离工作区间切换，不兼作扫描模式。网易云固定拥有 `parallel/source`，QQ 固定拥有 `song/likes`，并各自记忆 mode 与输出 tab；非活动 workbench 同时 `hidden` 和 `inert`。完整 viewKey 仍为 `netease:parallel`、`netease:source`、`qq:song`、`qq:likes`，jobs、generations、settlement 和 REST/SSE/log/estimate 请求均按完整 key 隔离。
- 平台切换只改变 workbench 内容、主题、模式和请求归属，不改变共享外壳几何。网易云与 QQ 桌面端共用紧凑图标 rail、导航项尺寸和任务抽屉锚点；QQ 不展开 rail 或常驻显示导航文字。横向或纵向缩放不得让顶栏、平台 tabs、窗口按钮、rail、任务栏、drawer 和 inspector 相互碰撞；overlay 模式中的 drawer 与 inspector 互斥，宽表格与长面板在自身容器内滚动。
- 平台切换同时推进 platform/mode 版本，旧 mode 动画和启动响应只能提交到原 owner/view；mode 改变会立即绘制目标 view 的缓存/空快照。离开平台或从 `parallel/song` 切到兄弟 mode 会取消对应歌曲 lookup，但不取消正式扫描；QQ lookup 的 busy 栅栏不在取消时预先释放，而在请求真正结算的异步 `finally` 中移除 controller。完成的平台过渡若回报 `committed=false` 或激活平台不符，上层会同步应用目标平台、展示、快照与 SSE；重选当前平台也会重绘并刷新。Renderer 只接受匹配 generation；QQ 结果 key 为 `songId:commentId`，SSE 由 route jobId 与事件 generation 双重绑定。
- QQ song/likes 使用独立表单；评论页默认/最大 25，likes 来源页默认/最大 500。song 始终是一条 SeqNo 链；likes 直接展示主机上限对应的可调度 Worker，并自动显示每出口许可。Worker 只增加跨歌曲调度，每 IP Governor 节奏不变；共享代理池未预先验证 QQ 域，请求保持 fail-closed。QQ 工作区以中性黑灰/白灰为主体，品牌绿只用于平台标识/关键强调，正文使用更深绿色；导航没有孤立装饰绿点，顶部服务徽章和代理池状态灯仍反映真实状态。QQ 不保存登录 Cookie；工作区固定显示“本地服务”并隐藏网易云二维码登录按钮，网易云已保存会话不得串入 QQ 展示。
- 每个平台任务提交共用右下角点扩胶囊：只显示按时序切换的启动阶段、细进度条与短暂成功/失败结算，不显示耗时，也不替代正式任务进度或检查点。
- `web/platform-wave.js` 只提供一种约 680 ms 的 WebGL2 Obsidian Silk Aperture；顶栏没有动效按钮，旧 `data/ui-preferences.json` 不再读取。五条确定性绢缎褶皱/等高线按切换方向从源平台色收拢到中性黑曜色，244–404 ms 显式保持全屏 alpha 1，约 326 ms/48% 唯一提交目标工作区，然后再以目标色揭幕。渲染器使用一个 program/VAO、`depth:false` 和每帧一次 fullscreen TRIANGLES draw，不创建 instance、VBO、纹理、FBO 或 readback；高光不用 `pow`/`exp`，grain 不用 sine hash，DPR 不超过 1.25，颜色缓冲不超过 1,200,000 像素，resize 沿 `lastElapsed` 立即重绘但不改变时钟/commit。正常 680 ms 先移除 Canvas 和 busy 标记，下一 compositor RAF 再释放 GPU/监听器并 resolve，避免结束闪屏；异常路径立即完整清理。业务 DOM 和身份/评论数据不进入 Canvas/GPU；提交后所有滚动坐标立即恢复，只有 results table 允许在同 platform/mode/view/switch version 与当前 view 的 result generation revision 下延迟补偿，普通 refresh 不取消，新 generation、2.5 s 超时或用户 wheel/touch/pointer/key 操作即取消。
- `pagehide` 会暂停轮询、SSE、运行计时和响应式媒体监听；Chromium 从 BFCache 恢复时，持久化 `pageshow` 路径会重新绑定监听、重启单例计时器、连接当前 generation 的 SSE 并补交待渲染结果，不重复创建循环。
- 当前缓存版本是 `styles.css?v=57`、`platform-wave.js?v=15`、`app.js?v=67`；修改资源后只递增对应 token，并与 `web/index.html` 同步。

### 恢复与估算

- 当前 Manager 写入 resume v3 和 `requestIntervalSemantics:"per-start-v1"`。旧 NetEase v1/v2 在文件锁内一次性等价换算节奏并写回 v3；旧 QQ v2 的自定义间隔原样保留，只有 `pageSize>25` 归一为25。Dashboard 显示 adjustment、强制 fresh=false，且不自动启动或改变扫描检查点。
- QQ GUI 与新 resume 输入只保存 `hostConcurrency`，不再保存 `workersPerProxy`；旧 HTTP 字段只做兼容校验并被忽略。Manager 在选定 Lane 后派生内部 `workersPerLane`，Scanner/快照继续使用该内部字段。
- `/api/estimate` 显式要求 `platform`。QQ 使用 `pageSize<=25`；song 传 `serialRequestChain=1`，likes 用 host 和 lane 数自动派生 `workersPerLane`，两者使用50ms总 Gate和同容量 checkpoint slots。Estimator 与 Governor 都按字面每出口启动间隔计算，Worker 只改善网络在途重叠；估算继续受 partitions、填充率、成功率和网络耗时校准约束。

### 完整交付门禁

运行 `npm run check`、`npm test`、`npm run build`、`npm run bench:qq`、`node --check web/app.js`、`node --check web/platform-wave.js`、`npm run desktop:smoke:mac` 与 `git diff --check`。浏览器需验收双平台/四 viewKey、所有用户/歌曲/EncryptUin/Live Task 展示请求固定直连、QQ start 数字解析与 post-scanner 补全的 8 秒辅助 Lane、opaque/微信本地零请求、正式扫描代理 fail-closed、右下角启动胶囊、跨平台全局停止、桌面生命周期、PDF、平台/SSE 代际、动画/响应式与0 console error。桌面/安装器修改还要跑 desktop-settings、Electron-main contract、window-shell、installer-config focused tests，并在真实Windows assisted NSIS中检查桌面快捷方式与完成后运行选项。通过本地门禁不等于已commit、push、打包或发布；Release仍需独立核对版本、tag、提交和平台资产。
