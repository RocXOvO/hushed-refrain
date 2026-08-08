# QQ 音乐评论查询接入设计

状态：`v0.20.0` QQ 接入采用的历史设计记录；下述并发数已同步到当前动态 Gate，但实现真值以 `qq-music-architecture.md` 与测试为准

目标基线：`main` / `v0.19.0` / `68b9810a6d721fb66c8fb6f6637e86012f2e604e`
QQ 参考实现：实施时仅从 `../ncm-comment-finder-main` 的 v0.12 纵向切片提取 QQ 领域行为，未合并旧共享入口

## 1. 目标与非目标

本轮目标是在当前 `v0.19.0` 主线上加入 QQ 音乐公开评论查询，同时完整保留 v0.13–v0.19 已发布的网易云、代理池、检查点、报告、桌面更新和低开销 UI 行为。

首发支持：

- 目标身份输入：数字 QQ 号、QQ 音乐个人主页 URL、`EncryptUin`。
- 任务模式：指定 QQ 歌曲扫描；公开“我喜欢”歌曲来源扫描。
- 精确匹配评论作者的完整 `EncryptUin`。
- 多出口故障切换、跨歌曲并发、停止/冷却/恢复、原子检查点、JSONL 去重。
- Dashboard 四个任务视图、实时结果、活动、日志、结算、恢复描述符。
- Windows 升级前识别并安全停止 QQ 活跃任务。
- QQ 结果的完整报告与 PDF 导出，遵守现有生成绑定和安全链接规则。

本轮不实现：

- QQ 扫码登录、Cookie/musickey 持久化、私密“我喜欢”。
- 未经验证的 QQ 公开听歌记录来源。
- 同一首歌曲的时间分片或多页并发。
- 把 QQ 与网易云状态、结果或完整覆盖账本混在同一个文件中。
- 高频 QQ 实网压力测试。

## 2. 基线与迁移判断

QQ 参考实现已经覆盖 QQ Client、SeqNo 扫描器、代理 CONNECT、检查点、结果 writer、CLI、Server/Dashboard 和专项测试，但它建立在 `v0.12.0` 上。当前主线已经新增：

- 网易云 target-owned liked playlist 双重 owner/目录完整性验证；
- source state v3、target-v3 canonical JSONL 与完整歌曲覆盖账本；
- hard-capped Worker topology、共享 LaneAllocator 和 AIMD 代理传输；
- CheckpointCoordinator、ResultAccumulator、实测速率与校准估算；
- generation-bound 完整报告/PDF；
- 更严格的 Mihomo 进程所有权、原子写与 Windows 恢复；
- 稳定活动行、Inspector/滚动条和渲染节流优化。

因此禁止整体合并旧 QQ 工作树，也禁止用旧版 `server.ts`、`web/*`、`AGENTS.md` 覆盖主线。迁移采用“QQ 专属模块移植 + 共享入口按 v0.19 重新接线”。

## 3. 架构决策

### 3.1 平台是产品边界，不是扫描器继承层级

网易云和 QQ 只共享基础设施，不共享分页算法或状态模型：

```text
CLI / Dashboard / Electron
            |
            v
   全局 TaskCoordinator
       /             \
      v               v
NetEase Managers    QQJobManager
      |               |
cursor/time-shard   SeqNo-per-song
      |               |
      +-------+-------+
              v
共享基础设施：代理池选择、Governor、LaneRecovery、原子文件、
日志、HTTP/SSE、结果快照、报告导出、更新前安全停止
```

不新增一个声称能统一 `cursor-v1` 与 `seqno-v1` 的通用 Scanner 接口。平台差异保留在各自领域模块中；共享层只消费稳定的任务快照、活动事件和结果 DTO。

### 3.2 运行时模块边界

| 边界 | 所有权 | 规则 |
| --- | --- | --- |
| `src/qq-music/**` | QQ 领域 | Client、类型、SeqNo 扫描、状态、结果 writer、QQ Gate、代理 fetch、benchmark。不得依赖 Server 或 DOM。 |
| `src/qq-cli.ts` | QQ CLI | 只组装 direct Lane 和 QQ 领域模块，不复刻 Dashboard manager。 |
| `src/qq-job-manager.ts` | QQ 应用层 | 负责任务输入、路径、Lane 构造、快照、日志、generation、订阅和全局 lease；避免继续扩张已经很大的 `server.ts`。 |
| `src/server.ts` | 共享 HTTP 组合根 | 实例化 manager、注册 `/api/qq/*`、平台化 resume/log/report/estimate，不拥有 SeqNo 算法。 |
| `web/*` | 共享展示层 | 用 `platform:mode` 选择视图；不解释检查点完成语义，不对每行发元数据请求。 |
| `src/result-report.ts` | 共享安全报告 | 接受平台判别后的可信记录；分别重建网易云/QQ 链接，不信任 JSONL 中的任意 URL。 |

`QQJobManager` 直接在独立文件按 v0.19 行为重写。donor 中内嵌于 `server.ts` 的旧 manager 只能作为行为样本，不能先复制进新 Server：它缺少 hard cap、稳定活动行、generation-bound results/report 和 v0.19 的速率/页面性能跟踪。

### 3.3 任务视图与 API

视图主键固定为：

```text
netease:parallel
netease:source
qq:song
qq:likes
```

QQ HTTP 面：

> 本节是 v0.19 接入时冻结的历史清单。当前实现后来增加了 lookup-only 的 `GET /api/qq/song/search`；现行接口与安全约束以 `qq-music-architecture.md`、`qq-music-memory.md` 和测试为准。

- `GET|POST /api/qq/job`
- `POST /api/qq/job/stop`
- `GET /api/qq/results?jobId=<uuid>`
- `GET /api/qq/results/stream?jobId=<uuid>`
- `GET /api/qq/song`
- `GET /api/qq/song/search`
- `GET /api/logs?mode=qq&jobId=<uuid>`
- `GET /report/results?platform=qq&mode=song|likes&jobId=<uuid>&targetKind=encryptUin&target=<canonical>`

现有网易云路径继续兼容。QQ results 返回 `{ generation, results }`，SSE 发送带 generation 的 envelope，logs 返回或验证同一 generation；裸评论 SSE 不满足隔离要求。generation 至少绑定 `platform + mode + jobId + canonicalTarget + outputPath`。视图切换期间的旧 REST/SSE/log 回调按完整 viewKey 与 jobId 丢弃。

### 3.4 全局任务互斥

`TaskCoordinator` 的 mode 扩展为 `source | parallel | qq | pool`。QQ 身份解析、歌曲查询和扫描启动都必须通过 `qq` lease；任何 setup 失败、异步终态或取消路径都幂等释放。Manager 在 lease 获取后立刻建立可停止句柄，目标解析、代理准备和来源发现也属于同一可取消生命周期，不能等 Worker 启动后才允许停止。

客户端按钮禁用只是 UX，HTTP 409 和全局 lease 才是正确性边界。更新安装前必须停止真实的全局活跃 manager，而不是当前可见视图。

## 4. QQ 领域冻结契约

### 4.1 身份与来源

- 数字 QQ/主页 URL 通过公开资料接口解析为 `EncryptUin`；直接输入 `EncryptUin` 原样使用。
- 评论作者只做完整 `EncryptUin` 相等，不解密、不猜测、不转回 QQ 号。
- `song` 使用一个十进制歌曲 ID；`likes` 只发现公开“我喜欢”。
- 公开资料隐藏或喜欢列表受限时明确报告来源错误，不伪造空覆盖。

### 4.2 分页

- 评论接口为 `GetNewCommentList`。
- 评论 `pageSize` 新任务范围 `1..25`，默认 `25`。
- 喜欢来源 `likedPageSize` 范围 `1..500`，默认 `500`，两者不可混用。
- `HasMore=true` 必须返回非空十进制 `nextCursor`；从第二页起，响应中的每一条 SeqNo 都必须严格小于请求游标。
- 下一游标的权威来源是响应原始顺序中最后一条已规范化评论的 `SeqNo`。页内相等或局部乱序允许并全部处理；跨页不后退则整页不提交并隔离该歌曲，不猜测排序或取最小值。
- 同一歌曲始终最多一个在途评论页。并发只发生在不同歌曲之间。
- 只有成功且协议完整的页才能推进 `cursor/pageNo`；普通失败和 Lane 故障保留原游标。
- `requestedSongId` 始终是 song 任务主键。歌曲详情响应只能补充 MID、名称和艺人；不得替换任务歌曲 ID，也不得用 JavaScript `Number` 转换十进制 ID。

### 4.3 代理、限速与取消

- 一条 `QQCommentLane` 拥有一个 Client、一个 Lane 专属 Governor，并引用任务唯一的 QQ TransportGate。
- 生产 Governor 直接使用每出口最小请求启动间隔；`workersPerLane` 只增加跨歌曲候选工作，不能缩短它。QQ 新任务默认300–399ms。
- QQ Gate 按主机 Worker 容量构建：`song` 固定1个在途，`likes` 采用 `hostConcurrency` 的1–32容量，两者聚合发车至少间隔50ms。它与网易云 AIMD策略不同，但都不能弱化单 Lane Governor。
- QQ likes 的唯一 GUI Worker 容量为 `hostConcurrency`；Manager 选定 Lane 后自动派生 `workersPerLane = ceil(hostConcurrency / selectedLanes)`。Worker 是 invocation-local `worker-N`，每页通过共享 `LaneAllocator` 公平取得 Lane，单 Lane permit 不超过派生值。禁止通过裁掉后半段 Lane 实现 hard cap，单 Lane 也不得把主机容量缩成 1。QQ song 无论配置如何都只有一个活动 Worker/SeqNo 链，但每个成功页仍公平换 Lane。
- 自动出口 `maxProxyLanes=0` 使用全部已验证出口；正数才是本任务上限。现有共享池不因任务选择而缩容或重建。
- 首发不增加强制 QQ 启动探针：共享池的“已验证”只表示现有出口/网易云检查，UI 不得宣称已验证 QQ 域。每次 QQ 请求仍独立 fail-closed；Lane 连续最终失败达到阈值后在本任务下线，全部 Lane 不可用时明确 `paused` 并保留检查点。未来 QQ capability probe 只能按 pool generation 低频缓存于任务侧，不能回写或缩减共享池。
- HTTP/HTTPS 代理必须 fail-closed。CONNECT 拒绝、超时、取消或永久代理错误不得回退本机直连。
- 一个任务的 AbortSignal 贯穿队列、LaneRecovery、Governor、Gate、Client 与底层 fetch；停止后不得迟到发起请求或推进页状态。
- GUI 的正数 `requestBudget` 冻结为任务级 logical comment-page 预算，不按 Lane 拆分或倍增；来源/身份/元数据控制请求与 Governor 内部 retry attempt 分开计数并展示。`0` 仍表示无限。

### 4.4 错误分类

- 普通网络/可重试上游失败：原工作重排，Lane 指数退避。
- 永久代理 4xx（不含限流/可重试状态）：只下线该 Lane，原游标交给健康 Lane。
- `403/429`：按 Governor 冷却语义结算并保留工作。
- QQ 协议、业务 code/subcode、结构或游标错误：全局 `paused`，不把错误响应当空页完成。
- 只有明确歌曲资源 HTTP `404/410`：该歌 `done + truncated`，整体 coverage 仍不完整。
- 用户取消：`stopped`；启动解析阶段的取消/冷却也不能降级为通用 `error`。
- v0.19 的 `RequestExecutionError` 必须保留原始 `cause`，`errorStatus`/QQ 分类遍历 cause 链；禁止解析错误字符串。必须用回归测试区分代理 CONNECT 407/404、歌曲资源 404/410、QQ API/协议错误。
- Governor 的 NetEase `301 -> AuthenticationRequired` 不能无条件应用于 QQ。通过明确平台策略启用/禁用该映射；QQ 业务码 301 只能按 QQ 契约处理，不能弹网易云重登提示。

### 4.5 活动、速率与完成事件

- 评论请求 `start` 必须带 ISO `startedAt`；`success` 带本页 comments 数，`failure` 带可分类状态。配置 Worker/Lane、实际参与的唯一 Worker/Lane 和同时在途峰值是三个不同指标。
- 新增轻量 `QQMusicSongActivity`/`onSongProgress`：至少含 songId、名称、pages、comments、可选 total、done、truncated。请求事件负责瞬时 Worker/耗时，歌曲事件负责稳定活动行的进度和完成移除。
- `QQJobManager` 复用 `CommentRateTracker` 与 `PagePerformanceTracker`，只消费成功的 `comment-page`，不得让 resolve、likes discovery 或元数据控制请求污染读取速度和估算校准。

## 5. 持久化与兼容

QQ 状态和结果位于独立命名空间：

```text
data/qq/state-<stable-task-key>.json
data/qq/comments-<stable-task-key>.jsonl
data/logs/qq-<job-id>.jsonl
```

`stable-task-key` 使用规范化的 `mode + canonical EncryptUin + requestedSongId（仅 song）` 生成不泄露身份的 hash；Dashboard 与 CLI 使用同一规则。不得隐式探测 donor 的扁平旧路径。

状态标识：

```json
{
  "version": 1,
  "kind": "qq-comment-scan",
  "commentPagination": "seqno-v1"
}
```

不读取网易云 target-v3 文件，不把 QQ 歌曲写入 `song-coverage`，也不复用网易云时间游标。

持久化顺序：

1. 规范化并匹配本页评论；
2. 新命中通过长期持有的 `FileHandle.write` 追加，并在 `sync()` 成功后才视为耐久；
3. 再次检查任务取消信号；取消发生在响应/JSONL 与状态提交之间时允许 JSONL 领先状态，但禁止推进 cursor；
4. 同步提交页计数、`seenCommentKeys`、cursor 和完成标记；
5. 注册并等待对应 checkpoint revision；
6. 释放页槽位并决定是否重新入队。

没有证据证明 QQ `CmId` 跨歌曲唯一。去重域冻结为结构化 `(songId, commentId)`，内部可编码为经过验证的 `songId:commentId`；JSONL 仍分别保存原始 songId/commentId。状态首次发布即使用 `seenCommentKeys`，不发布未经证明的 task-global `seenCommentIds` 语义。

`song` 每成功页立即原子保存。`likes` 评论页采用 400 ms 或 4 个脏页先到者刷盘，并以动态 Gate 容量相同的有界 pre-request 槽位限制崩溃重放窗口；所有终态强制 flush。首次持久化失败锁存全局 paused，取消剩余请求，不进行保存风暴。

状态解码可读旧 `pageSize=1..100`；扫描器在任何远程请求或 finished 早退前先把 `26..100` 单向持久化为 `25`，保留每曲 SeqNo、pageNo、命中键和 JSONL。迁移保存失败时远程请求数必须为零。Decoder 还必须验证：任务 pages/comments 等于歌曲求和、`truncated => done`、createdAt/updatedAt 是有效 ISO、song 模式基数与 requestedSongId 一致。`onCheckpoint` 若发生在原子写前只能称 live snapshot，不能冒充 durable ack。

`resume-task.json` 当前为 v3 平台化描述符并带 `requestIntervalSemantics:"per-start-v1"`。旧 NetEase v1/v2 在锁内一次性等价换算并写回；旧 QQ v2 自定义间隔原样保留。恢复只回填安全 allowlist，所有 fresh 关闭，不自动启动，不保存凭据或改变检查点。

## 6. 结果、报告和安全

- QQ 结果至少包含 `platform:"qq"`、目标 `EncryptUin`、歌曲 ID、评论 ID/SeqNo、作者 `EncryptUin`、正文和捕获时间。
- MID、歌名、艺人、发布时间和统计字段可缺失；链接优先 MID，缺失时回退数字歌曲 ID。
- Live API 继续使用有界 tail；完整报告使用固定字节截止点的完整快照，二者不可互换。
- 导出请求冻结为判别联合：NetEase `{platform:"netease",mode:"source"|"parallel",jobId,target:{kind:"uid",value}}`；QQ `{platform:"qq",mode:"song"|"likes",jobId,target:{kind:"encryptUin",value}}`。不得把 QQ target 塞入 uid 字段。
- QQ target 必须来自该 generation 的 canonical EncryptUin，不得使用遮罩值、当前表单值或原始主页 URL。报告在异步读取前后验证 `platform + mode + jobId + canonicalTarget + outputPath`。
- 报告 HTML 对用户/上游字段全部转义；只从已验证的 MID 或十进制 song ID 重建 QQ 官方链接，不信任持久化的任意 URL。
- Electron PDF IPC、route query 和报告 meta 使用同一判别 DTO；隐藏窗口在 fonts-ready 后复核 platform/mode/jobId/target。load/fonts/print/write 分别有界：未提交的写入可取消，已进入 OS rename 时保持目标路径锁直到结算，使同路径重试最后提交且不被旧写入覆盖；保存、取消和失败都有明确反馈，诊断只记录稳定阶段/错误码。文件名只使用平台与遮罩标识，不泄露完整 EncryptUin。仍不接收任意路径、URL、HTML 或打印参数。
- 代理凭据、Cookie、状态、结果和日志都不得进入 Release 或测试输出。

## 7. Dashboard 设计

- 在现有平台/模式选择中加入 QQ：`song` 与 `likes`；不展示 QQ 不存在的听歌记录模式。
- 保持 v0.19 的任务抽屉、中央结果/活动/日志/代理/估算、右侧 Inspector 和滚动条布局，不从旧工作树覆盖 CSS。
- QQ 单曲文案明确“1 条活动 SeqNo 链”；多出口表示轮转/故障切换，不表示同曲并行。
- QQ likes 的 Worker 是跨歌曲调度 Worker；显示 configured lanes/workers 与本轮实际参与 lanes/workers，不把它们当同时在途峰值。
- 活动行复用 v0.19 的 keyed/bounded/in-place 更新、64 行工作集和单例计时器；QQ manager 通过请求事件与歌曲进度事件对齐现有行模型，不在 renderer 里另建轮询器。`done/truncated` 必须移除稳定行。
- 结果表使用平台判别渲染链接和身份；旧视图的 SSE、日志、结果和估算响应不得污染新视图。
- 估算 API 必须显式平台化；QQ 评论拒绝 `pageSize>25`，song 使用 `serialRequestChain=1`，likes 按 host/lane 自动派生每 Lane permit。两平台都把 `minDelayMs` 当同 Lane 字面启动间隔，QQ 使用50ms聚合 Gate和与主机 Worker 上限一致的检查点槽位。
- `latestJobs`、result generation、settlement、REST/SSE/log/estimate guards 全部按完整 viewKey 保存；不能把 qq:song 与 qq:likes 折叠成一个前端 mode。现有 tabSwitchVersion、Inspector、窄屏媒体监听、滚动条、SSE batching 和单飞轮询保持原样。

## 8. 实施阶段与门禁

### 阶段 A：QQ 领域移植

- 移植 `src/qq-music/**`、`src/qq-cli.ts`、benchmark、QQ 专项测试和 QQ 专用文档。
- 适配 v0.19 的 `atomic-file`、Governor cause/平台策略、LaneRecovery、Worker topology/LaneAllocator 与 TypeScript 配置。
- 先跑 QQ 专项 check/test/build/benchmark；禁止实网进入常规测试。

### 阶段 B：共享入口接线

- 扩展 TaskCoordinator、错误/日志类型、代理 Lane 选择和 estimator。
- 接入 QQJobManager、HTTP/SSE/results/logs/resume/update-stop。
- 接入四视图 Dashboard，但只增量修改 v0.19 DOM/CSS/renderer。
- 以 Server/Manager 行为测试证明全局互斥、输入边界、hard cap 且全 Lane 可达、generation 隔离、歌曲完成事件、启动阶段 stop/cooldown 和 fail-closed。

### 阶段 C：报告与完整集成

- 扩展结果报告和 PDF 到 QQ，保持现有 IPC 安全边界。
- 更新 README、`AGENTS.md` 与 QQ 专用记忆，删除旧 v0.12 共享事实。
- 运行完整 `npm run check`、`npm test`、`npm run build`、`npm run bench:qq`、`node --check web/app.js`、`npm run desktop:smoke:mac`、`git diff --check`。
- 做本地真实浏览器 QA：四视图切换、25/500 输入边界、结果/SSE/log generation、稳定活动行、停止、恢复 adjustment、报告/PDF、窄宽度、Inspector/滚动条和 console。
- 只在用户明确要求时做少量 QQ 实网验证。实施阶段的历史约束是未经新授权不自行提交、推送或发布。

## 9. 实施与复审决议

- QQ 领域最终以独立模块逐项移植。shared 代码只做符号/行为移植，未整文件复制旧 Server、web、README、AGENTS、Governor、LaneRecovery、estimate、task coordinator/log 或旧 shared tests。
- 首发采用现有共享池 + QQ 请求自身 fail-closed，不强制启动探针；能力提示必须准确，全部 Lane 失败有明确终态。
- QQ 评论去重域冻结为 `(songId, commentId)`，状态使用 `seenCommentKeys`。
- v0.19 source v3、target-v3、AIMD、hard-capped NetEase Workers、报告/PDF、Mihomo 生命周期和 UI 性能/布局不变量均优先于 donor 行为。
- 四视图可以保留全部 v0.19 能力，但只有在 generation envelope、判别导出 DTO、QQ hard cap、歌曲进度/完成事件和 resume adjustment marker 均实现并有测试后，才视为共享接线完成。
