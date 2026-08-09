# QQ 音乐评论查询架构

本文只描述当前源码中的 QQ 音乐领域实现。历史迁移基线与设计决策记录见 `qq-music-integration-design.md`，当前实现契约以本文、`qq-music-memory.md` 和测试为准。

桌面显示品牌为“乐评寻踪 / MUSIC COMMENT TRACE”，`productName` 为“乐评寻踪”；这不改变 QQ 数据或升级身份。包名 `ncm-comment-finder`、appId `cn.local.ncm.commentfinder`、仓库 `RocXOvO/ncm-comment-finder`、安装包文件名前缀 `NCM-Comment-Finder` 和持久目录 `appData/ncm-comment-finder` 保持不变。

## 范围与入口

QQ 音乐当前支持两种任务：

- `song`：扫描一首指定歌曲，查找目标 `EncryptUin` 的评论。
- `likes`：先读取目标用户公开“我喜欢”歌曲，再跨歌曲并行扫描。

领域实现位于 `src/qq-music/**`。`src/qq-cli.ts` 是独立命令行入口；桌面端由共享 `QQJobManager` 组装 Lane、任务路径和展示事件。QQ Scanner 不依赖 Server 或 DOM。

歌曲搜索属于 lookup-only 控制请求，不是第三种扫描模式。`QQMusicClient.searchSongs` 优先使用公开桌面搜索 CGI 并严格校验 `data.body.song.list`；仅当该列表结构合法且为空时，才通过同一 fetch 和取消 signal 回退到官方 Smartbox 的 `data.song.itemlist`，非空畸形主结果不得被回退掩盖。两条路径都把歌曲 ID/MID 原样保留为字符串。Dashboard 的歌名/数字歌曲普通查询始终走一条本机直连 Lane，不读代理池或扫描表单里的手动代理；Manager 仍用 `TaskCoordinator` lease、Governor、Gate、取消和 4 秒超时路径，不创建或改写扫描 generation、结果或检查点。前端同关键词单飞、60 秒/24 项小缓存，并在请求期间显示加载/失败状态。

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

扫描主流程始终把 `EncryptUin` 当作不透明作者标识，只做完整字符串相等匹配。任务路径由 canonical `EncryptUin`、模式和 song 模式下的原始十进制 `requestedSongId` 稳定派生；下面的单次身份解析实验不会替换 canonical target、stable task key、generation、状态路径或评论匹配条件。正式 start 遇数字目标时，canonical 解析使用独立 4 秒本机直连辅助 Lane；opaque EncryptUin 已是 canonical，保持本地零请求。只有后续评论页和来源分页进入正式扫描代理拓扑。

## EncryptUin 与官方主页单次解析实验

QQ song/likes 表单另有启动前用户探测：loopback-only `POST /api/qq/user` 始终使用一条 4 秒有界的本机直连 Lane，即使代理池运行或表单已填手动代理也不读它们。它在任务启动前返回公开昵称和受信头像；具体数字 QQ 的头像来自确定的腾讯公开 `qlogo.cn` 地址，`wechat-user` 为本地零请求的固定展示。该探测不发布或改变扫描 generation/checkpoint。

Dashboard 的 QQ 两个任务表单共用生产目标预览和“EncryptUin 解析实验”。`src/qq-music/target-display.ts` 只负责展示：任何直接纯数字（包括 19 位）、官方 URL 中的数字以及可逆 8/12/16 字符 classic EncryptUin 都显示完整 `QQ <number>`；只有可逆 28 字符 classic Token 显示“微信用户”，不显示其解码出的内部 ID；其他生产 parser 接受但不可逆的 opaque 值显示完整 `EncryptUin <value>`。官方 URL 只显示提取后的身份，不回显 URL。上述展示、昵称和头像都不进入 canonical target、task key、generation、checkpoint、结果路径或作者匹配。

单次实验只接受裸 EncryptUin、严格允许的 QQ 音乐官方个人主页 URL，或 5..12 / 19 位十进制候选标识。`POST /api/qq/encrypt-uin/decode` 只允许 loopback，Dashboard 请求体是 `{input}`；服务端忽略代理池、手动代理和旧代理字段，返回 `{inputKind,resolution,format,identityKind,encryptUin,identifier,maskedIdentifier}`。完整 QQ 候选会直接进入可见结果，复制仍需明确点击；微信登录身份只显示“微信用户”。改变输入、关闭弹窗或离开页面会清除完整值和相关 DOM。实验不保存历史，不提供批量导入、枚举、爬取、历史记录或批量反查。

本地解码只支持冻结字符表中的两类严格格式：8/12/16 字符的经典 QQ 短格式必须解码为 5..12 位、非 `0` 开头数字，内部标为 `qq-number-candidate` 并显示完整 QQ；28 字符格式必须解码为恰好 19 位、非 `0` 开头数字，内部标为 `wxuin-candidate`，但界面只显示“微信用户”。后者既不显示内部 ID，也不称为微信号或 QQ 号；公开资料不提供到 `wxid/openid/unionid` 的转换。逆替换必须是规范标准 Base64 且只产生 ASCII 数字；未知字符、非规范 Base64、32 位新式 ID 和其他 opaque token 会被实验拒绝，但符合生产 parser 的 established opaque 值仍可作为扫描目标。

官方 URL allowlist 固定为 `https://y.qq.com/n/ryqq/profile/<identity>`、`https://y.qq.com/n/ryqq_v2/profile?uin=<identity>` 和 `https://y.qq.com/portal/profile.html?uin=<identity>`。解析器在 WHATWG 规范化前拒绝原始 authority 中的任何端口语义和原始路径中的 dot-segment（含编码变体），不访问 URL、不跟随重定向，并拒绝 HTTP、非精确 `y.qq.com` host、userinfo、fragment、非 profile path、缺失/空/重复 `uin`、任意 `id` 身份参数、额外查询参数和非法百分号编码。URL 中直接携带 EncryptUin 时 `resolution=local`，不获取 lease、Lane 或网络；直接数字或 URL 数字时 `resolution=network`，用户显式点击后由 `QQJobManager.resolveClassicEncryptUinInput` 经一条本机直连 Lane 的 lookup lease、Governor、TransportGate、4 秒超时与取消只访问固定 QQ 公开资料端点，获得 canonical EncryptUin 后用同一严格解码器对账。QQ Client 对这些请求设置 `redirect:"error"`，不会访问用户提供的 URL 或跟转到外域/私网。生产扫描使用独立 parser，可安全提取同一 allowlist URL 中的数字或 established opaque EncryptUin，但不要求 opaque 值可被本实验解码；正式评论/来源分页仍按任务配置使用代理池/静态代理并 fail-closed。scanner promise 建立后，普通 QQ/opaque 目标通过另一条独立 4 秒本机直连辅助 Lane 后台补全昵称和受信头像，补全失败或长期未返回都不阻塞评论扫描；`微信用户` 跳过补全，固定显示该称谓、元信息和默认头像。

用户可另行点击“在线正向验证”。loopback-only 的 `POST /api/qq/encrypt-uin/verify` 使用一条 4 秒有界的本机直连 Lane，分别以上一步得到的 canonical EncryptUin 和解码候选访问官方公开资料，同时比较 canonical EncryptUin、昵称和头像。三项全部一致才是 `match`，任一差异是 `mismatch`，缺失昵称/头像是不可验证的上游响应。响应只返回 `{format,identityKind,status,maskedIdentifier,checks}`，不返回完整候选值。解析和验证都不创建/修改扫描 generation；匹配只证明当次公开响应一致，不证明账号所有权或任何私密数据访问权。完整目标可按上述规则出现在可信本地界面，但不得进入日志、错误、诊断、导出文件名、真实文档示例或 Release 说明；测试只用合成数据。

## 分页与身份不变量

评论接口每页范围为 `1..25`，新任务默认 `25`；公开喜欢来源每页范围为 `1..500`，默认 `500`。两者属于不同接口，不能互相替代。

评论分页使用 SeqNo：下一页 cursor 必须来自响应原始顺序中最后一条已规范化评论。页内相等或局部乱序会被完整保留；恢复页的每一条 SeqNo 都必须严格小于请求 cursor，`HasMore` 空页或末值不后退则拒绝。此类 comment-page 协议错误只冻结当前歌曲且不推进 cursor，likes 中其他歌曲继续。

歌曲详情只能补充 MID、名称和艺人。Scanner 始终以用户请求的十进制 `requestedSongId` 建立 song 任务；ID 全程使用字符串，不能经过 JavaScript `Number`。

## Worker、Lane 与请求预算

同一歌曲始终只有一条在途 SeqNo 链。`song` 模式固定一个 Worker；顶部保存的 `hostConcurrency` 仍会显示，但不能绕过 SeqNo 依赖。`likes` 模式把 `hostConcurrency` 直接作为任务 Worker 总数，只并行不同歌曲；QQ GUI 和新恢复描述不再提供独立的 `workersPerProxy` 容量。选定出口后，Manager 自动派生 `workersPerLane = ceil(hostConcurrency / selectedLanes)`，因此单出口也能使用完整主机上限，所有选中 Lane 仍由共享分配器公平可达。

所有 Worker 共用一个 `LaneAllocator`。每个成功页重新公平获取健康 Lane，因此全部选中出口可参与轮转；普通故障保留原 cursor，并由健康 Lane 接力。`maxWorkers` 是主机级硬上限，不能通过裁掉后半段 Lane 实现。

每 Lane 的 Governor 把 `minDelayMs` 解释为同一出口相邻远端请求的真实最小启动间隔，Worker 数不会除掉它。QQ 新任务默认 `300 ms + U[0,100) ms`（300–399ms）；多个 Worker 只允许慢请求在不同歌曲间重叠。全任务共享 QQ TransportGate：song 固定一个在途，likes 总在途上限等于主机 Worker 上限（最大32），两者聚合启动间隔均至少50ms。8出口满页理论受20页/秒 Gate限制约500条/秒，4出口受出口节奏限制约286条/秒；实际还乘填充率/成功率并受网络影响。

QQ 扫描不保存或使用 QQ/网易云 Cookie。Dashboard 进入 QQ 工作区时，连接状态固定显示“本地服务”并隐藏网易云二维码登录按钮；已保存的网易云会话只能在网易云工作区呈现。

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

`GET /api/song/search?q=&limit=` 与 `GET /api/qq/song/search?q=&limit=` 返回同一 DTO：

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

`q` 去除首尾空白后必须为 `2..80` 字符，`limit` 必须为 `1..10`，默认 `10`。网易云使用 `cloudsearch` 的单曲类型。两个 Dashboard 搜索路由和对应纯数字歌曲详情路由都强制本机直连：服务端不读取代理池，也忽略请求伪造的代理字段。这个低频辅助通道只用于交互选歌；正式评论扫描仍使用配置的代理池/QQ Lane 且 fail-closed。

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

专项测试覆盖 Client、状态、writer、Scanner、CLI、代理、TransportGate、benchmark、严格歌曲搜索协议以及共享 QQJobManager 的接口联调。所有辅助资料查询测试必须覆盖空结果、畸形响应、超大字符串 ID、取消/lease 释放、4 秒上限，以及运行池与手动代理均被明确绕过；正式评论/来源扫描继续覆盖代理失败不直连。身份展示/解析测试覆盖合成的直接数字（含 19 位）、可逆 8/12/16 与 28 字符 Token、不可逆 opaque 输入和三个官方 URL；必须证明正式 start 的数字 canonical 解析与 post-scanner 资料补全也固定直连、opaque canonical 本地零请求、补全不阻塞 scanner、微信用户不发补全请求且保持固定展示，并覆盖 URL/Base64/网络拒绝边界、在线 match/mismatch、generation 不变和错误/文件名脱敏。真实 QQ CGI 是非公开且可能变化的上游，低频实网只能作为兼容性观察，不能替代确定性测试。
