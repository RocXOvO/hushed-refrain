# QQ 音乐评论查询架构

本文只描述 `v0.20.0` 源码中的 QQ 音乐领域实现。冻结的跨模块契约见 `qq-music-integration-design.md`，需要快速恢复实现上下文时先读 `qq-music-memory.md`。

## 范围与入口

QQ 音乐首发支持两种任务：

- `song`：扫描一首指定歌曲，查找目标 `EncryptUin` 的评论。
- `likes`：先读取目标用户公开“我喜欢”歌曲，再跨歌曲并行扫描。

领域实现位于 `src/qq-music/**`。`src/qq-cli.ts` 是独立命令行入口；桌面端由共享 `QQJobManager` 组装 Lane、任务路径和展示事件。QQ Scanner 不依赖 Server 或 DOM。

## 数据流

```text
数字 QQ / 主页 URL / EncryptUin
            |
            v
  canonical EncryptUin ---------> stable task key
            |                           |
            |                           +--> data/qq/state-*.json
            |                           +--> data/qq/comments-*.jsonl
            v
     song 或公开 likes 来源
            |
            v
   跨歌曲 Worker 队列
            |
            v
  shared LaneAllocator --> Lane Governor --> QQ TransportGate --> QQ CGI
            |
            v
  严格校验整页 SeqNo / 业务码 / cursor
            |
            v
 命中 JSONL write+sync --> 取消屏障 --> 状态提交与 checkpoint
```

`EncryptUin` 是不透明作者标识。代码只做完整字符串相等匹配，不尝试解密或反推 QQ 号。任务路径由 canonical `EncryptUin`、模式和 song 模式下的原始十进制 `requestedSongId` 稳定派生。

## 分页与身份不变量

评论接口每页范围为 `1..25`，新任务默认 `25`；公开喜欢来源每页范围为 `1..500`，默认 `500`。两者属于不同接口，不能互相替代。

评论分页使用 SeqNo：下一页 cursor 必须来自本页最后一条已规范化评论的 SeqNo。Client 会拒绝缺少字段、非十进制 SeqNo、页内非严格递减、跨页不后退、`HasMore` 却没有 cursor，以及任何非零业务码。失败不会推进 cursor。

歌曲详情只能补充 MID、名称和艺人。Scanner 始终以用户请求的十进制 `requestedSongId` 建立 song 任务；ID 全程使用字符串，不能经过 JavaScript `Number`。

## Worker、Lane 与请求预算

同一歌曲始终只有一条在途 SeqNo 链。`song` 模式固定一个 Worker；`likes` 模式通过 `workerCountForTopology(lanes, workersPerLane, maxWorkers)` 决定 Worker 数，只并行不同歌曲。

所有 Worker 共用一个 `LaneAllocator`。每个成功页重新公平获取健康 Lane，因此全部选中出口可参与轮转；普通故障保留原 cursor，并由健康 Lane 接力。`maxWorkers` 是主机级硬上限，不能通过裁掉后半段 Lane 实现。

每 Lane 的 Governor pacing concurrency 固定为 `1`；多个 Worker 只允许慢请求在不同歌曲间重叠，不会乘倍单 IP 的请求启动频率。全任务还共享一个 QQ TransportGate，最多 4 个在途请求、启动间隔至少 250 ms。

`requestBudget` 是任务级 logical comment-page 预算。一次逻辑页在失败、重试或换 Lane 后仍只占一个预算单位；身份解析、喜欢来源、歌曲元数据和 Governor 的 retry attempt 不计入该预算。`0` 表示无限。

## 代理与故障边界

代理请求由 `proxy-fetch.ts` 通过 HTTP 转发或 HTTPS CONNECT 发出。代理拒绝、超时、取消或永久错误均 fail-closed，绝不回退本机直连。共享代理池的现有探测不等价于 QQ 域探测；QQ 的每个实际请求仍独立验证成败。

可重试网络或上游错误进入 LaneRecovery；永久代理错误只下线该 Lane。`403/429` 按冷却语义保留任务；全部 Lane 不可用时任务暂停。只有明确属于歌曲资源的 HTTP `404/410` 才把该歌曲标记为 `done + truncated`，协议或业务错误不能伪装成空结果。

## 持久化与恢复

命中去重域是 `(songId, commentId)`，状态字段为 `seenCommentKeys`。QQ `CmId` 不被假定为跨歌曲全局唯一。

结果 writer 初始化时流式读取既有 JSONL，长期持有 append FileHandle，并串行执行：

```text
write(JSONL) -> sync() -> 登记结果 key -> onMatch（最佳努力）
```

单页 Scanner 的耐久顺序为：

```text
结果 write+sync -> 检查任务取消 -> 提交计数/seen key/cursor -> 等待 checkpoint revision
```

若取消发生在 JSONL 同步后、状态提交前，JSONL 可以领先状态，但 cursor 不能推进；恢复时重读原页，以复合 key 去重并补齐状态所有权。

`song` 每个成功页立即原子 checkpoint。`likes` 在 400 ms 或 4 个脏页先到时合并保存，并用 4 个 pre-request 槽位限制尚未持久化的页面；停止、冷却、失败和终态强制 flush。JSONL `write/sync` 错误由 `QQMusicResultPersistenceError` 锁存为全局持久化故障，不能误算成代理 Lane 故障或在本次运行换 Lane 重写；首次持久化失败会暂停任务并取消后续工作，下次恢复再从 JSONL 复合 key 对账。清理阶段必须等待当时已经开始的 checkpoint flush 完全结束，旧任务不能在返回后继续写状态并覆盖紧接着启动的恢复任务。

旧状态允许读取 `pageSize=26..100`，但 Scanner 必须在任何远程请求或 finished 早退前先原子迁移为 `25`。状态 decoder 重新推导完成与覆盖字段，并校验模式、目标、song 身份、计数聚合、cursor、时间和截断不变量。

## 取消与活动事件

Scanner 同时消费外部 `ScanOptions.signal` 和所有 Lane 共享的 Gate signal。外部取消会取消 Lane/Governor/Gate；Gate 取消会停止队列、LaneAllocator、LaneRecovery 和 checkpoint 槽位等待。请求前后以及 JSONL 同步后均有取消屏障，确保停止后不迟到提交 cursor。

评论请求通过 `QQMusicRequestActivity` 汇报 ISO `startedAt`、网络耗时、attempts、有效评论数和 Lane/Worker。歌曲进度通过 `QQMusicSongActivity` 汇报 pages、comments、可选 total、done 与 truncated。所有展示回调均为最佳努力，不能改变扫描或持久化结果。

## 验证

常规验证使用 stub、回环代理和离线模型，不向 QQ 音乐发送高频流量：

```bash
npm run check
node --import tsx --test test/qq*.test.ts
npm run build
npm run bench:qq
git diff --check
```

专项测试覆盖 Client、状态、writer、Scanner、CLI、代理、TransportGate、benchmark 以及共享 QQJobManager 的接口联调。真实 QQ CGI 是非公开且可能变化的上游，低频实网只能作为兼容性观察，不能替代确定性测试。
