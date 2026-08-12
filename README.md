<div align="center">
  <img src="web/app-icon.png" width="96" alt="Hushed Refrain Veiled Echo 图标">
  <h1>Hushed Refrain</h1>
  <p><strong>THE WORDS LEFT BETWEEN SONGS</strong></p>
  <p>写不出的喜欢，藏在听过的歌里。</p>
  <p>
    <a href="https://github.com/RocXOvO/hushed-refrain/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/RocXOvO/hushed-refrain?style=flat-square"></a>
    <a href="https://github.com/RocXOvO/hushed-refrain/actions/workflows/windows-package.yml"><img alt="Windows package" src="https://img.shields.io/github/actions/workflow/status/RocXOvO/hushed-refrain/windows-package.yml?style=flat-square&label=Windows%20package"></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square">
    <img alt="Windows and macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-59636e?style=flat-square">
  </p>
</div>

Hushed Refrain 是一款本地运行的音乐评论检索工具。输入网易云 UID、QQ 号、QQ 音乐主页或 EncryptUin，即可在公开歌曲与评论中查找目标作者，并随时查看、恢复或导出结果。

> [!IMPORTANT]
> 仅用于合法、合理的公开数据查询。请尊重用户隐私、平台规则和请求频率。本项目不会绕过私密听歌排行、喜欢列表或用户歌单，也不承诺覆盖用户的全部历史评论。

> [!WARNING]
> Web 控制台按本机可信环境设计。请保持默认 `127.0.0.1`，不要暴露到局域网或公网。同一数据目录不要同时运行多个桌面、Web 或 CLI 扫描进程；当前任务互斥只覆盖单个进程。

## Highlights

- **双平台、四种任务视图**：网易云用户来源、网易云单曲并行、QQ 单曲顺序、QQ 公开喜欢彼此隔离。
- **多来源发现**：网易云可组合听歌排行、最近一周、喜欢歌曲与目标用户自建公开歌单；同一歌曲只扫描一次，同时保留来源标签。
- **精确身份匹配**：网易云按数字 UID，QQ 按规范身份标识；昵称和头像只用于展示，不参与匹配。
- **高吞吐但可控**：支持 Clash Verge/Mihomo 多出口池、请求频率限制和失败出口切换。
- **可靠恢复**：任务进度和去重结果会持续保存，停止或意外中断后可以继续扫描。
- **实时进度**：展示仍在处理或达到页数上限的歌曲、读取数量、速度、命中、请求状态和任务结果；正常完成的歌曲会自动移出活动列表。
- **完整 PDF 导出**：从已落盘结果生成 A4 报告，按实际内容高度连续分页并重复表头，同时显示阶段、累计耗时、取消和明确失败信息。
- **克制的桌面交互**：提供平台切换动画、歌曲来源滑动反馈和可关闭的鼠标尾迹，空闲时停止持续渲染。

## 下载

从 [GitHub Releases](https://github.com/RocXOvO/hushed-refrain/releases/latest) 下载最新正式版：

| 平台 | 资产 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `Hushed-Refrain-Setup-<version>.exe` | 辅助式安装器，支持应用内更新 |
| macOS 11+ Apple Silicon | `Hushed-Refrain-<version>-arm64.dmg` | Apple 芯片 Mac |
| macOS 11+ Intel | `Hushed-Refrain-<version>-x64.dmg` | Intel Mac |

Windows 当前未配置 Authenticode，首次运行可能出现 SmartScreen 提示。macOS 使用 ad-hoc 签名，尚未进行 Apple Developer ID 公证。应用内更新的 SHA-512 用于校验下载完整性，不等同于代码签名。

客户端启动时会静默检查更新，保持打开时每 30 分钟静默轮询一次；页面隐藏时暂停，恢复后若已到期会立即检查。只有确认存在更高版本后，右上角才会显示更新按钮。点击后再查看版本说明或下载安装包，后台检查不会自动弹窗。

从旧版本升级时，请先完全退出旧客户端。Windows 可以直接覆盖安装；macOS 可能同时保留新旧两个应用，确认设置、断点和结果已迁移后即可删除旧应用。

## 快速开始

1. 安装并启动 Hushed Refrain，在顶部选择网易云音乐或 QQ 音乐。
2. 填写目标：网易云请在浏览器打开网页版和目标用户主页，复制地址栏 `id=` 后连续的数字；QQ 可使用数字 QQ、官方个人主页 URL 或 EncryptUin。
3. 选择任务视图和歌曲来源。网易云“喜欢歌曲”需要有效登录会话；QQ 公开喜欢不要求 QQ Cookie。
4. 高并发扫描建议先在“多 IP 池”中导入或自动优选代理；普通用户资料、歌曲搜索和身份解析始终使用有界本机直连。
5. 启动任务，在“实时结果”查看命中，或导出当前任务的完整 PDF 报告。

UID 示例：

```text
https://music.163.com/#/user/home?id=123456789
                                      └─ UID
```

## 任务视图

| 视图 | 适用场景 | 特点 |
| --- | --- | --- |
| 网易云 · 用户来源 | 不知道具体歌曲 | 从排行、喜欢和自建公开歌单中发现歌曲 |
| 网易云 · 单曲并行 | 已知歌曲且评论区较大 | 搜索选曲后并行扫描评论时间范围 |
| QQ · 单曲顺序 | 已知 QQ 音乐歌曲 | 按评论顺序稳定读取，失败时可切换出口 |
| QQ · 公开喜欢 | 目标公开了“我喜欢” | 先发现喜欢歌曲，再跨歌曲并行扫描 |

网易云用户来源可以组合全部时间排行、最近一周排行、喜欢歌曲和目标用户自建的公开歌单。订阅歌单和无法确认归属的歌单不会被当作目标来源。

两个网易云视图的“读取楼中楼回复”默认关闭。开启后会逐页读取回复，扫描速度可能极大降低；两种范围分别保存进度和结果，恢复任务时会沿用原来的选择。

目标用户未公开听歌排行或喜欢的音乐时，客户端会给出提示并跳过该来源；其他可用来源仍会继续扫描。真实网络或数据异常仍会明确报错，不会伪装成隐私限制。

如果公开喜欢歌单声明的歌曲数多于当前实际可访问的歌曲，客户端会提示缺少数量并立即扫描可访问部分；此时不会声明完整覆盖。缺少歌曲 ID 目录、声明歌曲数大于 0 却返回空目录，或目录含无效、重复 ID 时仍会停止并报错。

网易云显示的总评论数包含顶层评论和楼中楼回复。客户端会分别展示已搜索的顶层与回复数量，并按照当前选择的扫描范围判断是否完成。

“每首最大页数”只限制顶层评论；楼中楼由任务总请求上限控制。达到限制且仍有未读内容时，客户端会明确提示未覆盖全部评论。

## 代理与网络边界

- 普通资料、歌曲搜索、数字详情和身份解析是低频本机直连，不读取代理池。
- 正式扫描按任务配置使用代理；代理不可用时会停止并提示，不会偷偷改用本机网络。
- 托管池会验证代理出口和目标接口是否可用；界面会显示构建、复测和失效状态。
- 四种扫描视图的新任务默认让同一出口的请求以 300 ms 基础间隔启动，并加入 0–100 ms 随机抖动；恢复任务继续使用已保存的参数。
- 并发和请求间隔始终受用户配置与全局安全上限约束，增加 Worker 不会绕过单出口频率限制。

## 数据、恢复与导出

设置、断点、结果和日志都保存在本机。从旧版本首次启动时，应用会迁移原有数据；若旧目录暂时被占用，会保留完整数据并在下次启动重试。

停止任务、退出客户端或安装 Windows 更新前，应用会等待当前进度保存完成。恢复任务只会回填参数，不会自动开始扫描。

PDF 会从当前任务已保存的结果生成，并标明楼中楼回复及其父评论。报告过大时会明确提示，不会静默截断。

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

## 开发与验证

```bash
npm run check
npm test
npm run build
npm run bench:qq
npm run icons:check
node --check web/app.js
node --check web/platform-wave.js
node --check web/pointer-silk-trail.js
npm run desktop:smoke:mac
git diff --check
```

## License

本项目采用 [MIT License](LICENSE)。鼠标尾迹的 Follow 动力学参考 David Ronai 的 MIT 许可 [Makio MeshLine](https://github.com/Makio64/makio-meshline)。
