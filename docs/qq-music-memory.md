# QQ 音乐专项记忆

这是 QQ 领域的精简维护清单，不复制完整架构。现行详细真值以 [`qq-music-architecture.md`](qq-music-architecture.md)、`src/qq-music/**`、`src/qq-job-manager.ts` 和测试为准；[`qq-music-integration-design.md`](qq-music-integration-design.md) 仅是 v0.19/v0.20 历史迁移记录，不能反向覆盖当前实现。全局发布、安全与未修问题见根目录 `AGENTS.md` 和 [`code-audit.md`](code-audit.md)。

## 领域边界

- QQ 只有 `song` 与 `likes` 两种扫描；不复用 NetEase 时间 cursor、time shard、source state、target-v3 JSONL 或 coverage ledger。
- 目标输入是数字 QQ、严格 allowlist 的官方资料 URL 或 EncryptUin；扫描只按 canonical EncryptUin 完整相等匹配。
- QQ 不保存 Cookie/musickey，不做扫码登录、私密喜欢列表、未经验证的公开听歌记录或同一歌曲多页并发。
- QQ CGI 不是稳定公开 SDK。常规测试只用 stub、回环代理和离线模型；实网观察必须显式、低频且不能替代确定性测试。

## 分页、状态与耐久

- 评论页使用 `GetNewCommentList`，范围/默认 `1..25 / 25`；公开喜欢来源页范围/默认 `1..500 / 500`。
- 歌曲 ID 与 SeqNo 始终是十进制字符串。`requestedSongId` 是 song 任务主键，元数据响应不得替换它或经过 JavaScript `Number`。Manager 只缓存 lookup/search 已取得的精确元数据（最多 32 项），Scanner 仅在元数据 ID 完全等于 requestedSongId 时使用，且不为扫描另发可选元数据请求。
- 页内相等或局部乱序 SeqNo 保留原顺序；原始末条规范化评论是下一 cursor。恢复页每一行都必须严格老于请求 cursor，否则当前歌曲不推进，likes 的其他歌曲可继续。
- 同一歌曲最多一个在途页。只有明确的歌曲资源 HTTP 404/410 可标记 `done + truncated`；协议、业务、持久化或 cursor 错误不得伪装成空页/完整覆盖。
- QQ 状态固定为 version 1、`kind:"qq-comment-scan"`、`commentPagination:"seqno-v1"`，位于 `data/qq/`。稳定任务 key 必须通过共享 helper 从 mode、canonical target 和可选 requestedSongId 派生。
- 去重域是 `(songId,commentId)`，不是 task-global commentId。
- 每个逻辑评论页把全部新命中交给一次 `appendBatch`：复合 key 去重后以一次 write + fsync 持久化，再发布结果。随后检查取消，最后提交 counters/seen key/cursor 并等待需要的 checkpoint revision。JSONL 可领先状态，cursor 不可领先 JSONL；恢复必须对账而不重复追加/计数。
- `song` 与 `likes` 都以 400 ms 或 4 个脏页先到者 flush。likes Worker 等待每个 revision，使动态 Gate 容量的 checkpoint 槽位保持硬上限；单一 song SeqNo 链可继续到四页阈值，崩溃时最多重放四个已耐久 JSONL 页。所有终态等待已开始的 flush 并强制保存。

## Worker、代理与取消

- 每 Lane 拥有独立 Client/Governor，任务共享一个 QQ TransportGate。每次远端 attempt 先取得 Gate 在途容量并等待至少 50 ms 的任务聚合启动间隔，再在实际开始边界预约所选 Lane 的 Governor `minDelayMs + jitter`；请求随后立即启动，重试也走相同路径。Worker 永不除小任一间隔。
- 新任务每 Lane 默认 300–399 ms；50 ms Gate 是整个任务最多约 20 次新启动/秒的真实上限。
- `song` 固定一个 Worker/SeqNo 链；`likes` 使用 `hostConcurrency` 个跨歌曲 Worker，并派生 `workersPerLane = ceil(hostConcurrency / selectedLanes)`。
- Worker 每页从共享 `LaneAllocator` 公平领取 Lane。host cap 不能通过裁掉后半段已选 Lane 实现；`maxProxyLanes=0` 表示使用全部有序已验证出口。
- 共享池只证明出口和 NetEase 探测，不代表 QQ 域已验证。正式 QQ 代理请求逐次 fail-closed；代理拒绝、超时或永久错误不能回退直连。
- HTTPS CONNECT Agent 为每个逻辑请求分配 token。取消/失败只销毁该 token 的 pending CONNECT、当前请求和 socket；不得销毁共享 Agent 或同 Lane 的其他健康隧道。只有 Lane/fetch 关闭才整体 `agent.destroy()`。
- 普通失败保留原 cursor 并进入可取消的 LaneRecovery；403/429 保存 cooldown；全部 Lane 被证明不可用时任务暂停而非完成。
- 外部 signal 与 Gate signal 共同覆盖队列、Allocator、Recovery、Governor、Client、fetch 和 checkpoint slots。停止后不得迟到启动请求、提交 cursor 或重新入队。

## 身份与辅助查询

- 生产 canonical parser、展示派生和单次 EncryptUin 实验彼此隔离；展示不得改变 task key、generation、checkpoint、结果路径或匹配条件。
- 数字候选只有在固定直连解析返回 canonical EncryptUin 的明确证据后才建立其任务身份；缺失或不匹配的公开资料不得把输入 UID/数字候选臆测成另一身份或别名。
- 直接数字（含 19 位）与可逆 8/12/16 classic token 显示完整 `QQ <number>`；可逆 28 字符微信登录 token 只显示 `微信用户`；其他已接受 opaque 值显示 `EncryptUin <value>`。官方 URL 本身不回显。
- Dashboard 用户探测、歌曲详情/搜索、数字 canonical 解析、正向验证和普通目标的后台资料补全固定走独立 4 秒本机直连 Lane，忽略池与手动代理；opaque canonical 保持本地零请求，`微信用户` 不发补全请求。
- 上述 lookup-only 请求仍受 Manager lease、Governor、Gate、取消、单飞/代际约束，但不创建或改变扫描 generation。只有正式评论/来源分页进入扫描代理拓扑。
- 可信本地 UI 的目标展示规则不授权日志、错误、诊断、导出文件名、fixture 或 Release 示例保存完整 token。QQ 实时结果仍显示 `authorEncryptUin` 是当前未修 P1，见 `code-audit.md`。

## 共享应用边界

- `src/qq-job-manager.ts` 拥有 QQ generation、路径、Lane 组装、lookup、活动、结果、日志、报告和 resume；`src/server.ts` 只组合 HTTP。
- Generation 至少绑定 platform、mode、jobId、canonical target 和 owned state/output path。REST/SSE/log/report 异步读取前后都要复核；新启动预检失败不得偷换旧结果 generation。
- 四个前端 viewKey 始终完整隔离；QQ Manager 只在自身单 Manager 语义需要时使 QQ sibling generation 失效。
- `/api/tasks/active` 与 `/api/tasks/stop` 是真实全局任务事实源。更新、窗口退出和顶部停止不能根据当前可见平台猜测要停止的 Manager。
- 当前 web cache-busters 为 styles 65、platform-wave 15、pointer-silk-trail 6、app 77；GUI/WebGL 平台交接、网易云来源切换/活动进度、折叠 Inspector 提示与鼠标 MeshLine 细节只维护在 `platform-gui-architecture.md`。

## 变更复验

- QQ 领域改动至少运行 `npm run check`、QQ focused tests、`npm test`、`npm run build`、`npm run bench:qq` 与 `git diff --check`。
- 身份/lookup 改动必须覆盖 synthetic URL/token 边界、本地零请求、固定 direct 绕池、4 秒超时/取消/lease 释放、generation 不变与脱敏。
- Scanner/writer 改动必须覆盖 SeqNo 边界、同歌单链、Lane failover、持久化故障、JSONL 领先状态恢复、checkpoint flush/取消清理和 complete/coverage 分离。
- 修改本文件时只更新以上不变量或权威指针；详细接口字段、GUI 动画、逐条测试矩阵和历史实施过程不得再次复制进来。
