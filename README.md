<div align="center">
  <img src="web/app-icon.png" width="96" alt="云评检索台图标">
  <h1>云评检索台</h1>
  <p>通过网易云音乐用户 UID 定位其在公开歌曲下发布的评论。</p>
  <p>
    <a href="https://github.com/RocXOvO/ncm-comment-finder/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/RocXOvO/ncm-comment-finder?style=flat-square"></a>
    <a href="https://github.com/RocXOvO/ncm-comment-finder/actions/workflows/windows-package.yml"><img alt="Windows package" src="https://img.shields.io/github/actions/workflow/status/RocXOvO/ncm-comment-finder/windows-package.yml?style=flat-square&label=Windows%20package"></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square">
    <img alt="Windows and macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-59636e?style=flat-square">
  </p>
</div>

---

云评检索台会先从目标用户的公开听歌排行和喜欢列表收集候选歌曲，再使用时间游标逐页读取评论，按 `comment.user.userId` 精确匹配目标 UID。它同时提供桌面客户端、本地 Web 控制台和 CLI，并支持断点续跑、多出口并发、实时结果与结构化调试日志。

> [!IMPORTANT]
> 请只在合法、合理的场景中查询公开数据，尊重用户隐私、平台规则与请求频率。该工具不能绕过私密的听歌排行或喜欢列表，也不保证找到用户的全部历史评论。

## 功能一览

- **两种检索路径**：按用户来源扫描多首歌，或对已知歌曲做时间分片并行扫描。
- **断点续跑**：歌曲游标、分片进度、请求数和冷却时间都会原子化写入 JSON 检查点；Windows 文件短暂占用会自动重试，并可从已完整写入的遗留临时文件恢复。
- **自适应页级调度**：Worker 每次只处理一页；用户来源只剩一首歌时也会把未读时间范围拆给多个出口，减少扫描后期的并发长尾。
- **独立出口代理池**：可勾选一套或多套 Clash Verge 配置合并优选，或导入其他 HTTP/HTTPS 代理。
- **实时可观测**：展示当前歌曲/页数、累计请求、命中数、出口延迟与实时评论。
- **任务结算**：完成、暂停、冷却、停止或失败后，统一展示本轮耗时、累计命中、页数和请求数。
- **结构化日志**：逐页记录请求开始、成功、耗时、读取条数、失败以及 `403/429` 风控/限流。
- **Windows 应用内更新**：启动时检查最新 Release，下载后校验 SHA-512；安装前先保存扫描检查点，新版可继续未完成任务。

## 下载

从 [GitHub Releases](https://github.com/RocXOvO/ncm-comment-finder/releases/latest) 下载与设备匹配的最新正式版：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `NCM-Comment-Finder-Setup-<version>.exe` | NSIS 安装器，支持应用内自动更新 |
| macOS 11+ Apple Silicon | `NCM-Comment-Finder-<version>-arm64.dmg` | M1/M2/M3/M4 等 Apple 芯片 |
| macOS 11+ Intel | `NCM-Comment-Finder-<version>-x64.dmg` | Intel Mac |

macOS 包目前使用 ad-hoc 签名，未经 Apple Developer ID 公证；这与 Windows 的应用内更新能力不同。Windows Release 必须同时包含安装器、`.exe.blockmap` 和 `latest.yml`，缺少任一文件都不应发布。

## 快速开始

1. 安装并启动“云评检索台”。
2. “喜欢歌曲”来源必须使用有效的网易云登录会话；点击右上角“二维码登录”完成授权。未登录会在启动前提示，失效会话收到 301 时也会立即停止，不会换代理重复请求。
3. 从网易云音乐用户主页链接中复制 `id=` 后的纯数字 UID。
4. 在“多 IP 池”中勾选 Clash Verge 配置并执行“自动优选”。Clash Verge 客户端无需开启系统代理或 TUN；工具会读取配置并启动自己的 Mihomo 进程。
5. 选择“用户来源”，先点击 UID 右侧的查询按钮，确认听歌排行/喜欢列表可读。
6. 选择歌曲来源并开始扫描。新命中会立即出现在“实时结果”。

UID 是用户主页的数字 ID，不是昵称。例如：

```text
https://music.163.com/#/user/home?id=123456789
                                      └─ UID
```

### 扫描模式怎么选

| 模式 | 适用场景 | 调度方式 |
| --- | --- | --- |
| 用户来源 · 听歌排行 | 不知道具体歌曲，优先查用户常听内容 | 候选歌曲按页轮转；剩余歌曲不足时自动时间分片 |
| 用户来源 · 喜欢歌曲 | 听歌排行不可读或需要补充范围 | 喜欢列表去重后按页轮转，支持单曲尾部并行 |
| 用户来源 · 两者 | 希望扩大候选歌曲覆盖 | 先排行，再补入喜欢列表 |
| 单曲并行 | 已知歌曲 ID，且评论区很大 | 时间分片 + 多出口 + 页级重新入队 |

用户评论历史接口只适合查询当前登录账号本人。CLI 的 `--strategy auto` 只在登录 UID 与目标 UID 相同时转入该路径；查询其他用户时使用公开歌曲评论精确匹配。

## 并发、后期降速与风控

每个代理出口是一个 Lane，同一 Lane 上的所有 Worker 共享一个 `RequestGovernor`。例如“4 个 IP × 每 IP 3 并发”会创建 12 个 Worker，但每个 IP 的起始间隔仍由共享限速器统一管理。

早期版本会让 Worker 一直扫完一首歌或一个时间分片。评论密度不均时，后期只剩少数“大任务”，其他 Worker 会提前退出，看起来像请求被风控。当前版本改为**一页一个工作项**：处理完一页后重新入队；无论单曲并行还是用户来源，检测到空闲 Worker 时都会把未读范围拆成互不重叠的半开时间区间。因此只有一首候选歌时，首页确定下一游标后也会立即让多个代理出口并行扫描剩余范围。

仍可能出现合理降速：

- 未完成页面已少于 Worker 数，任务正在自然收尾。
- 某些出口网络失败，未完成工作已转移给健康出口。
- 远端返回 `403/429`，对应出口进入冷却；用户来源在所有出口都受阻时会保存恢复时间。
- 实际网络延迟高于请求起始间隔。

打开“运行日志”可以直接区分这些情况。`page_success` 表示成功读取；`page_failure` 表示网络/业务失败；`rate_limited` 表示明确收到风控或限流信号；`adaptive_split` 表示调度器发现空闲线程并拆分剩余任务，它不是风控。

## 代理池

桌面界面可以自动发现 Clash Verge 的配置和 Mihomo 内核，默认从 48 个候选节点中优选 8 个出口。可以勾选任意一套，也可同时勾选多套；合并时会在不同配置之间公平轮转、去除重复节点并安全改名重名节点。也可切换到“其他代理池”，每行导入一个 HTTP/HTTPS 代理。

多配置会生成一份临时配置和一个独立 Mihomo 进程，不会要求开启 Clash Verge 的系统代理或 TUN。当前只合并已物化的内联叶子节点；含 `proxy-providers` 或 `dialer-proxy` 链式依赖的配置会明确拒绝，避免静默丢节点或生成无效引用。

优选不只比较完整 IP，还会限制网络前缀：

- IPv4：同一 `/24` 只保留延迟最低的一个出口。
- IPv6：同一 `/48` 只保留延迟最低的一个出口。
- 每个入选出口都必须通过公网 IP 检查和网易云评论接口实测。

如果不同网段的可用出口不足，工具会取消构建，不会用同网段 IP 强行补齐。代理池在空闲时每约 60 秒重新验证出口和延迟；启动任务可复用 90 秒内且仍满足独立网段的验证结果，过期或异常节点仍会完整复核。扫描任务运行时暂停后台复测，避免额外请求绕过当前限速。

CLI 示例：

```powershell
# 从 Clash Verge 配置构建 8 个网络前缀互异的出口
npm run start -- proxy-pool start --size 8 --candidates 48

# 合并两套配置（--source-config 可重复）
npm run start -- proxy-pool start --source-config C:\path\a.yaml --source-config C:\path\b.yaml

# 查看或停止工具管理的代理池
npm run start -- proxy-pool status
npm run start -- proxy-pool stop
```

> [!NOTE]
> 代理池文件会保存在本地并被 Git 忽略。含账号密码的代理 URL 不会通过 GUI API 原样返回。已托管 Mihomo 进程在停止前会校验命令行与配置路径，避免 PID 复用时误杀其他进程。

## 结算、日志与本地数据

每个 GUI 任务都有独立 UUID。开始时间从服务端接受任务起计算，结束后 `elapsedMs` 会冻结，后续轮询不会让耗时继续增长。结算画面按“检索模式 + 任务 UUID”只展示一次，覆盖 `complete`、`matched`、`paused`、`cooldown`、`dry-run`、`stopped` 和 `error`。

需要注意两个口径：

- **累计命中**：来自当前检查点，包含前几次续跑已保存的结果。
- **本轮耗时**：只属于当前任务 UUID，不累加过往运行时间。

日志以 JSONL 存储，每行一个结构化事件。内容不记录 Cookie 或代理密码。桌面客户端将数据写入 Electron `userData` 目录；从源码运行 Web/CLI 时使用项目内的以下目录：

| 路径 | 内容 |
| --- | --- |
| `data/*.json` | 用户来源或单曲分片检查点 |
| `data/*.jsonl` | 命中评论，按 `commentId` 去重 |
| `data/logs/<mode>-<uuid>.jsonl` | 任务调试日志 |
| `data/resume-task.json` | 最近一次 GUI 任务的非敏感表单参数 |
| `.ncm/cookie.txt` | 二维码登录会话 |
| `.ncm/proxy-pool.json` | 当前代理池状态与验证结果 |

这些路径都不应提交到 Git。

### 更新时如何保留扫描进度

Windows 客户端下载完更新后，如果扫描仍在运行，“重启并安装”会变为“保存进度并重启”。客户端会先停止新的页面调度，等待当前任务写完强制检查点，再交给安装器重启；45 秒内无法确认落盘时会取消安装，避免带着不确定状态退出。

任务参数和扫描状态都保存在 Electron 的同一个 `userData` 目录，不随应用版本替换。新版启动后会自动恢复上次模式、UID、歌曲 ID 与并行参数；保持“新建状态”关闭并再次开始，即可从相同检查点继续。极端退出情况下可能重复少量尚未确认的在途页面，JSONL 仍按 `commentId` 去重，不会重新扫描已标记完成的歌曲或分片。

## 分页与检查点语义

- 歌曲评论使用 `comment_new` 降序时间游标，默认每页 1000 条，可配置范围为 `1..2000`。
- `hasMore=true` 时，下一游标必须严格向过去推进。空页但游标有效时会继续；游标缺失或不前进时保留可续跑状态，不会误报完成。
- 修改每页条数后不能直接恢复旧游标；请勾选“新建状态”或使用 `--fresh`。
- 用户来源检查点为 version 2，会持久化每首歌的未完成时间分片；新版仍能读取 version 1 的单游标断点，且 GUI 并行或 CLI 串行入口都能继续分片状态。
- 从旧 `comment_music` offset 检查点迁移时，已完成歌曲保留，未完成歌曲从任务创建时间重扫，JSONL 继续去重。

## CLI

需要 Node.js 20 或更高版本：

```powershell
npm install
npm run build
```

常用命令：

```powershell
# 本地 Web 控制台：http://127.0.0.1:4173
npm run web

# 二维码登录
npm run start -- auth-qr

# 只收集候选歌曲，不读取评论
npm run start -- scan --uid 123456789 --source both --dry-run

# 扫描听歌排行 + 喜欢歌曲
npm run start -- scan --uid 123456789 --source both

# 已知歌曲 ID：有可用代理池时使用它，否则 CLI 会直连
npm run start -- scan-song --uid 123456789 --song-id 186016
```

CLI `scan` 的默认单次请求预算为 250，`scan-song` 为 5000；达到预算后保存检查点并返回 `paused`。GUI 默认预算为 `0`，表示不因本地预算自动暂停。请求预算是评论页的逻辑调度限制，来源发现、歌曲详情和内部重试可能带来额外远端尝试，不应把它视为所有 HTTP 尝试的绝对硬上限。

查看全部参数：

```powershell
npm run start -- --help
```

## 代码结构

| 模块 | 职责 |
| --- | --- |
| `src/api.ts` | 网易云请求适配、响应归一化和加解密底座 |
| `src/scanner.ts` | 听歌排行/喜欢列表收集、多 Lane 页级调度和断点恢复 |
| `src/parallel-scanner.ts` | 单曲时间分片、自适应尾部拆分、页级队列和出口故障转移 |
| `src/time-shards.ts` | 两种扫描器共用的半开时间分片创建与拆分规则 |
| `src/clash-profile-merge.ts` | Clash 配置校验、多配置公平候选、节点去重和重名处理 |
| `src/work-queue.ts` | 可等待重新入队的异步工作队列，避免 Worker 过早退出 |
| `src/cursor-pagination.ts` | 两种扫描器共用的降序游标推进规则 |
| `src/task-coordinator.ts` | 全局单任务租约、代理池互斥与耗时计算 |
| `src/task-log.ts` | 按任务 UUID 串行写入结构化调试日志 |
| `src/mihomo-pool.ts` | Clash Verge 发现、Mihomo 生命周期、网段去重与连通验证 |
| `src/server.ts` | 本地 API、任务/登录/代理池编排和结算快照 |
| `src/electron-main.ts` | 桌面窗口、内置服务生命周期与运行目录隔离 |
| `src/windows-updater.ts` | Windows 更新检查、下载、校验和重启安装状态机 |
| `web/` | 本地操作界面、实时结果、日志和结算画面 |

项目不使用数据库。评论结果是追加写入的 JSONL，扫描状态是 JSON，实时 UI 失败不得中断结果持久化。客户端启动扫描时会流式读取历史 JSONL 并定期让出事件循环，避免大结果文件造成窗口卡顿。底层依赖固定为 `@neteasecloudmusicapienhanced/api@4.39.0`，避免上游变更直接影响正在续跑的任务。

## 开发与验证

```powershell
npm run check
npm test
npm run build
```

macOS 打包：

```bash
npm run dist:mac       # Apple Silicon
npm run dist:mac:all   # Apple Silicon + Intel
```

Windows 安装器应在 GitHub Actions 的真实 Windows 环境中执行类型检查、全部测试、打包应用启动冒烟测试和 NSIS 资产验证。发布前还应确认 Git tag、Release commit 和远端 `main` 指向同一提交。

自动化测试使用内存 API 桩，不会默认向网易云发送真实扫描请求。
