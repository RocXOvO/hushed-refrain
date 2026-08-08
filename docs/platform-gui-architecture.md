# 多平台 GUI 与歌曲搜索架构

## 目标

- 网易云音乐与 QQ 音乐拥有明确不同的视觉语言，但共用一套任务状态、结果、日志、代理池和更新逻辑。
- 平台切换使用“双域声谱折幕（Spectral Fold Handoff）”：一层不透明声谱幕完整遮蔽视口后交接目标平台，业务 DOM 始终不参与动画。
- 用户以“歌名 / 歌手”搜索并选择歌曲，内部仍以平台歌曲 ID 作为扫描主键。
- 统一面向用户的参数名称和进度口径，保留现有 API/检查点字段以兼容旧版。

## 界面层

### 主题，不复制业务 DOM

`body[data-platform="netease"|"qq"]` 只切换视觉 token、平台标识、提示文案和相关表单。任务栏、结果表、日志、估算、右侧节点详情和导出保持单实例，避免两套 GUI 的事件、任务代际和缓存状态漂移。

QQ 视觉层重置强调色、平台识别区、表单面板、指标和选中态；网易云保持现有中性工作台。两者都使用低开销的颜色、边框、阴影和不透明背景，不引入长时间模糊或玻璃效果。

### 双域声谱折幕

- `PlatformWaveTransition.create({ sourcePlatform, targetPlatform, direction, sourceAnchor, targetAnchor, commit })` 返回 `{ finished, cancel }`。内部状态固定为 `idle → preparing → covering → covered/commit → revealing → settled`；`commit()` 是唯一允许修改 platform/mode、`hidden`/`inert`、结果/SSE 和 ARIA 的入口，只调用一次并显式返回布尔值。
- 一次过渡约 680 ms：0–90 ms 是源平台细载波起音，90–326 ms 由源侧扫入深色哑光声谱幕，约 326 ms/48% 时全视口必须完整且不透明并提交 DOM，326–590 ms 以目标色揭幕，590–680 ms 由两条目标色细载波向目标 Tab 收束。网易云使用石墨黑/暖灰/红，QQ 使用深青黑/青绿/薄荷；不使用紫色渐变、随机粒子、模糊玻璃、泛光云、弹跳或长尾。
- Canvas 是唯一动画元素；不对 `platform-surface`、`main-pane`、任务栏、指标、表格、导航或 Inspector 写入 `transform`/`opacity`/`filter`/`will-change`，不读取或截图业务 DOM，不生成 DOM 纹理，UID、EncryptUin 和评论不得进入 GPU。`platform-switching` 期间只暂停 `.platform-surface` 工作区自身的 CSS animation/transition，不禁用 `pointer-events`；此时新触发的 WAAPI 界面动效直接收敛，工作区外新出现的弹窗或 Toast 也禁用入场动画，因此 Canvas 是唯一继续变化的视觉元素。平台 Tab 仍可用于反向切换，停止按钮始终优先可用。两平台的 main-pane padding、intro 外框、command bar、metric 和输出 Tab 共享几何必须一致，切换前后关键矩形误差不超过 0.5 CSS px；应用层捕获 document、drawer、`#runtimeInspector`、Inspector 内容、主导航、`#globalPlatformSwitch`、输出 Tab 与各 `.table-wrap` 的滚动坐标，提交后立即恢复一次，并在当前平台代际的结果行异步回填后再次恢复，避免空表临时压缩把非零位置永久钳制为 0。Layout Shift 为 0。
- WebGL2 使用 `gl_VertexID` 全屏三角形：1 program、1 VAO、0 VBO/纹理/FBO，每帧仅一次 `drawArrays(TRIANGLES, 0, 3)`。Fragment shader 基于方向轴和 signed distance，经 `fwidth` 抗锯齿绘制不透明幕、4–6 条确定性声谱等高线、主交接线和 Tab 载波。使用 `low-power`，关闭 antialias/depth/stencil/preserveDrawingBuffer，开启 premultiplied alpha；DPR 不超过 1.25，颜色缓冲不超过 1,600,000 像素。RAF 中不创建数组/对象/字符串也不查询布局；resize 沿用原 `startedAt`。
- 提交前取消保留源平台，提交后取消保留目标平台；快速 N→Q→N 只收敛到最后选择。应用层在全不透明幕内捕获首次提交异常并同栈重试一次；若约 326 ms 的 `commit()` 仍返回 `false` 或抛错，过渡立即结算且不继续揭幕，只有当前应用代际可同步收敛。初始或运行中 reduced-motion、页面隐藏、WebGL2/context/shader/program/VAO/append/resize/draw 失败、首次 RAF 申请失败或 context loss 都立即提交并单次结算 Promise；清理 RAF、resize/visibility/media/context-loss 监听、VAO、program、context、Canvas、`platform-switching` 和 `aria-busy`。`pagehide` 清理，`pageshow` 若 desired platform 与当前不同则无动画收敛，并通过提交返回值保证当前 generation 的 SSE 只连接一次。取消平台或其他界面动画时，正在过渡的 `<details>` 依 `data-expanded` 同步 `open`/`aria-expanded` 并清理动画状态。

## 歌曲搜索

- 统一响应 DTO：`{ platform, query, songs: [{ id, mid?, name, artists, album?, durationMs? }] }`。
- 网易云使用 `cloudsearch` 的单曲类型；QQ 使用现有 QQ Client 和代理 Lane 请求搜索 CGI。
- 搜索输入 2–80 字符，返回上限 10 条，新请求会取消旧请求。候选项用歌名、歌手、专辑和 ID 帮助消歧。
- 选中后将 ID 写入隐藏字段，只有当前查询与候选代际匹配时才允许启动。用户继续修改文本会清除旧 ID。
- 纯数字输入继续作为高级兼容路径，并查询元数据后显示确认结果。
- 所有 QQ 搜索在代理池运行时 fail-closed，不回退直连；与正在运行的扫描任务共享全局任务互斥。

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

- 声谱 Canvas 在动画结束后一帧内从 DOM 移除，不留 `requestAnimationFrame`、事件监听器或显存资源；测试同时证明提交点全屏 alpha=1、每帧仅一次全屏三角形 draw、无随机数/额外 GPU 资源/业务 DOM 动画写入。
- 平台快速连续切换最终仅保留最后选择；扫描运行时不允许通过切换绕过停止/互斥逻辑。
- 网易云登录 Cookie 只在网易云工作区显示为“已保存网易云登录”；QQ 工作区固定显示“本地服务”并隐藏网易云二维码登录按钮。
- 搜索的旧响应不能覆盖新查询；平台、查询和选中 ID 必须同代。
- 右侧节点详情在桌面宽屏用可插值的 54px↔310px 网格轨道连续压缩/释放主工作区，不得离散跳变；`<=1280px` 改为浮层，避免内容被挤没。
- 保持更新代际、检查点、结果隔离、代理 fail-closed、减少动效、窄屏和键盘焦点现有测试不变量。
- 扫描任务聚合发车默认至少间隔 50ms；QQ 新任务每出口为 300–399ms。界面、估算器和恢复提示必须使用相同语义。
