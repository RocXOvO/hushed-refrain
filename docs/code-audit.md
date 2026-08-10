# 全局代码审计

本文只记录当前主线仍成立的审计结论与修复验收边界，不把“已发现”写成“已修复”。当前发布线为 `v1.1.5`；发布时仍须独立核对 `main`、`origin/main`、tag、GitHub Release target 与资产。该发布线复验 `npm run check`、`npm test`（535/535）、`npm run build`、`npm run bench:qq`、三个 renderer 语法检查、`npm run desktop:smoke:mac` 和 `git diff --check` 全绿。真实浏览器已对照上游 Follow 验证两平台长拖尾与持续高速圆周包络；既有 1440×900、900×640 与 390×844 布局、会话开关、快速 N→Q→N 和零 console 错误边界保持不变。Windows 包仍须由同一提交的 GitHub workflow 完成打包与烟测；未发现新的 P0。

## 未修复的 P1

1. **网易云结果与检查点的耐久提交顺序。** `src/results.ts` 仍以 `appendFile()` 逐条追加，不做 `fsync()`，也没有 QQ writer 的损坏尾行隔离与锁存持久化错误语义。source/parallel 可能在命中结果耐久落盘前推进统计、cursor 和强制 checkpoint；断电、写失败或无换行坏尾可能让状态领先结果。修复必须让 NetEase writer 具备完整 write loop + sync + 尾行修复，并让页面状态只在全部命中耐久写入后提交。
2. **同一逻辑任务缺少跨进程生命周期 lease。** Electron 已使用 `app.requestSingleInstanceLock()`，第二次桌面启动会唤回现有窗口；这一部分已修复。但 `TaskCoordinator` 仍只在单进程内互斥，CLI、Web 与不同桌面进程仍可对同一 canonical state/output root 并发写入。修复应增加按逻辑目标、状态和结果所有权派生的跨进程任务 lease，并覆盖正常完成、取消、崩溃回收，以及 `record/likes/playlists/both/all` 共享 canonical 输出。
3. **QQ 实时结果暴露完整 EncryptUin。** `web/app.js` 仍在实时结果行直接渲染 `authorEncryptUin`。这与解析实验、工具栏和 PDF 的安全展示边界不一致。REST 初始结果、SSE、新旧平台切换和结算恢复都应只向可见 DOM 提供安全标签或掩码；完整 token 不得进入截图或录屏。此项是隐私边界，不是当前速度诉求。
4. **Web 控制台的可信本机边界没有被全局强制。** CLI 仍允许任意 `--host`；只有报告和少数 QQ 工具路由检查 loopback remote，HTTP 面没有统一校验 Host、Origin/Sec-Fetch、JSON Content-Type 或 CSRF。绑定局域网/公网后，任务、日志、登录和代理池能力可能被其他主机或跨站请求触发。修复应强制 loopback，或设计显式远程模式及完整认证/Host/Origin/CSRF 边界。

## 未修复的 P2 与门禁缺口

- `body()` 只负责大小与 JSON 解析，部分对象型 POST 没有继续经过 `jsonObject()`；`null`、数组或字符串可能落入非预期 500。所有对象型路由应统一要求 plain object，并把错误稳定映射为 400。
- Electron 主窗口仍把任意 popup/外部导航目标交给 `shell.openExternal()`。应通过纯策略函数只允许必要的 HTTPS 官方域名，拒绝 `file:`、自定义 scheme、userinfo、异常端口和非 allowlist host。
- `src/qq-music/proxy-fetch.ts` 的 `collectResponse()` 在 schema 解析前无响应字节上限；超限时应停止聚合并销毁请求/流。
- `desktop.log` 与任务 JSONL 日志无轮转或保留上限；长期运行可能无界占用磁盘。Unix CLI/共享目录下的 NetEase JSONL 和任务日志也缺少显式私有文件权限。
- `tsconfig.json` 只检查 `src/**/*.ts`，测试由 `tsx` 转译执行但没有 strict test typecheck。应增加 `tsconfig.test.json` / `npm run check:test` 并纳入交付门禁。
- Windows 包没有 Authenticode 配置，可能触发 SmartScreen。README 与发行说明必须如实描述；`latest.yml` 的 SHA-512 只用于更新完整性，不是代码签名。

## 性能与可扩展性发现

- **覆盖账本逐歌全量重写。** 每首歌自然完成后，`persistSongCoverageIfEligible()` 都以单个 songId 调用 `mergeSongCoverage()`；后者加锁、读取完整 ledger，再原子重写完整 JSON。大量歌曲顺序完成时累计 I/O 接近平方级字节量。应批量/节流新增 ID，保持同一跨进程锁域、UID/schema 验证和最终强制 flush。
- **任务日志逐事件 `appendFile()`。** `TaskLogger` 虽串行化写入且失败不影响扫描，但每个 page start/success/failure/split 都执行一次 `appendFile()`，形成反复 open/write/close。应评估长生命周期 FileHandle、有界批量与轮转，同时保留事件顺序、最佳努力和隐私字段过滤。
- **50 ms 是真实聚合发车硬上限。** NetEase 与 QQ 的健康任务 Gate 都至少间隔 50 ms，即在 Lane Governor 与网络瓶颈之前，聚合最多约 20 次新请求启动/秒。增加 Worker、Lane 或 pageSize 不能突破这个上限；估算、UI 和性能承诺必须使用同一事实。NetEase AIMD 还会在故障时进一步降低有效并发并拉长间隔。
- **checkpoint 全量克隆/写入存在病理成本。** `CheckpointCoordinator` 每次 durable opportunity 都 `structuredClone()` 完整状态，随后原子序列化/重写完整 JSON。大量 songs、shards、seen IDs 或长时间任务会让单次 checkpoint 成本随状态体积线性增长，并形成显著累计 GC/I/O。优化必须保留不可变 capture、capture-order 串行、强制终态写、失败传播和精确恢复；不能用共享可变对象换速度。
- 上述热点是可扩展性优化，不改变 50 ms Gate、每 Lane Governor、host cap、代理 fail-closed、JSONL 去重或检查点完成语义。

## 已验证的不变量与已修复事实

- Electron single-instance 已实现；所有真实退出路径仍通过 45 秒有界的停止/强制 checkpoint handoff。
- 同一 Lane 的 Governor 按真实请求启动间隔预约；Worker 不会缩短用户设置。QQ 的实际远端开始先取得 TransportGate 容量与 50 ms 聚合间隔，再在同一启动边界预约 Lane Governor；重试也不绕过。song 保持单 SeqNo 链，likes 受 host cap、LaneAllocator、Gate 与 checkpoint slots 约束。
- 使用代理池或显式代理的正式扫描保持 fail-closed；普通用户/歌曲/身份辅助查询固定走有界本机直连。
- 原子 JSON 使用唯一临时名、`fsync`、Windows rename 有界退避和完整临时文件恢复；coverage、resume、代理池和 PDF 目标各自已有跨进程锁。
- NetEase 多来源会按 songId 合并并保留 `memberships`；普通歌单只接受显式匹配目标 UID 的创建者证据。旧 weekly 路径迁移在共享锁内建立并验证 scoped 状态后才删除冲突旧文件，身份冲突时不删除。
- QQ result writer 已按逻辑评论页执行单次 `appendBatch` write + sync，并具备坏尾隔离、持久化错误锁存和 JSONL 领先状态时的恢复对账；song 与 likes 都使用 400 ms/4 脏页有界 checkpoint，等待策略分别守住串行最多四页重放与 likes checkpoint 槽位。
- QQ lookup/search 元数据只在精确匹配 requestedSongId 时由 Manager 缓存传入，Scanner 不再发可选元数据请求。HTTPS CONNECT 取消按逻辑 request token 隔离，不会销毁同 Lane 的其他健康隧道。
- PDF packaged smoke 已覆盖 renderer → preload → IPC → 隐藏 Chromium → 原子写盘并校验完整阶段序列；进度 `elapsedMs` 是包含保存对话框的单调累计耗时，不是独立阶段耗时。
- 四个 viewKey、generation-bound QQ results/SSE/log/report、活动行上限、更新前 acquisition barrier 和 WebGL 异常清理已有现有测试证据。

## 修复后的最低回归矩阵

- NetEase 耐久性：损坏尾行、write/sync 失败、慢写与 checkpoint timer 竞争、source/parallel 精确 cursor/shard 恢复。
- 跨进程任务：同任务第二进程拒绝、不同任务允许、取消/崩溃释放、共享 output 所有权和全部用户来源组合协调。
- QQ 隐私：使用合成 EncryptUin sentinel 覆盖 REST、SSE、平台切换、结算和报告，断言完整值不进入可见 DOM、日志或文件名。
- HTTP/Electron：loopback、Host、Origin、Content-Type、CSRF 正反例；所有对象型 POST 的非对象 400；外链 scheme/host allowlist；QQ 大响应上限。
- 性能：覆盖账本批量 flush、不丢并发 union；logger 顺序/轮转/取消；大状态 checkpoint 的 capture 顺序、失败传播、终态强制写和恢复等价性。
- 门禁：`npm run check`、新增 `check:test`、`npm test`、`npm run build`、`npm run bench:qq`、三个前端 JS 语法检查、`npm run desktop:smoke:mac` 与 `git diff --check`；发布仍需精确 SHA 的 Windows packaged smoke 与资产复核。
