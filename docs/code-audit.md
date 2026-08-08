# 全局代码审计

本文记录当前主线仍成立的审计结论与修复验收边界，不把“已发现”写成“已修复”。审计基线为 `v0.25.0` / `821a0664e119875fb4e685330b6474701665ede2`，日期为 2026-08-08。两名独立只读审计 agent 分别检查代码结构和项目记忆；主审同时复核 HTTP、Electron、持久化、测试门禁与依赖。基线门禁为 `npm run check`、417/417 测试、build、QQ benchmark、两个前端 JS 语法检查和 `git diff --check` 全绿，`npm audit` 的生产与完整依赖均为 0 个已知漏洞。P0 为 0。

## 未修复的 P1

1. **网易云结果与检查点的耐久提交顺序。** `src/results.ts` 只 `appendFile()` 而不 `fsync()`；source/parallel 的部分统计又会在命中结果耐久落盘前推进并可能被强制 checkpoint。突然断电或结果写入失败时，检查点可能领先 JSONL；损坏且无换行的尾行还会与下一条追加内容粘连。修复必须让 NetEase writer 对齐 QQ writer 的完整 write loop + sync 顺序，修复尾行边界，并让页面统计/cursor 只在全部命中耐久写入后同步提交。
2. **同一逻辑任务缺少跨进程生命周期锁。** `TaskCoordinator` 只在进程内互斥，Electron 也没有 single-instance lock。两个桌面客户端、CLI 或 Web 服务可以同时读取并覆盖同一确定性检查点，独立 JSONL writer 也可能重复追加。修复应同时增加 Electron 单实例体验和按 canonical target/outputPath 的跨进程任务 lease；只做其中一层不足以覆盖 CLI 与 Dashboard 并发。
3. **QQ 实时结果暴露完整 EncryptUin。** `web/app.js` 的实时结果行直接渲染 `authorEncryptUin`，与解析实验、工具栏和 PDF 已采用的默认掩码边界不一致。实时 REST/SSE、平台切换和结算路径都必须只显示安全标签/掩码，完整 token 不得进入可见 DOM、截图或录屏。
4. **Web 控制台的可信本机边界没有被服务端强制执行。** CLI 允许任意 `--host`，HTTP 路由没有统一校验 loopback remote、Host、Origin/Sec-Fetch 或 CSRF token；对象 POST 也不要求 JSON Content-Type。绑定 `0.0.0.0`/局域网后，未认证的任务、日志、登录和代理池接口会暴露给其他主机，且存在跨站触发副作用的风险。修复应默认且强制 loopback，或引入显式远程模式、认证与 Origin/Host/CSRF 防护；不能只依赖浏览器 CORS 读限制。

## 未修复的 P2 / 门禁缺口

- `body()` 未统一要求 plain object，部分 POST 对 `null`/数组返回 500；所有对象型路由应统一映射为不泄漏内部属性的 400。
- Electron 主窗口把任意外部导航交给 `shell.openExternal()`；应以纯策略函数限制为必要的 HTTPS 官方域名，拒绝 `file:`、自定义 scheme、userinfo 和异常端口。
- `src/qq-music/proxy-fetch.ts` 聚合上游响应时没有字节上限；应在 schema 解析前限制正文并在超限时销毁流。
- `desktop.log` 和任务日志没有轮转/保留上限；长期运行可能无界占用磁盘。Unix CLI/共享目录下的 NetEase JSONL 与任务日志还应显式使用私有文件权限。
- `tsconfig.json` 只检查 `src/**/*.ts`，测试由 `tsx` 转译执行而不做类型检查。独立 strict test typecheck 已发现过时的 Governor `concurrency` 夹具、缺失 `getSongInfo` 的 fake 和 `ScanEstimate` 返回字段未声明等漂移。应增加 `tsconfig.test.json` / `npm run check:test` 并纳入交付门禁。
- Windows 安装包当前没有代码签名配置；README 已说明 macOS 为 ad-hoc、未公证，也应在正式发行说明中如实说明 Windows SmartScreen/签名状态。

## 已验证的不变量

- 同一 Lane 的 Governor 按真实请求启动间隔串行预约；Worker 不会缩短用户设置，QQ 301 不会误映射为网易云登录。
- QQ song 保持单 SeqNo 链；likes 受 host cap、LaneAllocator、50 ms Gate 与 checkpoint slots 约束。页内相等/局部乱序允许，不安全的恢复页只隔离当前歌曲且不推进游标。
- 使用代理池或显式代理后保持 fail-closed；coverage、resume、代理池和 PDF 目的路径已有各自的跨进程锁。
- 原子 JSON 使用唯一临时名、`fsync`、Windows rename 有界退避和安全遗留恢复；PDF 同路径晚到 rename 不会覆盖后续重试。
- QQ results/SSE/log/report 绑定 generation；报告按固定 JSONL 字节截止点读取并重建可信官方链接。
- Electron 使用 sandbox、context isolation 和禁用 node integration；隐藏报告窗口限制导航并有分阶段超时。
- 四个 viewKey、渲染批处理、活动行上限、WebGL 异常清理、更新前 acquisition barrier 均有现有测试证据。

## 修复后的最低回归矩阵

- 结果耐久性：损坏尾行、write/sync 失败、慢写期间 checkpoint timer、source/parallel 精确游标恢复。
- 多实例：同任务第二进程拒绝、不同任务允许、取消/崩溃释放、跨子进程锁、record/likes/both 共享输出所有权。
- 隐私：用合成 EncryptUin sentinel 覆盖初始 REST、SSE、平台切换、结算和 PDF，断言完整值不进入可见 DOM/日志/报告正文。
- HTTP：loopback/Host/Origin/Content-Type/CSRF 正反例，以及所有对象型 POST 的 null/数组/字符串 400。
- Electron：外链 scheme/host allowlist；QQ 大响应上限；日志轮转和私有权限。
- 门禁：`npm run check`、新增 test typecheck、`npm test`、`npm run build`、`npm run bench:qq`、两个 JS 语法检查、`npm run desktop:smoke:mac` 与 `git diff --check`。
