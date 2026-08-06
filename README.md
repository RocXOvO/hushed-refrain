# 网易云用户评论查找器

按用户 UID 收集候选歌曲，再逐页检查歌曲评论并输出该 UID 发布的评论。项目采用
[NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
作为请求与 `weapi/eapi/xeapi` 加解密底座。

## 路径设计

1. `auto`：登录 Cookie 对应的 UID 与目标 UID 相同时，使用用户评论历史接口；否则进入歌曲扫描。
2. `record`：按用户全部时间或最近一周听歌排行的返回顺序扫描。
3. `likes`：扫描用户喜欢音乐 ID 列表。
4. `both`：先听歌排行，再补入喜欢列表中尚未出现的歌曲。

评论历史接口只适合查询当前登录账号自己。查询其他公开用户时，工具使用其公开的听歌排行或喜欢列表作为候选集，然后在歌曲评论中按 `comment.user.userId` 精确匹配。

## 安装

Windows 用户可直接运行：

```text
release/NCM-Comment-Finder-Setup-0.2.0.exe
```

安装器支持选择目录，并创建桌面及开始菜单快捷方式。桌面版将 Cookie、代理池、检查点和结果写入 Electron 用户数据目录。

Windows 桌面版使用与应用顶栏融合的无边框窗口，最小化、最大化/还原和关闭按钮位于右上角；深色顶栏的空白区域可拖动窗口。参数折叠区、模式切换、页签和弹窗均带过渡动画，并遵循系统的“减少动态效果”设置。

桌面客户端每次启动会后台检查 GitHub 最新正式 Release。发现更高版本时会显示更新说明，并自动匹配当前系统和 CPU 架构的安装包；也可点击顶部版本按钮手动复查。公开仓库可匿名检查，私有仓库需通过 `NCM_GITHUB_TOKEN` 提供具有仓库只读权限的 GitHub Token。检查失败不会影响扫描功能。

macOS Apple Silicon 用户可打开：

```text
release/NCM-Comment-Finder-0.2.0-arm64.dmg
```

将“云评检索台”拖入 Applications 即可安装。当前本地包使用 ad-hoc 签名；向其他用户公开分发时，应使用 Apple Developer ID 证书签名并公证。

从源码运行需要 Node.js 20 或更高版本：

```powershell
npm install
npm run build
```

macOS 安装包构建：

```bash
# Apple Silicon
npm run dist:mac

# 同时生成 Apple Silicon 和 Intel 版本
npm run dist:mac:all
```

构建脚本会先在系统临时目录中签名和生成 DMG，再把安装包复制到 `release/`，避免 Documents/iCloud 文件提供器的扩展属性干扰 macOS 签名。

底座依赖固定为 `@neteasecloudmusicapienhanced/api@4.39.0`，避免上游接口变更直接影响一次正在续跑的任务。

## 登录

公开歌曲评论本身通常不要求登录；听歌排行、喜欢列表的可见范围由用户隐私设置和登录态决定。需要登录时使用二维码：

```powershell
npm run start -- auth-qr
```

二维码保存到 `.ncm/login-qr.png`，确认后 Cookie 保存到 `.ncm/cookie.txt`。也可通过当前进程的 `NCM_COOKIE` 环境变量提供 Cookie。

## 使用

### 本地控制台

```powershell
npm run web
```

浏览器打开 `http://127.0.0.1:4173`，输入 UID 后可点击选择：

- `听歌排行`：按全部时间或最近一周的听歌次数顺序查询。
- `喜欢歌曲`：查询该 UID 的喜欢音乐列表。
- `两者`：先听歌排行，再补入未出现过的喜欢歌曲。

UID 输入框右侧的用户查询按钮会先读取昵称、等级、累计听歌数，并分别探测听歌排行和喜欢列表是否可读。来源显示“受限”时，先检查二维码登录状态和该用户的公开设置，再决定是否启动评论扫描。

控制台默认进入“单曲并行”，可直接构建 Clash Verge 多 IP 池、查询歌曲、启动/停止分片任务，并查看每个出口 IP 与网易云实测延迟。代理池位于两种检索模式共用区域，可在“Clash Verge”自动优选和“其他代理池”手动导入之间切换。“用户来源”会把听歌排行或喜欢列表中的不同歌曲分配给多个出口并行扫描；每个出口有独立限速器和可配置并发，同时继续使用逐歌曲断点，暂停后不会重扫已经完成的页面。

### 命令行

先只获取候选歌曲并估算范围，不读取评论：

```powershell
npm run start -- scan --uid 目标UID --source both --dry-run
```

按听歌排行顺序查找：

```powershell
npm run start -- scan --uid 目标UID --source record
```

通过喜欢歌曲查找：

```powershell
npm run start -- scan --uid 目标UID --source likes
```

两种来源合并、去重后查找：

```powershell
npm run start -- scan --uid 目标UID --source both
```

每次运行默认最多发出 250 个请求。触及预算后状态为 `paused`，原命令再次执行会从当前歌曲和评论偏移量继续。`403/429` 会立即保存检查点并写入 15 分钟冷却时间；冷却期内重复启动只读取本地状态。

常用的范围控制：

```powershell
# 先测试前 10 首歌，每首最多 3 页
npm run start -- scan --uid 目标UID --source both --max-songs 10 --max-comment-pages-per-song 3

# 找到第一条后暂停
npm run start -- scan --uid 目标UID --source record --stop-after-first

# 使用独立状态和输出文件
npm run start -- scan --uid 目标UID --state data/task-a.json --output data/task-a.jsonl
```

`--max-comment-pages-per-song 0` 表示逐页走到接口返回 `more=false`，这是默认值。对评论量很大的歌曲，完整遍历可能需要多次续跑。

### 单曲高并行扫描

已知歌曲 ID 时使用 `scan-song`。该路径不使用数据库，而是通过 `comment_new` 时间游标把评论区切成多个互不重叠的时间片，由多个 Worker 同时读取并在内存中匹配目标 UID：

```powershell
npm run start -- scan-song `
  --uid 目标UID `
  --song-id 歌曲ID `
  --proxy http://127.0.0.1:17891 `
  --proxy http://127.0.0.1:17892 `
  --workers-per-proxy 3 `
  --shards 96 `
  --comment-page-size 1000 `
  --stop-after-first
```

- `--proxy` 可重复传入，每个地址对应一个固定 Clash/Mihomo Listener。
- 每个代理入口有独立 `RequestGovernor`，请求可以重叠执行，但起始时刻仍按该入口的间隔串行预约。
- 时间片按 `[startTime, endTime)` 过滤，从最新区间向最旧区间调度。
- 页面处理完成后立即释放；只把目标 UID 的命中写入 JSONL。
- `data/parallel-state-UID-SONG.json` 保存各时间片的 cursor，可从中断位置续跑。
- `403/429` 会熔断对应入口；其他入口已在处理的时间片继续执行。
- 普通网络错误只禁用对应入口，其未完成时间片会重新入队，由健康入口继续处理。
- 检查点写入按 500ms 合并，减少高并发时的磁盘争用；任务结束时强制落盘。

## 代码结构

| 模块 | 职责 |
| --- | --- |
| `src/api.ts` | 网易云接口适配、响应归一化和加解密底座调用 |
| `src/mihomo-pool.ts` | Clash Verge 配置读取、Listener 生成、出口去重与网易云连通验证 |
| `src/parallel-scanner.ts` | 时间分片队列、多入口 Worker、故障转移和断点状态 |
| `src/scanner.ts` | 听歌排行/喜欢列表的串行来源扫描 |
| `src/server.ts` | GUI 服务 API、任务/代理池/登录管理器和运行目录隔离 |
| `src/electron-main.ts` | 桌面窗口、内置服务生命周期和进程安全边界 |
| `src/electron-preload.ts` | Windows 窗口控制的隔离桥接层 |
| `src/window-shell.ts` | Windows 无边框窗口策略与桌面 URL 标记 |
| `web/` | 响应式操作界面 |

项目不使用数据库。扫描过程只在内存中保留分片状态和目标命中，检查点使用 JSON，结果使用逐行 JSONL。

## 单账户与请求控制

- 一条串行任务使用一个普通登录会话即可；歌曲评论通常走匿名接口，Cookie 主要用于读取来源列表。
- `scan` 候选歌曲路径保持单并发；`scan-song` 使用多入口、多 Worker 时间分片并行。
- 网络错误和 `5xx` 最多指数退避 3 次；`403/429` 不做连续重放，而是进入持久化冷却。
- 结果按 `commentId` 去重，状态采用临时文件加原子重命名，进程中断后可续跑。
- 不建议同时启动多个进程共享同一 Cookie。需要拆分任务时，使用不同状态文件并保持总请求频率不高于单进程默认值。

粗略请求量为：

```text
来源接口请求 + 所有候选歌曲的评论页数
```

例如 100 首歌、平均每首 4 页，大约 401 到 402 个请求，默认要分两次运行。先用 `--dry-run` 查看去重后的歌曲数，再决定 `--max-songs` 或单曲页数上限。

## 输出与状态

- `data/comments-UID.jsonl`：每行一条命中，包含评论 ID、UID、正文、时间、歌曲 ID、来源和抓取路径。
- `data/state-UID-SOURCE.json`：候选歌曲、当前偏移量、请求数、已见评论 ID、冷却截止时间和覆盖状态。
- `coverageComplete=true`：所有选定来源歌曲及其全部可分页评论均已处理。
- `sourceErrors`：选择 `both` 时某个来源的业务错误；另一路仍会继续，完整覆盖标记为 `false`。
- `sourceTruncated` 或 `truncatedSongIds` 非空：命令设置的上限缩小了覆盖范围。

更换 UID、来源或周榜/总榜时应使用新的 `--state` 路径。`--fresh` 会忽略已有状态，但结果文件仍按评论 ID 去重；要保留不同实验批次，给 `--output` 指定新文件。
登录态更新后如需重试先前失败的来源，也使用 `--fresh` 或新的状态文件。

## 代理配置

网页和普通 `scan` 路径使用单个静态 HTTP/HTTPS 代理：

```powershell
npm run start -- scan --uid 目标UID --source both --proxy http://127.0.0.1:7890
```

高并行 `scan-song` 路径使用多个固定本地代理入口。推荐在 Mihomo 中为每个节点建立一个 Listener：

```yaml
listeners:
  - name: ncm-egress-1
    type: mixed
    listen: 127.0.0.1
    port: 17891
    proxy: NODE_A
    users: []
  - name: ncm-egress-2
    type: mixed
    listen: 127.0.0.1
    port: 17892
    proxy: NODE_B
    users: []
```

然后重复传入 `--proxy http://127.0.0.1:PORT`。程序按入口建立客户端池，不在请求过程中随机切换节点，因此可以分别记录请求数、错误和冷却状态。TUN 可以继续开启，但高并行路径以显式 Listener 为准。

也可以让工具直接从 Clash Verge 当前合并配置构建独立的 Mihomo 池：

```powershell
# 抽取订阅节点，启动独立 Mihomo，并筛选 4 个不同公网出口
npm run start -- proxy-pool start --size 4 --candidates 24

# 查看 PID、Listener、节点和实测出口 IP
npm run start -- proxy-pool status

# 停止工具创建的独立 Mihomo
npm run start -- proxy-pool stop
```

程序会按平台自动发现 Clash Verge：

- macOS：`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml` 和 `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`
- Windows：`%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml` 和 Clash Verge 安装目录中的 `verge-mihomo.exe`
- Linux：XDG 配置目录和常见的 `mihomo`/`verge-mihomo` 可执行路径

可通过 `NCM_CLASH_CONFIG` 和 `NCM_MIHOMO_PATH` 环境变量覆盖自动发现结果。

使用其他 HTTP/HTTPS 代理池时，可在 GUI 中每行粘贴一个代理，或使用 CLI：

```bash
npm run start -- proxy-pool import \
  --proxy http://127.0.0.1:17891 \
  --proxy http://user:password@proxy.example:8080
```

所有导入代理都会检查真实出口 IP，按 IP 去重，再用网易云评论接口实测并按总延迟排序。带账号密码的代理 URL 保存在本地代理池文件中，该文件在 macOS/Linux 上使用 `0600` 权限，GUI API 返回时会隐去凭据。

池配置写入 `.ncm/mihomo-pool/config.yaml`，验证结果写入 `.ncm/proxy-pool.json`。这两个路径都被 Git 忽略。构建过程执行两级检查：

1. 每个 Listener 访问公网 IP 查询接口，按出口 IP 去重。
2. 每个不同出口请求网易云真实评论接口，按总延迟排序，只保留最快且成功的节点。

未显式传入 `--proxy` 时，`scan-song` 会自动加载 `.ncm/proxy-pool.json`，并在任务启动前重新确认所有入口仍对应不同出口 IP 且评论接口可读。

## 速度估算

普通 `scan` 默认参数为每页 100 条、请求起始间隔 `2500ms + 0..800ms`。接口往返时间低于该间隔时，请求间隔决定主要耗时：

| 评论数 | 请求页数 | 理想耗时 | 常规耗时 | 保守耗时 |
| ---: | ---: | ---: | ---: | ---: |
| 10 万 | 1,000 | 41 分 40 秒 | 48 分 20 秒 | 55 分 |
| 30 万 | 3,000 | 2 小时 5 分 | 2 小时 25 分 | 2 小时 45 分 |
| 50 万 | 5,000 | 3 小时 28 分 20 秒 | 4 小时 1 分 40 秒 | 4 小时 35 分 |
| 100 万 | 10,000 | 6 小时 56 分 40 秒 | 8 小时 3 分 20 秒 | 9 小时 10 分 |

常规值使用平均 `2900ms/页`。实际完成时间还要叠加来源列表请求、网络慢请求、接口业务错误和冷却期。把间隔设为 `0` 时，按 `400ms` 往返估计的协议侧上限约为 250 条/秒，即 10 万条约 6 分 40 秒；这是计算下界，不代表连续运行可维持该频率。

网页“速度估算”页签会用当前间隔、抖动、代理池实际出口数、每出口并发以及网易云实测延迟实时重算。每个出口独立执行限速，因此在请求间隔占主导时，4 个不同出口的理论耗时约为单线路的四分之一；当网络延迟高于请求间隔时，估算会再用每出口并发修正吞吐上限。默认单次请求预算为 250，长任务暂停后以同一 UID 和来源再次点击即可从检查点继续，也可调高预算让单次运行覆盖更多页面。

### 加快定位

目标是尽快找到一条评论时，先扫描每首歌的前 3 页并在首条命中后暂停：

```powershell
npm run start -- scan --uid 目标UID --source record `
  --max-comment-pages-per-song 3 --stop-after-first `
  --min-delay-ms 1200 --jitter-ms 300 --request-budget 1000
```

这会优先覆盖听歌排行中每首歌的热评和最近约 300 条评论，`coverageComplete` 会保持 `false`。未命中时再扩大每首页数或切换喜欢歌曲来源。

目标是完整遍历时，先用默认参数跑 250 页观察是否出现冷却；状态稳定后可将单次预算调到 `5000`，并逐步把间隔降至 `1500ms + 0..500ms`。该组合平均约 `1750ms/页`，理论约 57 条/秒，10 万条约 29 分 10 秒。实际出现 `403/429` 时，冷却时间会抵消更短间隔带来的收益。

若 UID 正好是当前登录账号本人，CLI 的 `--strategy auto` 会改走用户评论历史接口，省去逐首枚举歌曲评论：

```powershell
npm run start -- scan --uid 本人UID --strategy auto
```

## 开发验证

```powershell
npm run check
npm test
npm run build
```

自动化测试使用内存 API 桩。真实接口验收需显式执行 `scan-song` 或从桌面界面启动任务。
