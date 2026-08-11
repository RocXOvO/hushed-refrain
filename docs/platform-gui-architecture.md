# 多平台 GUI 与歌曲搜索架构

## 目标

- 网易云音乐与 QQ 音乐拥有明确不同的视觉语言，但共用一套任务状态、结果、日志、代理池和更新逻辑。
- 平台切换只使用一种 Obsidian Silk Aperture（黑曜绢缎幕孔）；业务 DOM 始终不参与动画。
- 用户以“歌名 / 歌手”搜索并选择歌曲，内部仍以平台歌曲 ID 作为扫描主键。
- 统一面向用户的参数名称和进度口径，保留现有 API/检查点字段以兼容旧版。

## 界面层

### 主题，不复制业务 DOM

`body[data-platform="netease"|"qq"]` 只切换视觉 token、平台标识、提示文案和相关表单。任务栏、结果表、日志、估算、右侧节点详情和导出保持单实例，避免两套 GUI 的事件、任务代际和缓存状态漂移。

QQ 视觉层以中性黑灰/白灰为主体，只把 QQ 音乐品牌绿 `#31c27c` 用于平台标识和少量关键强调；正文强调使用更深的可读绿色，大面积背景不再铺青蓝。平台识别区、表单面板、指标和选中态保持克制，网易云继续使用暖灰/红。两者都使用低开销的颜色、边框、阴影和不透明背景，不引入长时间模糊或玻璃效果。

导航不放置无状态来源的装饰性绿点。顶部本地服务徽章和代理池状态灯继续由真实连接/池状态驱动，是仅存的状态圆点语义。

交互几何使用角色 token：微小 6 px、控件 10 px、表面 14 px、浮层 18 px，标签/状态使用 pill。所有普通 `button`/`.button` 用 `--motion-control` 约 150 ms 统一颜色、背景、边框和阴影反馈，按下的 `scale(.987)` 由实际使用的 `--motion-press` 约 80 ms 控制；disabled/`aria-disabled` 降低对比并禁止 hover、位移和阴影，reduced-motion 关闭过渡和缩放。Windows 原生窗口控制按钮保留系统手感，按下不缩放。

响应式外壳以对称外列锁定中间 `.platform-portal`：1238–1480 CSS px 时通用左右列下限各 310 px，Windows 各 340 px 且 `.topbar-end` 固定 340 px；821–1237 px 时通用下限各 71 px，Windows 各 220 px 且右槽固定 220 px；`<=820px` 时右槽为 75 px。`.status-badge` 使用 non-shrinking flex item 且不换行。Portal 在 1210/1211、1280/1281 等断点连续，网易云/QQ 切换的实测 `dx=0`、`dw=0`。

网易云“歌曲来源”不直接跳变选中背景：`#sourceSelectionIndicator` 只在 change/resize 时读取当前选项几何，以 220 ms transform/size 过渡滑到目标。排行范围放在 `#recordScopeRegion` 中，选择喜欢歌曲或用户歌单时用可逆的 grid-row/opacity/translate 过渡收拢，恢复含排行的来源时可从当前帧直接反向展开。`aria-hidden` 与 `inert` 在选择当帧即时收敛；首次布局、ResizeObserver、BFCache 和 reduced-motion 静态对齐，不排队旧动画。

网易云用户来源与单曲并行的高级参数都提供 `includeCommentFloors`，新任务默认关闭并映射为 `root-only-v1`。开关旁必须常驻醒目的“开启后扫描速度会极大降低”提示；开启时映射为 `root-and-floor-v1`。恢复任务沿用 descriptor 已保存的值，旧 descriptor 仍按兼容规则恢复完整范围。开关可反复切换但不得改写另一 scope 的代际、状态、结果或覆盖。

桌面 PDF 从导出开始发出 `save-dialog` 进度，`elapsedMs` 是包含保存对话框等待的单调累计耗时，不是独立阶段耗时。结果区只生成一个语义表格，由 Chromium 按真实行高分页并在续页重复表头；长评论可拆成受保护的续行，但禁止以估算字符单位预分批并强制换页，否则会留下大块空白。网易云楼中楼命中在行内显示回复类型和父评论 ID，不与顶层评论混成无来源的扁平结果。完整范围单曲并行报告的 `coverageLabel` 将顶层时间覆盖和整体完成分开：顶层低于 100% 时只写“任务尚未完整完成”，顶层已到 100% 但整体未完成时才写“楼中楼尚未完成”，root + floor 共同完成才写完成。仅顶层报告则明示“未读取楼中楼”，不把组合 total 当顶层完成率。正文末尾说明仅供屏幕报告查看，打印时隐藏，避免被单独推到一张空白尾页；页码页脚仍由 PDF 打印模板负责。默认文件名由 `resultReportFilename` 写入完整 canonical UID/EncryptUin，这是用户明确可见的导出信息；`sanitizeWindowsPdfFilename` 只负责把 Windows 禁止字符/控制字符替换为兼容字符、清理尾部点号/空格、避开设备保留名、将主文件名限制到 180 字符并固定 `.pdf`，不对目标做脱敏。日志、错误和诊断仍不得包含完整目标。选定路径后打开持久进度浮层，持续显示读取、字体、生成、写入阶段与累计耗时，并提供显式取消；`showModal()` 暂不可用时回退到 `show()`，展示接口都失败也不能中断实际导出。终态必须关闭隐藏报告窗口、移除进度监听并恢复导出按钮；选定路径后的阶段全部有界。打包冒烟必须从 renderer 的 `window.ncmDesktop` 穿过 preload/IPC，再完成隐藏 Chromium 加载、字体、打印与原子写入，并验证完整进度序列、目标路径和 `%PDF-` 文件头。

桌面主窗口的系统关闭事件和自绘 Windows 关闭按钮都进入同一关闭生命周期。`electron-main` 只向当前主窗口发送一次窄桥 `close-requested`；renderer 用客户端主题的 `closeAppDialog` 呈现取消、转入后台、安全退出和“记住选择”，再通过严格 DTO 回传决定。只有当前主窗口的在途请求可结算，重复或过时回复无效；renderer 关闭、崩溃或无响应时默认取消关闭。选择退出后弹窗保持可见、禁用重复操作并播报停止任务与保存检查点，随后复用既有最多 45 秒的 graceful-quit；选择后台或取消则立即收敛弹窗。展示层不得调用原生 `showMessageBox` 复制另一套关闭语义，记忆选择也只能 partial update `closeBehavior`，不能覆盖鼠标尾迹设置。

### Obsidian Silk Aperture 交接

- `PlatformWaveTransition.create({ sourcePlatform, targetPlatform, direction, commit })` 返回 `{ finished, cancel }`。内部状态固定为 `idle → preparing → covering → covered/commit → revealing → settled`；`commit()` 是唯一允许修改 platform/mode、`hidden`/`inert`、结果/SSE 和 ARIA 的入口，只调用一次并显式返回布尔值。
- 一次过渡约 680 ms。深色绢幕按 Tab 方向收拢，244 ms 已完整遮住视口；shader 在 244–404 ms 遮罩窗口显式返回 `alpha=1`，约 326 ms/48% 在源色经中性黑曜过渡到目标色的交界处唯一提交 DOM，404 ms 才开始揭幕。网易云使用深红/暖色绢光，QQ 使用石墨绿/品牌绿/柔和薄荷绢光；不使用粒子、无限环、方格铺屏、模式选择、紫色渐变、模糊玻璃、弹跳或循环长尾。
- Fragment shader 直接生成五条确定性绢缎褶皱/等高线、门帘边缘、轻微箔线与暗部颗粒，以 `fwidth` 给边界抗锯齿，颜色从源平台继续收敛到中性 void 再进入目标平台。高光用有界乘法近似而不用 `pow`/`exp`，grain 使用低成本算术 hash 而不用 sine hash。它不读取、截图、分割或移动真实页面，也不接收身份和结果数据。
- 顶栏和设置中没有平台切换动效模式入口，前端不读写 localStorage 切换动效键，服务端也不提供 `/api/preferences`。旧版留下的 `data/ui-preferences.json` 被安全忽略而不主动删除。reduced-motion、隐藏页面或无 WebGL 时直接完成切换。
- 平台切换的 WebGL Canvas 是该交接中唯一动画元素；不对 `platform-surface`、`main-pane`、任务栏、指标、表格、导航或 Inspector 写入 `transform`/`opacity`/`filter`/`will-change`，不读取或截图业务 DOM，不生成 DOM 纹理，UID、EncryptUin 和评论不得进入 GPU。`platform-switching` 期间只暂停 `.platform-surface` 工作区自身的 CSS animation/transition，不禁用 `pointer-events`；此时新触发的 WAAPI 界面动效直接收敛，工作区外新出现的弹窗或 Toast 也禁用入场动画。平台 Tab 仍可用于反向切换，停止按钮始终优先可用。两平台的 main-pane padding、intro 外框、command bar、metric 和输出 Tab 共享几何必须一致，切换前后关键矩形误差不超过 0.5 CSS px；应用层提交后立即恢复所有捕获的滚动坐标。只有 results table 可在非空结果异步回填后延迟再恢复一次；该机会同时绑定 platform/mode/view/switch version 和每个 view 的 result generation revision，普通 refresh 不取消，只有确认新 job generation 才会失效。2.5 s 超时，且用户在结果表上的 wheel/touch/pointer/key 任一操作会立即取消，避免覆盖新滚动意图。Layout Shift 为 0。
- WebGL2 使用一个 program/VAO，`depth:false`，每帧仅一次 `drawArrays(TRIANGLES,0,3)` 全屏绘制。没有 instance、VBO、纹理、FBO、readback 或 CPU 粒子数组。使用 `low-power`、premultiplied alpha，DPR 不超过 1.25，颜色缓冲不超过 1,200,000 像素；RAF 中不创建数组/对象/字符串也不查询布局，resize 沿用原 `startedAt` 并在更新分辨率 uniform 后按 `lastElapsed` 立即重绘，时钟和 commit 状态不变。
- 提交前取消保留源平台，提交后取消保留目标平台；快速 N→Q→N 只收敛到最后选择。应用层在全不透明 backing 内捕获首次提交异常并同栈重试一次；若约326ms的 `commit()` 仍返回 `false` 或抛错，过渡立即结算且不继续揭幕，只有当前应用代际可同步收敛。初始或运行中 reduced-motion、页面隐藏、WebGL2/context/shader/program/VAO/append/resize/任一draw失败、首次RAF申请失败或context loss都立即提交并单次结算Promise。正常到达 680 ms 时先将 Canvas 从合成树移除并清除 `platform-switching`/`aria-busy`，让目标页面稳定接管；下一 compositor RAF 才释放 GPU/监听器并 resolve `finished`，避免透明清屏或销毁 backing 形成末帧闪屏。异常路径仍立即完整清理；`pagehide`清理，`pageshow`若desired platform与当前不同则无动画收敛，并通过提交返回值保证当前generation的SSE只连接一次。取消平台或其他界面动画时，正在过渡的`<details>`依`data-expanded`同步`open`/`aria-expanded`并清理动画状态。

### 主工作区绢缎鼠标尾迹

- `PointerSilkTrail.create({ host, platform, enabled })` 仅在 `#mainWorkspace` 内惰性创建一张 `pointer-events:none` 的 WebGL2 Canvas，返回 `setEnabled` / `setPlatform` / `suspend(reason)` / `resume(reason)` / `destroy`。它只接受 `pointer:fine` 的 mouse 移动，不捕获指针、不阻断业务交互，也不覆盖导航、顶栏、右侧 Inspector 或弹窗。Follow 动力学参考 MIT 许可的 Makio MeshLine：4 条独立绢线各持有 20 个控制点，确定性参数覆盖参考范围，并以递增 spring `[0.041,0.054,0.068,0.079]` 反向配对递减 friction `[0.898,0.867,0.834,0.802]`，避免 high-spring/high-momentum 共振；每帧先从 point 19 倒序传播到 point 1，使 follower 读取前一帧 predecessor，再更新 head，避免正序更新造成同帧塌缩。head 相对其目标偏移位置的 lag 还经过 `MAX_HEAD_LAG_PX=32` 软限幅，限幅后同步回写速度。速度仍以 0.15 平滑；参考 world-space 线宽和偏移经相机平面投影为 CSS 像素，线宽上限 22 px、偏移半径上限 26 px，两端在 10% 范围内收尖。
- 热路径仅复用预分配的 `Float32Array`：80 个控制点、4 组速度/偏移和 160 个宽线顶点；每帧一次 `bufferSubData` 上传后执行 4 次 `TRIANGLE_STRIP` draw，材质 opacity 为 0.76，无纹理、FBO、随机数、粒子、模糊、后处理、业务 DOM 读取或每帧对象分配。客户端不引入 Vue/Three.js 运行时，只使用一个低功耗 WebGL2 program/VAO/VBO。最后一次移动后保持 72 ms，再用 348 ms 淡出，到 420 ms 立即清空并将空闲 RAF 降为 0。渲染 DPR 不超过 1.25，颜色缓冲不超过 800,000 像素；Canvas 与 ResizeObserver 只在首次合格移动后分配，上下文/编译/上传/绘制/RAF 异常会锁存失败并完整释放 GPU 表面。
- 关闭开关、reduced-motion 或粗指针会立即释放表面；任意弹窗打开、平台切换、页面 hidden/blur 则通过可叠加 reason 停止 RAF 并清空采样/画面，可保留已惰性分配的空 Canvas。恢复时不重放旧轨迹，只等新移动。`pagehide` 彻底 `destroy()`；BFCache `pageshow` 重建单例。桌面 `desktop-settings.json` v2 持久化 `closeBehavior` 与默认开启的 `cursorTrailEnabled`，v1 迁移保留关闭行为并补默认值，partial update 不重置未提交字段。无 Electron bridge 的浏览器模式只修改当前会话内存，刷新后默认开启，不写 localStorage/sessionStorage 或调用服务端偏好 API。

### 折叠 Inspector 的代理池提示

- Inspector 收起时，代理池 `starting` 或 `running + refreshing` 在主界面显示一个显式、可点击的全局提示；点击后切到代理池视图并展开 Inspector。Inspector 已展开、池稳定运行或停止时提示必须隐藏。
- 提示右边界必须避开 Inspector 的折叠 rail/overlay peek：桌面、`1280/821` 浮层断点与 `820/390` 窄屏断点均保留正间距且不得增加横向溢出。资源缓存变化后用真实 CSS 重新加载测量，不能仅依赖静态正则。
- 提示以 `building | refreshing | hidden` 签名去重，轮询同一状态不得重复写 live-region 文本或重播入场动画；平台切换期间也不播放提示入场。`aria-live`/`aria-atomic` 只属于内部状态文本，不让整个按钮反复播报。

### 并行歌曲活动进度

- 用户来源的 `sourceNotices` 与 `sourceErrors` 必须分开：未公开听歌排行/喜欢的音乐显示为友好的中性来源提示并注明已跳过，不向任务区输出原始 422/英文调用栈；其他来源继续运行，单一私密来源以确认 0 首正常结算但覆盖不完整。真实传输、协议和目录完整性错误仍保留错误语义；旧检查点中的隐私 422 字符串在展示层向前兼容映射为同一提示。
- 网易云 `comment_new` 只含顶层评论，但 `totalComments` 是顶层 + 楼中楼的组合提示。完整范围的活动行显示 `(顶层已搜索 + 回复已搜索) / totalComments`，分列 `pagesProcessed` 顶层页与 `floorPagesProcessed` 楼中楼页，并区分 `comment-page` / `comment-floor` 在途请求。仅顶层范围显示顶层搜索数/页数及“上游总数含未读回复”，不生成顶层百分比。
- 组合总数不推导调度或终态。完整范围要求顶层半开时间覆盖完成，且每个 `(songId,parentCommentId)` 都以自身严格递增 time cursor 走到 `hasMore=false`；仅顶层范围只要求前者。每个 parent 同时只允许一页，不同 parent/歌曲可跨 Lane 并行，成功续页可转 Lane，失败接管沿用同一逻辑预算。一个巨大 parent 因 cursor 依赖仍是 single-flight，协议上限约 `40 / (RTT + 本地开销)` 条/秒，可能仍接近 40/s。恢复时优先持久未完 floor 工作，不把不同 parent 串行化。
- Source state/coverage v4 与 parallel state v2 都将 `commentScope` 作为兼容键；root-only 的 state/result/coverage 使用独立 `-root-only` 路径。Resume v4 保存 `includeCommentFloors`，旧版本默认恢复为完整范围；跨 scope 不复用完成、覆盖或结果。
- 新建、恢复扩容或自适应拆分的显式顶层 cursor 链统一从 `pageNo=2` 开始；每个新楼中楼从 `time=-1` 和第 1 页开始。`maxCommentPagesPerSong` 只限制顶层页，达到上限且仍有未读顶层范围时发出独立 `truncated` 终态，客户端比例最多 99.99%；楼中楼不占该上限，只受总逻辑请求上限与取消约束。
- 活动表为“评论读取进度”保留 340 px 列宽和至少 300 px 内容宽度，详细的已搜索/上游总数、顶层/楼中楼页数、在途分片与最长请求允许自然换行；窄视口使用表格横向滚动，不得用单行省略号隐藏进度语义。
- 全部时间排行成功而最近一周排行为空或未公开时，周榜只缺少补充标签，不影响完整歌曲目录，不显示任务错误。若整个目录刷新失败但检查点中仍有旧的完整目录，任务可继续，界面只显示“继续使用检查点目录”的中性提示；原始诊断仍保留在状态与日志链路。

## 歌曲搜索

- 统一响应 DTO：`{ platform, query, songs: [{ id, mid?, name, artists, album?, durationMs? }] }`。
- 网易云使用 `cloudsearch` 的单曲类型；QQ 使用现有 QQ Client，并通过固定的本机直连 lookup Lane 请求搜索 CGI。
- 搜索输入 2–80 字符，返回上限 10 条，新请求会取消旧请求。候选项用歌名、歌手、专辑和 ID 帮助消歧。
- 选中后将 ID 写入隐藏字段，只有当前查询与候选代际匹配时才允许启动。用户继续修改文本会清除旧 ID。
- 纯数字输入继续作为高级兼容路径，并查询元数据后显示确认结果。
- Dashboard 的 QQ 歌名搜索与数字歌曲详情属于低频 lookup-only 控制请求，固定使用一条 4 秒有界的本机直连 Lane；它们忽略运行中的代理池、手动代理字段和伪造的代理参数，但仍保留全局任务 lease、Governor、Gate、取消与旧响应代际保护。只有正式评论/来源扫描按任务配置使用代理池或显式代理，并在该代理路径上保持 fail-closed。

## 用户参数与进度词汇

| 界面名称 | 内部兼容字段 | 含义 |
| --- | --- | --- |
| 每出口工作线程（网易云） | `workersPerProxy` / `workersPerLane` | 网易云同一出口上的调度工作数；source 默认 1。8 出口要达到 32 Worker 必须设为 4；QQ GUI 不提供此容量输入 |
| 总工作线程上限 | `hostConcurrency` / `maxWorkers` | 整个任务的 Worker 硬上限；NetEase 实际为 `min(出口数 × 每出口 Worker, 总上限)`，所以 8×4 还需总上限 32；QQ likes 直接采用该总数并自动派生每出口许可，QQ song 固定一条链 |
| 任务出口上限 | `maxProxyLanes` | `0` 表示使用当前全部已验证独立出口 |
| 每出口请求启动间隔 | `minDelayMs` | 同一出口相邻远端请求开始的真实最小间隔；两平台都不会因增加 Worker 而缩短它 |
| 请求上限（0 不限） | `requestBudget` | 网易云串行/并行都按逻辑历史、顶层或楼中楼页各计一次；同一 root 页跨 Lane failover 复用预算与顶层 cap 名额，物理重试、目录和水合不重复扣减 |
| 读取楼中楼回复 | `includeCommentFloors` / `commentScope` | 两个网易云视图默认关闭；开启时警告会极大降速，关闭映射 `root-only-v1`，零 floor I/O 且使用独立断点/结果 |
| 已读评论 | `commentsInspected` | 网易云展示顶层 + `replyCommentsInspected`，QQ 保持自身评论数；不用页数代替 |

易混淆的目标、歌曲、出口、Worker、间隔、请求上限和“新建状态”都要有可键盘聚焦的 `?` 说明；不依赖鼠标 hover 才能读取。

## 验收不变量

- Obsidian Silk Aperture 在 680 ms 先脱离 Canvas 与 busy 标记，下一 compositor RAF 再销毁 GPU 资源并结算 Promise；该交接不得闪回源页面，完成后不留 `requestAnimationFrame`、事件监听器或显存资源。测试同时证明唯一模式、五条确定性褶皱/等高线、244 ms 后全屏 alpha=1、326 ms 唯一提交、每帧单次 fullscreen draw、无 instance/额外 GPU 资源/业务 DOM 动画写入。
- 鼠标尾迹测试必须证明 Canvas 惰性且只属于 `#mainWorkspace`，输入只有 fine mouse，4×20 链按 point 19→1 倒序传播后才更新 head，递增 spring 与递减 friction 的确定性抗共振配对覆盖参考范围，并保留 32 px head-lag 软限幅。对 100 px 半径、持续 240 帧的圆周输入，必须分别扫描 0.18、0.20、0.215、0.265 rad/frame，并验证四条线的全部 20 个点始终处于 160 px 包络内。world-space 宽度/偏移投影后分别受 22 px/26 px 上限约束，峰值 opacity 为 0.76，每帧只有一次上传和 4 次 40 顶点 `TRIANGLE_STRIP` draw。实现不得引入纹理、FBO、随机数、粒子、模糊、后处理或业务 DOM 捕获；420 ms 空闲、弹窗、平台切换、hidden/blur 后不得留 RAF 或过期轨迹，DPR/像素上限不可回归，关闭、减少动效、粗指针与 pagehide 还必须释放 Canvas/GPU 资源，BFCache 只重建一个实例。设置测试需覆盖 v1→v2迁移、默认 true、partial update、桌面原子持久化与浏览器会话隔离。
- 代理池提示测试必须覆盖 Inspector 折叠/展开、starting/refreshing/stable 状态、点击展开，以及相同轮询状态不重复写 DOM；真实 CSS reload 后还要在桌面、`1280/821` 与 `820/390` 断点测得提示到右栏为正间距且不增加横向溢出。PDF 文件名测试必须覆盖双平台完整目标、Windows 禁止/控制字符、尾部点号/空格、设备保留名、180 字符主文件名上限和固定 `.pdf`，PDF smoke 必须覆盖 renderer-to-IPC 链路、累计耗时单调性和完整阶段序列。桌面关闭测试必须覆盖系统关闭与自绘按钮、取消、后台、记住选择、重复/过期决定、renderer 不可用，以及退出期间的最终检查点状态；真实 Electron QA 还要确认没有原生 `showMessageBox`、关闭弹窗与客户端视觉一致。
- 网易云 scope 测试必须覆盖：两视图默认关闭、常驻极大降速警告、恢复任务回填已保存值且开关可反复切换；root-only 零 floor I/O、组合 total 不作顶层百分比、PDF 标注未读回复；state/coverage/parallel/resume 键与 `-root-only` 路径阻止跨 scope 复用。完整范围还要覆盖 `comment_new` 组合总数但仅顶层行，floor 40 条分页、`time=-1` 起点、严格递增且只信 `hasMore=false`；同 parent 单飞、多 parent/歌曲跨 Lane 并行、成功转 Lane 与失败复用预算；每页一次 `appendBatch` write + fsync 先于 cursor/状态，强刷 single-flight、4 页或页完成时的 400 ms 边界、写中 dirty 页留待下批，终态/停止/错误强刷；root + 全部 floor 共同终态与 PDF 父评论来源。
- 来源选择测试必须覆盖滑动高亮的几何对齐、听歌排行↔喜欢歌曲快速反向、排行范围的 `aria-hidden`/`inert` 与 reduced-motion 静态收敛；还要覆盖串行/代理池的排行与喜欢隐私、单一/组合来源、覆盖不完整、旧 422 文案映射，以及真实故障仍为错误。响应式真实 QA 在 Windows `win32` 1293×841 CSS px（对应 1940×1261@150% 截图）确认顶栏和文档无溢出、badge 单行、任务面板间隔 21 px；并在 1481/1480/1381/1380/1294/1293/1281/1280/1238/1237/1211/1210/1000/900/821/820/390 px 全部验证无 topbar/document 溢出。网易云↔QQ 在 1381/1293/1280/1238/1237/900 px 的 portal 锚点均为 `dx=0`、`dw=0`，browser 820/390 px 也无横向溢出。
- 平台快速连续切换最终仅保留最后选择；扫描运行时不允许通过切换绕过停止/互斥逻辑。
- 网易云登录 Cookie 只在网易云工作区显示为“已保存网易云登录”；QQ 工作区固定显示“本地服务”并隐藏网易云二维码登录按钮。
- 搜索的旧响应不能覆盖新查询；平台、查询和选中 ID 必须同代。
- `>1280px` 时，展开的 336 px 任务面板使 `.main-pane` 以 367 px 左内边距连续让位，sidebar 右边与内容左边保持 21 px 间隔；右侧节点详情仍用可插值的 54px↔310px 网格轨道压缩/释放主工作区。`<=1280px` 时两个侧面板都是浮层并沿用互斥逻辑，不得把主内容挤没。
- 保持更新代际、检查点、结果隔离、代理 fail-closed、减少动效、窄屏和键盘焦点现有测试不变量。
- 两平台的真实发车都先取 Gate 容量和至少 50 ms 聚合启动槽，再在 HTTP 边界预约 Lane Governor；物理重试不绕过。20 starts/s 是理论硬上限，不是实网观测。NetEase source 默认仍是 1 Worker/出口与 2500/800 ms；8 出口、32 Worker 需 `workersPerProxy=4`、`hostConcurrency=32`，300/100 是用户调优。本机一次 synthetic 离线集成基准在 32 独立 parent、8×4 Worker、300+`U[0,100)` ms、50 ms Gate、200 ms 合成 RTT、满 40 回复页下，1280 条/1795 ms，约 713 replies/s；不承诺实网性能。QQ 新任务每出口仍为 300–399 ms。
