# QQ 音乐性能复审

## 结论

当前实现的主要吞吐来源是更多独立出口、跨歌曲 Worker 和更大的公开喜欢来源页；不会用同曲并发或提高单 IP 请求频率换速度。离线模型保持同歌峰值并发为 1，并把 QQ Gate、Lane pacing、Worker hard cap 与 checkpoint 槽位分别计入。

## 冻结参数

| 参数 | 当前语义 |
| --- | --- |
| 评论 `pageSize` | 默认/最大 25 |
| 喜欢来源 `likedPageSize` | 默认/最大 500 |
| 单 Lane 启动周期 | 默认 3000 ms + 平均 jitter 输入 |
| QQ song Gate | 1 个在途，启动间隔至少 250 ms |
| QQ likes Gate | 总在途上限=`min(实际 Worker 容量, 32)`；启动间隔=`max(80, ceil(1000/max(4, 上限))) ms` |
| likes checkpoint | 400 ms 或 4 个脏页，先到者触发 |
| 未持久页槽位 | 与本任务动态 Gate 总在途上限一致 |
| 同一歌曲在途页 | 最大 1 |
| Worker hard cap | `maxWorkers`，范围 1..32 |

## 离线模型

`src/qq-music/benchmark.ts` 是确定性的 delay-bound 模型，`scripts/benchmark-qq-music.ts` 只计算模型，不访问 QQ 音乐。输入区分 `song` 和 `likes`，输出包括页/秒、评论/秒、请求数、同歌最大并发、Lane 参与数、Worker 数、checkpoint 写入数/字节和喜欢来源耗时。

模型刻意保守地区分：

- 每 Lane 的 Worker 不增加该出口的启动速率；慢请求可以在跨歌曲 Worker 间重叠。
- `song` 只有一条串行链；多 Lane 通过成功页轮转改善 delay-bound 吞吐和故障可用性。
- `likes` 受 Worker、歌曲数、动态总 Gate 和同容量 checkpoint 槽位共同限制。每 Lane 的 Governor concurrency 仍为 1，默认启动周期仍为 3000 ms + jitter。
- checkpoint 控制写入与评论页写入都计入总耗时。

## 当前量化结果

在脚本固定输入 `minDelay=3000 ms`、平均 jitter `500 ms`、网络 `150 ms`、checkpoint `20 ms` 下：

- song、25 评论/页：8 个出口相对 4 个出口的模型评论吞吐为约 `1.99947x`。
- 同为 4 个出口时，合法的 25 评论/页相对 1 评论/页在模型中为 `25x`；这只是页容量对比，不是旧版本基线。
- 单出口、25 评论/页约为 `7.1495 comments/s`。
- 32 个实际 Worker 的 likes 场景中，动态 Gate 32 相对旧固定 Gate 4 的模型吞吐约为 `2.2058x`（约 `214.58` 对 `97.28 comments/s`）；这是给定模型输入下的容量差，不是线上 SLA。
- 1000 首公开喜欢来源从 100/页的 10 次请求降至 500/页的 2 次请求，来源请求与 delay-bound 等待均减少 `80%`。
- 模型和 Scanner 测试都冻结 `maxSameSongConcurrent=1`。

评论端上游实际最大值是 25，因此不存在 50→100 评论页带来的 2x/4x 收益；任何此类旧估算都无效。

## 已处理的瓶颈

- likes 不再每页完整 pretty JSON + fsync；改为 400 ms/4 页有界合并。
- 与动态总 Gate 同容量的 pre-request 槽位把故障时可能回放的未 checkpoint 页面限制在有界范围，同时避免固定 4 槽成为高 Worker 拓扑的额外瓶颈。
- JSONL writer 长期持有 FileHandle，串行追加并仅在结果记录后 `sync()`，避免每条重复 open/close。
- LaneAllocator 允许 hard-capped Worker 访问全部 Lane，避免只使用前几个出口。
- task-level logical page budget 不按 Lane 倍增，失败换 Lane 也不会重复消耗。
- Lane 恢复唤醒复用可取消的 `LaneRecovery.waitUntilReady(taskSignal)`；停止或队列关闭会清理内部 timer，避免 CLI 延迟退出和桌面端迟到计时器累积。
- 活动事件区分总耗时与网络耗时，便于定位 Governor 等待、网络、checkpoint 或展示层瓶颈。

## 风险与后续观测

- QQ CGI 是非公开上游，真实业务码、公开权限和字段结构可能变化；不能用提高实网测试频率来弥补契约不确定性。
- song 模式逐页 checkpoint 优先保证精确恢复；若未来证据表明它成为主要瓶颈，需要先设计有界回放与故障测试，不能直接改为无保护异步写。
- benchmark 是容量模型，不是 SLA。实际吞吐还受代理出口质量、上游延迟、评论密度、磁盘和冷却影响。
- GUI 默认 `requestBudget=0` 由共享 Manager 负责；CLI 默认 250。性能判断应同时记录任务模式、Lane/Worker 配置、实际参与 Lane/Worker、峰值在途和 checkpoint 写入情况。
- 搜索与歌曲详情属于短暂控制请求，走 Manager 的单请求 `song` profile，不参与评论 benchmark，也不能修改扫描 generation 或用搜索时延推断扫描吞吐。

## 复验命令

```bash
npm run bench:qq
node --import tsx --test test/qq-music-benchmark.test.ts test/qq-music-scanner.test.ts
```

本文只记录 QQ 性能模型与专项复验方法；它不是整树门禁、Git 提交、GitHub Release 或客户端资产的发布证明。
