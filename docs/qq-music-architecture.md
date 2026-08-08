# QQ 音乐评论查询架构

本文只描述 `v0.21.0` 源码中的 QQ 音乐领域实现。历史迁移基线与设计决策记录见 `qq-music-integration-design.md`，当前实现契约以本文、`qq-music-memory.md` 和测试为准。

桌面显示品牌为“乐评寻踪 / MUSIC COMMENT TRACE”，`productName` 为“乐评寻踪”；这不改变 QQ 数据或升级身份。包名 `ncm-comment-finder`、appId `cn.local.ncm.commentfinder`、仓库 `RocXOvO/ncm-comment-finder`、安装包文件名前缀 `NCM-Comment-Finder` 和持久目录 `appData/ncm-comment-finder` 保持不变。

## 范围与入口

QQ 音乐首发支持两种任务：

- `song`：扫描一首指定歌曲，查找目标 `EncryptUin` 的评论。
- `likes`：先读取目标用户公开“我喜欢”歌曲，再跨歌曲并行扫描。

领域实现位于 `src/qq-music/**`。`src/qq-cli.ts` 是独立命令行入口；桌面端由共享 `QQJobManager` 组装 Lane、任务路径和展示事件。QQ Scanner 不依赖 Server 或 DOM。

歌曲搜索属于 lookup-only 控制请求，不是第三种扫描模式。`QQMusicClient.searchSongs` 优先使用公开桌面搜索 CGI 并严格校验 `data.body.song.list`；仅当该列表结构合法且为空时，才通过同一 fetch、代理和取消 signal 回退到官方 Smartbox 的 `data.song.itemlist`，非空畸形主结果不得被回退掩盖。两条路径都把歌曲 ID/MID 原样保留为字符串。`QQJobManager.searchSongs` 复用与歌曲详情相同的代理准备、Lane 轮换、全局 `TaskCoordinator` lease 和取消路径，但不会创建或改写扫描 generation、结果或检查点。HTTP 连接中止会取消对应 lookup 并释放 lease；新 lookup 可按版本安全替换旧 lookup，正式扫描持有的 lease 不会被搜索抢占或取消。

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

每 Lane 的 Governor pacing concurrency 固定为 `1`；多个 Worker 只允许慢请求在不同歌曲间重叠，不会乘倍单 IP 的请求启动频率。全任务还共享一个 QQ TransportGate，但它不再固定为 4：`song` 为 `1` 个在途、启动间隔至少 `250 ms`；`likes` 的总在途上限等于实际有界 Worker 容量（最大 `32`），启动间隔为 `max(80, ceil(1000 / max(4, 总在途上限))) ms`。这只扩大独立出口间已经受 Governor 约束的重叠，不改变每个 Lane 默认 `3000 ms + jitter` 的启动周期。

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

`song` 每个成功页立即原子 checkpoint。`likes` 在 400 ms 或 4 个脏页先到时合并保存，并用与本任务动态 Gate 总在途上限相同数量的 pre-request 槽位限制尚未持久化的页面；停止、冷却、失败和终态强制 flush。JSONL `write/sync` 错误由 `QQMusicResultPersistenceError` 锁存为全局持久化故障，不能误算成代理 Lane 故障或在本次运行换 Lane 重写；首次持久化失败会暂停任务并取消后续工作，下次恢复再从 JSONL 复合 key 对账。清理阶段必须等待当时已经开始的 checkpoint flush 完全结束，旧任务不能在返回后继续写状态并覆盖紧接着启动的恢复任务。

## 歌曲搜索 HTTP 契约

`GET /api/song/search?q=&limit=` 与 `GET /api/qq/song/search?q=&limit=&proxy=&allowDirect=` 返回同一 DTO：

```json
{
  "platform": "netease",
  "query": "歌名或歌手",
  "songs": [{
    "id": "123",
    "mid": "可选 QQ MID",
    "name": "歌曲名",
    "artists": ["歌手"],
    "album": "可选专辑",
    "durationMs": 240000
  }]
}
```

`q` 去除首尾空白后必须为 `2..80` 字符，`limit` 必须为 `1..10`，默认 `10`。网易云使用 `cloudsearch` 的单曲类型；搜索和纯数字 `/api/song` 元数据查询都通过同一 Router，代理池运行时从最近验证成功的出口轮换，单次最多尝试三个瞬态失败出口，复核失败或全部失败都禁止回退直连；未运行代理池时可直接请求或使用显式代理。QQ 搜索通过 Manager 安全路径，代理池运行时同样 fail-closed；没有代理池时必须提供显式代理或明确 `allowDirect=1`。

搜索响应不拥有扫描 generation。旧查询响应是否仍对应当前平台、输入和选中项由前端请求世代负责；Canvas 切换、搜索防抖、旧响应丢弃和候选交互由 GUI 层实现，本领域代码不据此改写扫描状态。

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

专项测试覆盖 Client、状态、writer、Scanner、CLI、代理、TransportGate、benchmark、严格歌曲搜索协议以及共享 QQJobManager 的接口联调。搜索测试必须覆盖空结果、畸形响应、超大字符串 ID、代理失败不直连、取消和 lease 释放。真实 QQ CGI 是非公开且可能变化的上游，低频实网只能作为兼容性观察，不能替代确定性测试。
