<div align="center">
  <img src="web/app-icon.png" width="96" alt="乐评寻踪图标">
  <h1>乐评寻踪</h1>
  <p><strong>MUSIC COMMENT TRACE</strong></p>
  <p>在网易云音乐与 QQ 音乐的公开歌曲评论中精确定位目标用户。</p>
  <p>
    <a href="https://github.com/RocXOvO/ncm-comment-finder/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/RocXOvO/ncm-comment-finder?style=flat-square"></a>
    <a href="https://github.com/RocXOvO/ncm-comment-finder/actions/workflows/windows-package.yml"><img alt="Windows package" src="https://img.shields.io/github/actions/workflow/status/RocXOvO/ncm-comment-finder/windows-package.yml?style=flat-square&label=Windows%20package"></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square">
    <img alt="Windows and macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-59636e?style=flat-square">
  </p>
</div>

乐评寻踪是一款本地运行的评论检索工具。它把目标 UID、QQ 号、QQ 音乐主页或 EncryptUin 规范为精确身份，在公开歌曲目录与评论分页中查找匹配作者，并提供断点续跑、多出口调度、实时结果、结构化日志和 PDF 报告。

> [!IMPORTANT]
> 仅用于合法、合理的公开数据查询。请尊重用户隐私、平台规则和请求频率。本项目不会绕过私密听歌排行、喜欢列表或用户歌单，也不承诺覆盖用户的全部历史评论。

> [!WARNING]
> Web 控制台按本机可信环境设计。请保持默认 `127.0.0.1`，不要暴露到局域网或公网。同一数据目录不要同时运行多个桌面、Web 或 CLI 扫描进程；当前任务互斥只覆盖单个进程。

## Highlights

- **双平台、四种任务视图**：网易云用户来源、网易云单曲并行、QQ 单曲顺序、QQ 公开喜欢彼此隔离。
- **多来源发现**：网易云可组合听歌排行、最近一周、喜欢歌曲与目标用户自建公开歌单；同一歌曲只扫描一次，同时保留来源标签。
- **精确身份匹配**：网易云按数字 UID，QQ 按 canonical EncryptUin；昵称和头像只用于展示，不参与匹配。
- **高吞吐但可控**：支持 Clash Verge/Mihomo 多出口池、每出口 Governor、全局传输 Gate、页级重排和失败转移。
- **可靠恢复**：JSON 检查点原子写入，JSONL 结果按稳定键去重并在每条命中后同步到磁盘；网易云顶层评论与每个楼中楼线程都能独立续扫，Windows 临时锁会退避重试并可恢复完整临时文件。
- **实时可观测**：展示活动歌曲、Worker、请求、页面、读取速度、命中、冷却与任务结算。
- **完整 PDF 导出**：从已落盘结果生成 A4 报告，按实际内容高度连续分页并重复表头，同时显示阶段、累计耗时、取消和明确失败信息。
- **克制的桌面交互**：平台切换使用一次性 WebGL2 绢缎折幕；歌曲来源用滑动高亮与可反向的范围收拢替代生硬跳转；主工作区提供可关闭的四线 MeshLine 鼠标尾迹，4×20 个控制点保留多帧长度，抗共振参数与 32 px 头部滞后软限幅使不同速度的持续画圈仍保持有界，投影线宽最高 22 px，静止 420 ms 后停止渲染。

## 下载

从 [GitHub Releases](https://github.com/RocXOvO/ncm-comment-finder/releases/latest) 下载最新正式版：

| 平台 | 资产 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `NCM-Comment-Finder-Setup-<version>.exe` | 辅助式安装器，支持应用内更新 |
| macOS 11+ Apple Silicon | `NCM-Comment-Finder-<version>-arm64.dmg` | Apple 芯片 Mac |
| macOS 11+ Intel | `NCM-Comment-Finder-<version>-x64.dmg` | Intel Mac |

Windows 当前未配置 Authenticode，首次运行可能出现 SmartScreen 提示。macOS 使用 ad-hoc 签名，尚未进行 Apple Developer ID 公证。应用内更新的 SHA-512 用于校验下载完整性，不等同于代码签名。

## 快速开始

1. 安装并启动“乐评寻踪”，在顶部选择网易云音乐或 QQ 音乐。
2. 填写目标：网易云使用用户主页 `id=` 后的数字 UID；QQ 可使用数字 QQ、官方个人主页 URL 或 EncryptUin。
3. 选择任务视图和歌曲来源。网易云“喜欢歌曲”需要有效登录会话；QQ 公开喜欢不要求 QQ Cookie。
4. 高并发扫描建议先在“多 IP 池”中导入或自动优选代理；普通用户资料、歌曲搜索和身份解析始终使用有界本机直连。
5. 启动任务，在“实时结果”查看命中，或导出当前任务的完整 PDF 报告。

UID 示例：

```text
https://music.163.com/#/user/home?id=123456789
                                      └─ UID
```

## 任务视图

| 视图 | 适用场景 | 主要调度方式 |
| --- | --- | --- |
| 网易云 · 用户来源 | 不知道具体歌曲 | 排行、喜欢、自建公开歌单或组合；跨歌曲轮转，顶层时间范围与楼中楼游标各自续扫 |
| 网易云 · 单曲并行 | 已知歌曲且评论区较大 | 搜索选曲、顶层半开时间分片、楼中楼独立游标与多出口队列 |
| QQ · 单曲顺序 | 已知 QQ 音乐歌曲 | 一条 SeqNo 游标链；每页可更换出口，但不并发推进同一游标 |
| QQ · 公开喜欢 | 目标公开了“我喜欢” | 先发现歌曲，再跨歌曲并行；同一歌曲仍保持单游标链 |

网易云来源选项为 `record | likes | playlists | both | all`；排行范围为全部时间、最近一周或两者。目录响应必须提供可信所有者和完整歌曲 ID，订阅歌单、缺失所有者、重复/非法 ID 或明显截断不会被静默当作完整目录。

两个网易云视图的“读取楼中楼回复”默认关闭。默认只扫顶层评论，不会发出楼中楼请求，并使用独立的 `-root-only` 状态、结果和覆盖路径；开启后会逐页读取回复，扫描速度可能极大降低，界面会显示醒目提示。两种范围不共用已完成记录、覆盖或结果，恢复任务仍沿用保存时的范围。

普通启动会刷新所选目录，再按歌曲 ID 与当前评论范围的检查点对账：已完成歌曲复用覆盖，未完成歌曲从原顶层 cursor/分片和可选楼中楼游标继续，新增歌曲从头扫描。目标用户未公开听歌排行或喜欢的音乐时，客户端会用中文提示并跳过该来源，不显示原始 422 错误；其他可用来源继续扫描，只有这一项时则以 0 首目录正常结束并标记覆盖不完整。真实网络、协议或目录数据异常仍按错误处理，不会被伪装成隐私提示。

网易云的 `comment_new` 页只返回顶层评论，但上游总数包含顶层与楼中楼回复。开启楼中楼时，客户端显示“已搜索顶层 + 回复 / 上游总数”和两类页数，只有顶层时间覆盖与所有楼中楼 `hasMore=false` 才完成。仅顶层时会明确提示上游总数含未读回复，不拿它伪造顶层百分比；顶层覆盖完成即结算。`totalCount` 和 `replyCount` 在两种范围下都只是提示，不是终态依据。可信发行时间只用于顶层覆盖核算，实际顶层扫描仍保守覆盖到 2000 年。

“每首最大页数”只限制顶层 `comment_new` 页；开启时楼中楼按总请求上限继续。每个父评论同时只有一页在途，不同父评论和歌曲可以分布到多个出口；成功后可换出口续页，失败接管不重复扣逻辑预算。因为单个巨大父评论必须严格串行 cursor，其协议上限约为 `40 / (RTT + 本地开销)` 条/秒，即使多出口也可能仍接近 40 条/秒。达到顶层上限且仍有未读时会明确显示“达到页数上限、未覆盖全部评论”。请求上限按逻辑历史/顶层/楼中楼页计数；物理重试、目录请求和歌曲信息补全不重复扣减，串行 CLI 也遵守同一口径。

宽屏桌面在展开 336 px 任务面板时会同步让出主内容，面板右边与内容左边保留 21 px 间距；`<=1280px` 时任务面板和 Inspector 继续作为互斥浮层。顶栏使用对称外列固定中间的平台入口，Windows 在 1238–1480 px 使用 340 px 右槽，821–1237 px 使用 220 px 紧凑右槽，更窄时收敛为 75 px；状态徽标不换行。实际验收已覆盖 Windows 150% 的 1293×841 CSS px 视口、分段边界和 820/390 px 窄屏，网易云/QQ 切换不移动入口且无横向溢出。

## 代理与网络边界

- 普通资料、歌曲搜索、数字详情和身份解析是低频本机直连，不读取代理池。
- 正式评论与来源分页按任务配置使用代理；选择代理后保持 fail-closed，不会在失败时偷偷回退本机出口。
- 托管池可从多套 Clash Verge 配置公平取样，按 IPv4 `/24`、IPv6 `/48` 去重，并验证真实出口与网易云接口。
- 右侧 Inspector 收起时，构建或后台复测会显示可点击的全局进度提示；提示会为折叠控制轨道留出安全间距，不再与右栏重叠。
- Worker 不会除小每出口请求间隔。真实发车先取得任务 Gate 容量与至少 50 ms 全局启动槽，再在 HTTP 边界预约当前出口 Governor；20 次启动/秒是由 50 ms 推导的理论硬上限，不是实网观测。要使用 8 个已验证出口和 32 个 Worker，需同时设置任务出口上限 8、每出口 Worker 4、总 Worker 上限 32。用户设为 300 ms + `U[0,100)` ms 时，全局仍至少 50 ms，同出口仍至少 300 ms；用户来源默认仍是每出口 1 Worker 和 2500/800 ms。本机一次离线合成集成基准使用 32 个独立 parent、8×4 Worker、200 ms 合成 RTT 与满 40 回复页，处理 1280 条用时 1795 ms，约 713 replies/s；这只是 synthetic 证据，不承诺实网性能。

## 数据、恢复与导出

桌面数据保存在 Electron `userData`；源码运行使用项目内 `data/` 与 `.ncm/`。项目不使用数据库：扫描状态是 JSON，结果和日志是追加式 JSONL。网易云结果 writer 使用长连接私有权限文件；一个楼中楼页的全部命中以一次批量 write + fsync 先落 JSONL，再推进 cursor/状态。楼层强刷检查点是 single-flight：最多累计 4 个完成页，或在页完成时距上次强刷已达 400 ms；写入期间新增的 dirty 页保留到下一批，终态、停止和错误强刷。崩溃最多重放已落盘页，复合键去重不会重复追加。旧文件末尾若缺换行，会先持久补齐分隔。这些运行目录均被 Git 忽略。

停止任务、退出客户端或安装 Windows 更新前，应用会请求真实活跃任务停止并等待终态检查点。恢复描述符只回填表单，不会自动开始扫描。

关闭桌面主窗口时使用与客户端一致的应用内弹窗，可选择取消、转入后台或安全退出，并可记住选择。安全退出期间弹窗会持续显示停止任务和保存最终检查点的状态，不再弹出 Windows 原生样式的询问框。

PDF 从当前 generation 对应的已落盘结果快照生成；网易云楼中楼命中会标明“楼中楼回复”及父评论 ID。完整范围的单曲并行报告在顶层时间覆盖不到 100% 时只说任务尚未完整，顶层到 100% 但楼中楼未完成时才明确标注；仅顶层报告则明示“未读取楼中楼”。Windows 默认文件名显示完整 UID/EncryptUin，但会清理禁止字符、尾部点号/空格和设备保留名；日志、错误与诊断继续脱敏。单份报告上限为 64 MiB JSONL 或 20,000 条命中，超过时会明确拒绝而不是静默截断。

## CLI

需要 Node.js 20 或更高版本：

```bash
npm install
npm run build

# 本地 Web 控制台
npm run web

# 网易云：扫描排行 + 喜欢，或全部公开来源
npm run start -- scan --uid 123456789 --source both
npm run start -- scan --uid 123456789 --source all --record-scope both

# 网易云：已知单曲
npm run start -- scan-song --uid 123456789 --song-id 186016

# QQ：解析用户、扫描单曲、扫描公开喜欢
npx tsx src/qq-cli.ts resolve-user --user 123456789
npx tsx src/qq-cli.ts scan-song --user 123456789 --song-id 102065756
npx tsx src/qq-cli.ts scan-likes --user 123456789 --max-songs 20
```

查看全部参数：

```bash
npm run start -- --help
```

## 文档

- [GUI 架构与性能边界](docs/platform-gui-architecture.md)
- [QQ 音乐后端架构](docs/qq-music-architecture.md)
- [QQ 音乐性能模型](docs/qq-music-performance-review.md)
- [当前代码审计与风险边界](docs/code-audit.md)
- [开发者/代理维护合同](AGENTS.md)

## 开发与验证

```bash
npm run check
npm test
npm run build
npm run bench:qq
node --check web/app.js
node --check web/platform-wave.js
node --check web/pointer-silk-trail.js
npm run desktop:smoke:mac
git diff --check
```

`v1.2.1` 的交付基线为 592/592 项测试（0 fail / 0 cancelled），并通过类型检查、构建、QQ benchmark、三个 renderer 语法检查、macOS 桌面冒烟和 diff-check；真实浏览器验收覆盖楼中楼范围切换、提示与独立结果边界，console warning/error 为零。Windows 安装器由 GitHub Actions 在与 Release 相同的精确提交上执行完整测试、打包应用启动/PDF 冒烟与 NSIS 资产验证；自动化测试默认使用内存桩和回环代理，不会向音乐平台发起真实批量扫描。

## License

本项目采用 [MIT License](LICENSE)。鼠标 Follow 动力学参考 David Ronai 的 MIT 许可 [Makio MeshLine](https://github.com/Makio64/makio-meshline)，客户端保留归属说明并使用独立轻量 WebGL2 实现。
