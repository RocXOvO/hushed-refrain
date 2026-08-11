# 全局代码审计

本文只记录当前主线仍成立的审计结论与修复验收边界，不把“已发现”写成“已修复”。`v1.2.1` 已复验 `npm run check`、`npm test`（592/592，0 fail / 0 cancelled）、`npm run build`、`npm run bench:qq`、三个 renderer 语法检查、`npm run desktop:smoke:mac` 和 `git diff --check` 全绿。真实本地浏览器验收覆盖用户来源/单曲并行的楼中楼范围切换与提示，console warning/error 为零。发布仍必须由同一精确提交的 Windows workflow/package、tag、Release target 和五项资产闭合；未发现新的 P0。

## 未修复的 P1

1. **同一逻辑任务缺少跨进程生命周期 lease。** Electron 已使用 `app.requestSingleInstanceLock()`，第二次桌面启动会唤回现有窗口；这一部分已修复。但 `TaskCoordinator` 仍只在单进程内互斥，CLI、Web 与不同桌面进程仍可对同一 canonical state/output root 并发写入。修复应增加按逻辑目标、状态和结果所有权派生的跨进程任务 lease，并覆盖正常完成、取消、崩溃回收，以及 `record/likes/playlists/both/all` 共享 canonical 输出。
2. **QQ 实时结果暴露完整 EncryptUin。** `web/app.js` 仍在实时结果行直接渲染 `authorEncryptUin`。这与解析实验、工具栏和 PDF 的安全展示边界不一致。REST 初始结果、SSE、新旧平台切换和结算恢复都应只向可见 DOM 提供安全标签或掩码；完整 token 不得进入截图或录屏。此项是隐私边界，不是当前速度诉求。
3. **Web 控制台的可信本机边界没有被全局强制。** CLI 仍允许任意 `--host`；只有报告和少数 QQ 工具路由检查 loopback remote，HTTP 面没有统一校验 Host、Origin/Sec-Fetch、JSON Content-Type 或 CSRF。绑定局域网/公网后，任务、日志、登录和代理池能力可能被其他主机或跨站请求触发。修复应强制 loopback，或设计显式远程模式及完整认证/Host/Origin/CSRF 边界。

## 未修复的 P2 与门禁缺口

- `body()` 只负责大小与 JSON 解析，部分对象型 POST 没有继续经过 `jsonObject()`；`null`、数组或字符串可能落入非预期 500。所有对象型路由应统一要求 plain object，并把错误稳定映射为 400。
- Electron 主窗口仍把任意 popup/外部导航目标交给 `shell.openExternal()`。应通过纯策略函数只允许必要的 HTTPS 官方域名，拒绝 `file:`、自定义 scheme、userinfo、异常端口和非 allowlist host。
- `src/qq-music/proxy-fetch.ts` 的 `collectResponse()` 在 schema 解析前无响应字节上限；超限时应停止聚合并销毁请求/流。
- `desktop.log` 与任务 JSONL 日志无轮转或保留上限；长期运行可能无界占用磁盘。Unix CLI/共享目录下的任务日志仍缺少显式私有文件权限；NetEase 结果 JSONL 已单独使用 `0600`。
- `tsconfig.json` 只检查 `src/**/*.ts`，测试由 `tsx` 转译执行但没有 strict test typecheck。应增加 `tsconfig.test.json` / `npm run check:test` 并纳入交付门禁。
- Windows 包没有 Authenticode 配置，可能触发 SmartScreen。README 与发行说明必须如实描述；`latest.yml` 的 SHA-512 只用于更新完整性，不是代码签名。

## 性能与可扩展性发现

- **覆盖账本逐歌全量重写。** 每首歌自然完成后，`persistSongCoverageIfEligible()` 都以单个 songId 调用 `mergeSongCoverage()`；后者加锁、读取完整 ledger，再原子重写完整 JSON。大量歌曲顺序完成时累计 I/O 接近平方级字节量。应批量/节流新增 ID，保持同一跨进程锁域、UID/schema 验证和最终强制 flush。
- **任务日志逐事件 `appendFile()`。** `TaskLogger` 虽串行化写入且失败不影响扫描，但每个 page start/success/failure/split 都执行一次 `appendFile()`，形成反复 open/write/close。应评估长生命周期 FileHandle、有界批量与轮转，同时保留事件顺序、最佳努力和隐私字段过滤。
- **50 ms 是真实聚合发车硬上限。** NetEase 与 QQ 都先取得 Gate 容量和至少 50 ms 聚合启动槽，再在 HTTP 边界预约 Lane Governor；重试不绕过。用户设为 300 ms + 0–100 ms 时，全局仍至少 50 ms、同出口仍至少 300 ms，聚合最多约 20 次新启动/秒。这是可选调优而非默认改动：NetEase 用户来源 UI 仍为 2500/800 ms。NetEase AIMD 在故障时还会降低有效并发。
- **checkpoint 全量克隆/写入存在病理成本。** `CheckpointCoordinator` 每次 durable opportunity 都 `structuredClone()` 完整状态，随后原子序列化/重写完整 JSON。大量 songs、shards、seen IDs 或长时间任务会让单次 checkpoint 成本随状态体积线性增长，并形成显著累计 GC/I/O。优化必须保留不可变 capture、capture-order 串行、强制终态写、失败传播和精确恢复；不能用共享可变对象换速度。
- 上述热点是可扩展性优化，不改变 50 ms Gate、每 Lane Governor、host cap、代理 fail-closed、JSONL 去重或检查点完成语义。

## 已验证的不变量与已修复事实

- Electron single-instance 已实现；所有真实退出路径仍通过 45 秒有界的停止/强制 checkpoint handoff。
- 同一 Lane 的 Governor 按真实请求启动间隔预约；Worker 不会缩短用户设置。NetEase 和 QQ 都先取 TransportGate 容量/50 ms 启动槽，再在实际 HTTP 边界预约 Lane Governor，重试同路径。QQ song 保持单 SeqNo 链，likes 受 host cap、LaneAllocator、Gate 与 checkpoint slots 约束。
- 使用代理池或显式代理的正式扫描保持 fail-closed；普通用户/歌曲/身份辅助查询固定走有界本机直连。
- 原子 JSON 使用唯一临时名、`fsync`、Windows rename 有界退避和完整临时文件恢复；coverage、resume、代理池和 PDF 目标各自已有跨进程锁。
- NetEase 多来源会按 songId 合并并保留 `memberships`；普通歌单只接受显式匹配目标 UID 的创建者证据。旧 weekly 路径迁移在共享锁内建立并验证 scoped 状态后才删除冲突旧文件，身份冲突时不删除。
- NetEase 将未公开听歌排行/喜欢的音乐持久为 `sourceNotices`：跳过对应来源、继续可用来源且不提交完整覆盖，单一私密来源也不产生任务错误；真实传输/数据失败继续保留在 `sourceErrors`。前端还会把旧检查点的隐私 422 文案映射成友好提示。
- NetEase `CommentScope` 是 `root-only-v1 | root-and-floor-v1`，两个 GUI 视图的新任务默认 root-only，并常驻开启楼中楼会极大降速的警告。Root-only 零 floor I/O，使用独立 `-root-only` state/result/coverage 路径；source state/coverage v4、parallel state v2 都校验 scope，resume v4 保存开关且旧 resume 默认 full，跨 scope 不复用完成、覆盖或结果。Canonical result 仍为 target-v3，现有 route/parent 字段足够。
- `comment_new` 只交付顶层行，但组合 total 含回复。Full scope 的 `comment_floor` 每页 40，从 `time=-1` 开始严格递增，只有 `hasMore=false` 完成。每个 `(song,parent)` 是一页一个的持久工作：同 parent 单飞，不同 parent/歌曲可多 Lane 并行，成功续页可转 Lane，失败接管不重复扣预算。Full scope 只有 root 时间覆盖与全部 floor 完成才提交歌曲/coverage；root-only 仅依 root。
- NetEase 结果 writer 使用长生命周期 `0600` append handle、完整 write loop 与 `sync`；损坏尾片段保留原文并持久补换行，错误关闭/锁存。一个 floor 页的新命中用一次 `appendBatch` write + fsync 落盘，sync 成功后才发布并推进 cursor/计数/checkpoint。Pooled/parallel 在最多 4 个完成页，或页完成时距上次强刷已达 400 ms 时强刷；终态/停止/错误也强刷。JSONL 先于状态，崩溃最多重放已落盘结果并去重；`close()` 排空已接受 append，所有退出都等待关闭。
- NetEase 请求预算已统一为逻辑 history/root/floor 页。Pooled source 与 parallel 的同一 root 页跨 Lane failover 复用预算与顶层 cap 保留，floor 失败接管也复用该页保留；串行 Scanner 也按逻辑页扣减，目录、水合与物理 retry 不重复计数。
- Parallel PDF 在 full scope 下将顶层时间覆盖与整体完成分离：顶层低于 100% 只写“任务尚未完整完成”，顶层 100% 但 floor pending 才写“楼中楼尚未完成”，root + floor 共同完成才写完成。Root-only 明确“未读取楼中楼”，界面不把含回复的 total 作顶层百分比。
- QQ result writer 已按逻辑评论页执行单次 `appendBatch` write + sync，并具备坏尾隔离、持久化错误锁存和 JSONL 领先状态时的恢复对账；song 与 likes 都使用 400 ms/4 脏页有界 checkpoint，等待策略分别守住串行最多四页重放与 likes checkpoint 槽位。
- QQ lookup/search 元数据只在精确匹配 requestedSongId 时由 Manager 缓存传入，Scanner 不再发可选元数据请求。HTTPS CONNECT 取消按逻辑 request token 隔离，不会销毁同 Lane 的其他健康隧道。
- PDF packaged smoke 已覆盖 renderer → preload → IPC → 隐藏 Chromium → 原子写盘并校验完整阶段序列；进度 `elapsedMs` 是包含保存对话框的单调累计耗时，不是独立阶段耗时。
- 四个 viewKey、generation-bound QQ results/SSE/log/report、活动行上限、更新前 acquisition barrier 和 WebGL 异常清理已有现有测试证据。

## 当前最低回归矩阵

- NetEase scope/耐久性：两视图默认关闭并显示极大降速警告、恢复回填保存值、root-only 零 floor I/O、路径/兼容键/恢复/结果跨 scope 隔离；多 parent 多 Lane 并行与同 parent 单飞；批量写入、4 页/400 ms checkpoint、损坏尾行、write/sync 失败、慢写与 timer 竞争，source/parallel root/floor cursor 精确恢复和 result-before-state 顺序。
- 跨进程任务：同任务第二进程拒绝、不同任务允许、取消/崩溃释放、共享 output 所有权和全部用户来源组合协调。
- QQ 隐私：使用合成 EncryptUin sentinel 覆盖 REST、SSE、平台切换、结算和报告，断言完整值不进入可见 DOM、日志或文件名。
- HTTP/Electron：loopback、Host、Origin、Content-Type、CSRF 正反例；所有对象型 POST 的非对象 400；外链 scheme/host allowlist；QQ 大响应上限。
- 性能：覆盖账本批量 flush、不丢并发 union；logger 顺序/轮转/取消；大状态 checkpoint 的 capture 顺序、失败传播、终态强制写和恢复等价性。
- 门禁：`npm run check`、新增 `check:test`、`npm test`、`npm run build`、`npm run bench:qq`、三个前端 JS 语法检查、`npm run desktop:smoke:mac` 与 `git diff --check`；发布仍需精确 SHA 的 Windows packaged smoke 与资产复核。
