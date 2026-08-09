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

桌面 PDF 从导出开始发出 `save-dialog` 进度，`elapsedMs` 是包含保存对话框等待的单调累计耗时，不是独立阶段耗时。默认文件名由 `resultReportFilename` 写入完整 canonical UID/EncryptUin，这是用户明确可见的导出信息；`sanitizeWindowsPdfFilename` 只负责把 Windows 禁止字符/控制字符替换为兼容字符、清理尾部点号/空格、避开设备保留名、将主文件名限制到 180 字符并固定 `.pdf`，不对目标做脱敏。日志、错误和诊断仍不得包含完整目标。选定路径后打开持久进度浮层，持续显示读取、字体、生成、写入阶段与累计耗时，并提供显式取消；`showModal()` 暂不可用时回退到 `show()`，展示接口都失败也不能中断实际导出。终态必须关闭隐藏报告窗口、移除进度监听并恢复导出按钮；选定路径后的阶段全部有界。打包冒烟必须从 renderer 的 `window.ncmDesktop` 穿过 preload/IPC，再完成隐藏 Chromium 加载、字体、打印与原子写入，并验证完整进度序列、目标路径和 `%PDF-` 文件头。

### Obsidian Silk Aperture 交接

- `PlatformWaveTransition.create({ sourcePlatform, targetPlatform, direction, commit })` 返回 `{ finished, cancel }`。内部状态固定为 `idle → preparing → covering → covered/commit → revealing → settled`；`commit()` 是唯一允许修改 platform/mode、`hidden`/`inert`、结果/SSE 和 ARIA 的入口，只调用一次并显式返回布尔值。
- 一次过渡约 680 ms。深色绢幕按 Tab 方向收拢，244 ms 已完整遮住视口；shader 在 244–404 ms 遮罩窗口显式返回 `alpha=1`，约 326 ms/48% 在源色经中性黑曜过渡到目标色的交界处唯一提交 DOM，404 ms 才开始揭幕。网易云使用深红/暖色绢光，QQ 使用石墨绿/品牌绿/柔和薄荷绢光；不使用粒子、无限环、方格铺屏、模式选择、紫色渐变、模糊玻璃、弹跳或循环长尾。
- Fragment shader 直接生成五条确定性绢缎褶皱/等高线、门帘边缘、轻微箔线与暗部颗粒，以 `fwidth` 给边界抗锯齿，颜色从源平台继续收敛到中性 void 再进入目标平台。高光用有界乘法近似而不用 `pow`/`exp`，grain 使用低成本算术 hash 而不用 sine hash。它不读取、截图、分割或移动真实页面，也不接收身份和结果数据。
- 顶栏和设置中没有平台切换动效模式入口，前端不读写 localStorage 切换动效键，服务端也不提供 `/api/preferences`。旧版留下的 `data/ui-preferences.json` 被安全忽略而不主动删除。reduced-motion、隐藏页面或无 WebGL 时直接完成切换。
- 平台切换的 WebGL Canvas 是该交接中唯一动画元素；不对 `platform-surface`、`main-pane`、任务栏、指标、表格、导航或 Inspector 写入 `transform`/`opacity`/`filter`/`will-change`，不读取或截图业务 DOM，不生成 DOM 纹理，UID、EncryptUin 和评论不得进入 GPU。`platform-switching` 期间只暂停 `.platform-surface` 工作区自身的 CSS animation/transition，不禁用 `pointer-events`；此时新触发的 WAAPI 界面动效直接收敛，工作区外新出现的弹窗或 Toast 也禁用入场动画。平台 Tab 仍可用于反向切换，停止按钮始终优先可用。两平台的 main-pane padding、intro 外框、command bar、metric 和输出 Tab 共享几何必须一致，切换前后关键矩形误差不超过 0.5 CSS px；应用层提交后立即恢复所有捕获的滚动坐标。只有 results table 可在非空结果异步回填后延迟再恢复一次；该机会同时绑定 platform/mode/view/switch version 和每个 view 的 result generation revision，普通 refresh 不取消，只有确认新 job generation 才会失效。2.5 s 超时，且用户在结果表上的 wheel/touch/pointer/key 任一操作会立即取消，避免覆盖新滚动意图。Layout Shift 为 0。
- WebGL2 使用一个 program/VAO，`depth:false`，每帧仅一次 `drawArrays(TRIANGLES,0,3)` 全屏绘制。没有 instance、VBO、纹理、FBO、readback 或 CPU 粒子数组。使用 `low-power`、premultiplied alpha，DPR 不超过 1.25，颜色缓冲不超过 1,200,000 像素；RAF 中不创建数组/对象/字符串也不查询布局，resize 沿用原 `startedAt` 并在更新分辨率 uniform 后按 `lastElapsed` 立即重绘，时钟和 commit 状态不变。
- 提交前取消保留源平台，提交后取消保留目标平台；快速 N→Q→N 只收敛到最后选择。应用层在全不透明 backing 内捕获首次提交异常并同栈重试一次；若约326ms的 `commit()` 仍返回 `false` 或抛错，过渡立即结算且不继续揭幕，只有当前应用代际可同步收敛。初始或运行中 reduced-motion、页面隐藏、WebGL2/context/shader/program/VAO/append/resize/任一draw失败、首次RAF申请失败或context loss都立即提交并单次结算Promise。正常到达 680 ms 时先将 Canvas 从合成树移除并清除 `platform-switching`/`aria-busy`，让目标页面稳定接管；下一 compositor RAF 才释放 GPU/监听器并 resolve `finished`，避免透明清屏或销毁 backing 形成末帧闪屏。异常路径仍立即完整清理；`pagehide`清理，`pageshow`若desired platform与当前不同则无动画收敛，并通过提交返回值保证当前generation的SSE只连接一次。取消平台或其他界面动画时，正在过渡的`<details>`依`data-expanded`同步`open`/`aria-expanded`并清理动画状态。

### 主工作区绢缎鼠标尾迹

- `PointerSilkTrail.create({ host, platform, enabled })` 仅在 `#mainWorkspace` 内惰性创建一张 `pointer-events:none` 的 WebGL2 Canvas，返回 `setEnabled` / `setPlatform` / `suspend(reason)` / `resume(reason)` / `destroy`。它只接受 `pointer:fine` 的 mouse 移动，不捕获指针、不阻断业务交互，也不覆盖导航、顶栏、右侧 Inspector 或弹窗。视觉与动力学直接参考 MIT 许可的 Makio MeshLine Follow 源码：4 条独立绢线各持有 20 个控制点、固定环形偏移和不同的 spring/friction，头点受力追随指针，后续点以 `lerp(0.9)` 逐级跟进；指针速度经 0.15 平滑后控制共享线宽，两端在 10% 范围内收尖。客户端不引入 Vue/Three.js 运行时，而是用一个低功耗 WebGL2 program/VAO/VBO 将四条抗锯齿 triangle strip 直接渲染。
- 热路径仅复用预分配的 `Float32Array`：80 个控制点、4 组速度和 160 个宽线顶点；无随机数、粒子、模糊、业务 DOM 读取或每帧对象分配。最后一次移动后保持 72 ms，再用 348 ms 淡出，到 420 ms 立即清空并将空闲 RAF 降为 0。渲染 DPR 不超过 1.25，颜色缓冲不超过 800,000 像素；Canvas 与 ResizeObserver 只在首次合格移动后分配，上下文/编译/上传/绘制/RAF 异常会锁存失败并完整释放 GPU 表面。
- 关闭开关、reduced-motion 或粗指针会立即释放表面；任意弹窗打开、平台切换、页面 hidden/blur 则通过可叠加 reason 停止 RAF 并清空采样/画面，可保留已惰性分配的空 Canvas。恢复时不重放旧轨迹，只等新移动。`pagehide` 彻底 `destroy()`；BFCache `pageshow` 重建单例。桌面 `desktop-settings.json` v2 持久化 `closeBehavior` 与默认开启的 `cursorTrailEnabled`，v1 迁移保留关闭行为并补默认值，partial update 不重置未提交字段。无 Electron bridge 的浏览器模式只修改当前会话内存，刷新后默认开启，不写 localStorage/sessionStorage 或调用服务端偏好 API。

### 折叠 Inspector 的代理池提示

- Inspector 收起时，代理池 `starting` 或 `running + refreshing` 在主界面显示一个显式、可点击的全局提示；点击后切到代理池视图并展开 Inspector。Inspector 已展开、池稳定运行或停止时提示必须隐藏。
- 提示以 `building | refreshing | hidden` 签名去重，轮询同一状态不得重复写 live-region 文本或重播入场动画；平台切换期间也不播放提示入场。`aria-live`/`aria-atomic` 只属于内部状态文本，不让整个按钮反复播报。

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
| 每出口工作线程（网易云） | `workersPerProxy` / `workersPerLane` | 网易云同一出口上的调度工作数；QQ GUI 不提供此容量输入 |
| 总工作线程上限 | `hostConcurrency` / `maxWorkers` | 整个任务在本机可同时调度的 Worker 硬上限；QQ likes 直接采用该总数并按 `ceil(上限 / 出口数)` 自动派生每出口许可，QQ song 因 SeqNo 依赖固定一条链 |
| 任务出口上限 | `maxProxyLanes` | `0` 表示使用当前全部已验证独立出口 |
| 每出口请求启动间隔 | `minDelayMs` | 同一出口相邻远端请求开始的真实最小间隔；两平台都不会因增加 Worker 而缩短它 |
| 请求上限（0 不限） | `requestBudget` | 当次任务允许的逻辑评论页请求数 |
| 已读评论 | `commentsInspected` | 实际解析过的评论数，两平台统一，不用页数代替 |

易混淆的目标、歌曲、出口、Worker、间隔、请求上限和“新建状态”都要有可键盘聚焦的 `?` 说明；不依赖鼠标 hover 才能读取。

## 验收不变量

- Obsidian Silk Aperture 在 680 ms 先脱离 Canvas 与 busy 标记，下一 compositor RAF 再销毁 GPU 资源并结算 Promise；该交接不得闪回源页面，完成后不留 `requestAnimationFrame`、事件监听器或显存资源。测试同时证明唯一模式、五条确定性褶皱/等高线、244 ms 后全屏 alpha=1、326 ms 唯一提交、每帧单次 fullscreen draw、无 instance/额外 GPU 资源/业务 DOM 动画写入。
- 鼠标尾迹测试必须证明 Canvas 惰性且只属于 `#mainWorkspace`，输入只有 fine mouse，4×20 弹簧链、速度线宽、端点 taper、4 条 40 顶点 triangle strip、420 ms 与 DPR/像素上限不可回归，并明确排除随机数、粒子、模糊和业务 DOM 捕获；420 ms 空闲、弹窗、平台切换、hidden/blur 后不得留 RAF 或过期轨迹，关闭、减少动效、粗指针与 pagehide 还必须释放 Canvas/GPU 资源，BFCache 只重建一个实例。设置测试需覆盖 v1→v2迁移、默认 true、partial update、桌面原子持久化与浏览器会话隔离。
- 代理池提示测试必须覆盖 Inspector 折叠/展开、starting/refreshing/stable 状态、点击展开，以及相同轮询状态不重复写 DOM；PDF 文件名测试必须覆盖双平台完整目标、Windows 禁止/控制字符、尾部点号/空格、设备保留名、180 字符主文件名上限和固定 `.pdf`，PDF smoke 必须覆盖 renderer-to-IPC 链路、累计耗时单调性和完整阶段序列。
- 平台快速连续切换最终仅保留最后选择；扫描运行时不允许通过切换绕过停止/互斥逻辑。
- 网易云登录 Cookie 只在网易云工作区显示为“已保存网易云登录”；QQ 工作区固定显示“本地服务”并隐藏网易云二维码登录按钮。
- 搜索的旧响应不能覆盖新查询；平台、查询和选中 ID 必须同代。
- 右侧节点详情在桌面宽屏用可插值的 54px↔310px 网格轨道连续压缩/释放主工作区，不得离散跳变；`<=1280px` 改为浮层，避免内容被挤没。
- 保持更新代际、检查点、结果隔离、代理 fail-closed、减少动效、窄屏和键盘焦点现有测试不变量。
- 扫描任务聚合发车默认至少间隔 50ms；QQ 新任务每出口为 300–399ms。界面、估算器和恢复提示必须使用相同语义。
