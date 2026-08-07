document.documentElement.dataset.desktopPlatform = new URLSearchParams(location.search).get("desktop") || "web";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const el = {
  parallelForm: $("#parallelForm"), sourceForm: $("#sourceForm"), parallelUid: $("#parallelUid"), uid: $("#uid"),
  songId: $("#songId"), songPreview: $("#songPreview"), songLookup: $("#songLookupButton"), lookup: $("#lookupButton"),
  userPreview: $("#userPreview"), userNickname: $("#userNickname"), userMeta: $("#userMeta"), recordProbe: $("#recordProbe"), likesProbe: $("#likesProbe"),
  poolStatus: $("#poolStatus"), poolEntries: $("#poolEntries"), poolTable: $("#poolTableBody"), poolToggle: $("#poolToggleButton"),
  poolDiscovery: $("#poolDiscovery"), clashPoolPane: $("#clashPoolPane"), clashConfigField: $("#clashConfigField"), clashConfig: $("#clashConfigSelect"), poolSize: $("#poolSize"), poolCandidates: $("#poolCandidates"), externalPoolPane: $("#externalPoolPane"), externalProxies: $("#externalProxies"),
  parallelStart: $("#parallelStartButton"), sourceStart: $("#sourceStartButton"), dryRun: $("#dryRunButton"), stop: $("#stopButton"), refresh: $("#refreshButton"),
  taskTitle: $("#taskTitle"), status: $("#statusMetric"), progressLabel: $("#progressLabel"), progress: $("#progressMetric"), workLabel: $("#workLabel"), work: $("#workMetric"),
  matches: $("#matchesMetric"), requests: $("#requestsMetric"), globalContext: $("#globalProgressContext"), current: $("#currentSong"), percent: $("#progressPercent"), bar: $("#progressBar"), songPercent: $("#songProgressPercent"), songBar: $("#songProgressBar"), songMeta: $("#songProgressMeta"), note: $("#taskNote"), results: $("#resultsBody"),
  logs: $("#logsBody"), logPath: $("#logPath"),
  connection: $("#connectionBadge"), login: $("#loginButton"), uidHelpDialog: $("#uidHelpDialog"), qrDialog: $("#qrDialog"), qrImage: $("#qrImage"), qrStatus: $("#qrStatus"), toast: $("#toast"),
  settlementDialog: $("#settlementDialog"), settlementTitle: $("#settlementTitle"), settlementStatus: $("#settlementStatus"), settlementContext: $("#settlementContext"), settlementElapsed: $("#settlementElapsed"), settlementMatches: $("#settlementMatches"), settlementPages: $("#settlementPages"), settlementRequests: $("#settlementRequests"), settlementNote: $("#settlementNote"), settlementLogPath: $("#settlementLogPath"),
  updateButton: $("#updateButton"), updateButtonLabel: $("#updateButtonLabel"), updateIndicator: $("#updateIndicator"), updateDialog: $("#updateDialog"),
  updateReleaseName: $("#updateReleaseName"), updatePublishedAt: $("#updatePublishedAt"), currentVersion: $("#currentVersionLabel"), latestVersion: $("#latestVersionLabel"), updateNotes: $("#updateNotes"), updateAsset: $("#updateAsset"), updateDownload: $("#downloadUpdateButton"),
  updateProgress: $("#updateProgress"), updateProgressLabel: $("#updateProgressLabel"), updateProgressPercent: $("#updateProgressPercent"), updateProgressBar: $("#updateProgressBar"),
  estimateComments: $("#estimateComments"), estimateButton: $("#estimateButton"), estimatePages: $("#estimatePages"), estimateOptimistic: $("#estimateOptimistic"), estimateExpected: $("#estimateExpected"), estimateConservative: $("#estimateConservative"), estimateContext: $("#estimateContext"),
  windowMinimize: $("#windowMinimizeButton"), windowMaximize: $("#windowMaximizeButton"), windowClose: $("#windowCloseButton"),
  runtimeTimer: $("#runtimeTimer"), runtimeTimerLabel: $("#runtimeTimerLabel"), runtimeTimerValue: $("#runtimeTimerValue"),
  toolbarUid: $("#toolbarUidLabel"), toolbarMode: $("#toolbarModeLabel"), toolbarTopology: $("#toolbarTopologyLabel"), toolbarStart: $("#toolbarStartButton"),
  primaryNavigation: $("#primaryNavigation"), taskSidebar: $("#taskSidebar"), navCollapse: $("#navCollapseButton"), taskPanelToggle: $("#taskPanelToggleButton"), inspectorToggle: $("#inspectorToggleButton"),
  appSplash: $("#appSplash"),
};
const statusLabels = { idle: "空闲", running: "运行中", stopping: "停止中", complete: "已完成", matched: "已命中", paused: "已暂停", cooldown: "冷却中", "dry-run": "歌曲已读取", stopped: "已停止", error: "错误" };
let mode = "parallel";
let poolSource = "clash-verge";
let poolSourceInitialized = false;
let poolRunning = false;
let poolStatus = "not-running";
let poolChangeInFlight = false;
let poolLaneCount = 1;
let poolNetworkMs = 400;
let knownMatches = -1;
let toastTimer;
let estimateTimer;
let estimateRequest = 0;
let refreshInFlight;
let authRefreshInFlight;
let clashConfigSignature = "";
let poolEntriesSignature = "";
let renderedJobSignature = "";
let logsSignature = "";
let logsRefreshInFlight;
let lastLogsRefreshAt = 0;
let resultStream;
let resultMode = mode;
let resultRenderTimer;
let pendingLiveCommentId;
let resultsRenderPending = false;
let resultsNeedRefresh = false;
let nativeUpdateState;
let activeTaskMode;
let startSubmissionBusy = false;
let runtimeClock;
let runtimeClockText = "";
let refreshTimer;
let authRefreshTimer;
const settlementPending = { parallel: undefined, source: undefined };
const visibleResults = new Map();
const disclosureAnimations = new WeakMap();

async function api(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function payload(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, ["uid", "songId"].includes(key) ? String(value).trim() : Number.isNaN(Number(value)) || value === "" ? value : Number(value)]));
}

async function startParallel() {
  if (!el.parallelForm.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting") {
    toast("代理池正在自动优选，请等待出口验证完成后再启动");
    return;
  }
  setBusy(true);
  try {
    const value = payload(el.parallelForm);
    value.fresh = $("#parallelFresh").checked;
    const job = await api("/api/parallel/job", { method: "POST", body: JSON.stringify(value) });
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "parallel" : undefined;
    settlementPending.parallel = job.id;
    renderParallel(job);
    syncRuntimeTimer(job);
    toast("并行扫描已启动");
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}

async function startSource(dryRun) {
  if (!el.sourceForm.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting") {
    toast("代理池正在自动优选，请等待出口验证完成后再启动");
    return;
  }
  setBusy(true);
  try {
    const value = payload(el.sourceForm);
    value.maxCommentPagesPerSong = value.maxPages; delete value.maxPages;
    value.fresh = $("#fresh").checked; value.dryRun = dryRun;
    value.allowDirect = el.sourceForm.elements.allowDirect.checked;
    const job = await api("/api/job", { method: "POST", body: JSON.stringify(value) });
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "source" : undefined;
    settlementPending.source = job.id;
    renderSource(job);
    syncRuntimeTimer(job);
    toast(dryRun ? "正在读取候选歌曲" : "来源扫描已启动");
  } catch (error) {
    toast(error.message);
    if (error.status === 401) void startAuth();
  } finally { setBusy(false); }
}

async function lookupSong() {
  if (!el.songId.reportValidity()) return;
  el.songLookup.disabled = true;
  try { const song = await api(`/api/song?id=${encodeURIComponent(el.songId.value.trim())}`); el.songPreview.textContent = `${song.name || "未命名歌曲"} · ${(song.artists || []).join(" / ")}`; el.songPreview.hidden = false; }
  catch (error) { el.songPreview.hidden = true; toast(error.message); } finally { el.songLookup.disabled = false; }
}

async function lookupUser() {
  if (!el.uid.reportValidity()) return;
  el.lookup.disabled = true;
  try {
    const result = await api(`/api/user?uid=${encodeURIComponent(el.uid.value.trim())}`);
    el.userNickname.textContent = result.profile.nickname;
    el.userMeta.textContent = [`UID ${result.profile.userId}`, result.profile.level === undefined ? null : `Lv.${result.profile.level}`, `${fmt(result.elapsedMs)}ms`].filter(Boolean).join(" · ");
    probe(el.recordProbe, "听歌排行", result.record); probe(el.likesProbe, "喜欢歌曲", result.likes); el.userPreview.hidden = false;
  } catch (error) { el.userPreview.hidden = true; toast(error.message); } finally { el.lookup.disabled = false; }
}

function probe(target, label, value) { target.className = value.status; target.textContent = value.status === "available" ? `${label} ${fmt(value.songs)}` : `${label} ${value.status === "cooldown" ? "冷却" : "受限"}`; }

async function togglePool() {
  if (!poolRunning && poolSource === "clash-verge") {
    if (!el.poolSize.reportValidity() || !el.poolCandidates.reportValidity()) return;
    if (selectedClashConfigPaths().length === 0) {
      toast("请至少勾选一套 Clash Verge 代理配置");
      return;
    }
    if (Number(el.poolCandidates.value) < Number(el.poolSize.value)) {
      toast("候选节点数不能少于独立出口数");
      return;
    }
  }
  el.poolToggle.disabled = true;
  poolChangeInFlight = true;
  syncTaskStartAvailability();
  const stopping = poolRunning;
  if (!stopping) {
    poolStatus = "starting";
    renderPoolEntries([], "starting");
  }
  try {
    const path = stopping ? "/api/pool/stop" : poolSource === "external" ? "/api/pool/import" : "/api/pool/start";
    const value = stopping
      ? {}
      : poolSource === "external"
      ? { proxies: el.externalProxies.value, size: 0 }
      : { size: Number(el.poolSize.value), candidates: Number(el.poolCandidates.value), sourceConfigPaths: selectedClashConfigPaths() };
    renderPool(await api(path, { method: "POST", body: JSON.stringify(value) }));
    toast(stopping ? "代理池已停止" : "已选出可用的最优出口");
  } catch (error) {
    poolStatus = poolRunning ? "running" : "not-running";
    toast(error.message);
    void refresh();
  } finally {
    poolChangeInFlight = false;
    el.poolToggle.disabled = false;
    syncTaskStartAvailability();
  }
}

function refresh() {
  if (refreshInFlight) return refreshInFlight;
  const pending = performRefresh().finally(() => {
    if (refreshInFlight === pending) refreshInFlight = undefined;
  });
  refreshInFlight = pending;
  return pending;
}

async function performRefresh() {
  try {
    const [parallelJob, sourceJob, pool] = await Promise.all([api("/api/parallel/job"), api("/api/job"), api("/api/pool")]);
    activeTaskMode = ["running", "stopping"].includes(parallelJob.status)
      ? "parallel"
      : ["running", "stopping"].includes(sourceJob.status)
      ? "source"
      : undefined;
    if (nativeUpdateState?.phase === "downloaded") {
      setNativeUpdateAction(activeTaskMode ? "保存进度并重启" : "重启并安装");
    }
    observeTaskSettlement(parallelJob, "parallel");
    observeTaskSettlement(sourceJob, "source");
    const job = mode === "parallel" ? parallelJob : sourceJob;
    mode === "parallel" ? renderParallel(job) : renderSource(job);
    const activeJob = activeTaskMode === "parallel"
      ? parallelJob
      : activeTaskMode === "source"
      ? sourceJob
      : undefined;
    syncRuntimeTimer(activeJob ?? job);
    const globallyActive = Boolean(activeTaskMode);
    el.stop.disabled = !globallyActive;
    renderPool(pool);
    syncTaskStartAvailability();
    el.connection.classList.add("ready");
    if (job.matches !== knownMatches) {
      knownMatches = job.matches;
      if ($("#resultsPanel").hidden) resultsNeedRefresh = true;
      else await refreshResults();
    }
    if ($('.tab.active')?.dataset.tab === "logs") await refreshLogs(false);
  } catch (error) {
    el.connection.classList.remove("ready"); toast(error.message);
  }
}

function renderParallel(job) {
  if (!shouldRenderJob("parallel", job)) return;
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.songId ? `${job.songName || "歌曲"} · UID ${job.uid}` : "等待单曲任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "分片进度"; el.progress.textContent = `${fmt(job.shardsComplete)} / ${fmt(job.shards)}`;
  el.workLabel.textContent = "已读评论"; el.work.textContent = fmt(job.commentsInspected); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const globalPercent = Number.isFinite(job.coveragePercent)
    ? Math.max(0, Math.min(100, job.coveragePercent))
    : job.shards ? Math.min(100, Math.round(job.shardsComplete / job.shards * 100)) : 0;
  const songPercent = completionPercent(job.commentsInspected, job.totalComments, job.status);
  renderProgress({
    globalPercent,
    globalContext: job.songId
      ? `${fmt(job.shardsComplete)} / ${fmt(job.shards)} 个分片 · ${fmt(job.lanes)} 个出口 · ${fmt(job.workers)} 个线程${job.proxyTransportMaxConcurrent ? ` · 主机总并发 ≤ ${fmt(job.proxyTransportMaxConcurrent)}` : ""}`
      : "尚未开始",
    songTitle: job.songId ? `${job.songName || "未命名歌曲"} · ${job.songId}` : "等待歌曲调度",
    songPercent,
    songActive: active,
    songMeta: job.songId
      ? songProgressMeta(job.commentsInspected, job.totalComments, job.pagesProcessed)
      : "开始读取后显示当前歌曲完成度",
    note: job.note || job.error,
  });
  el.stop.disabled = !active;
  syncTaskStartAvailability();
  observeTaskSettlement(job, "parallel");
}

function renderSource(job) {
  if (!shouldRenderJob("source", job)) return;
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.uid ? `UID ${job.uid} · ${sourceName(job.source)}` : "等待来源任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "歌曲进度"; el.progress.textContent = `${fmt(job.songsProcessed)} / ${fmt(job.songs)}`;
  el.workLabel.textContent = "已扫页面"; el.work.textContent = fmt(job.pagesProcessed); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const globalPercent = job.songs ? Math.min(100, Math.round(job.songsProcessed / job.songs * 100)) : 0;
  const current = job.currentSong;
  const songPercent = current
    ? completionPercent(current.commentsProcessed, current.totalComments, job.status)
    : job.status === "complete"
    ? 100
    : undefined;
  const topology = `${fmt(job.lanes || 1)} 个出口 · ${fmt(job.workers || 1)} 个工作线程${job.proxyTransportMaxConcurrent ? ` · 主机总并发 ≤ ${fmt(job.proxyTransportMaxConcurrent)}` : ""}`;
  renderProgress({
    globalPercent,
    globalContext: job.uid
      ? `${fmt(job.songsProcessed)} / ${fmt(job.songs)} 首歌曲 · ${topology}`
      : "尚未开始",
    songTitle: current
      ? `${current.name || "未命名歌曲"} · ${current.id}`
      : job.status === "complete"
      ? "全部歌曲已处理完成"
      : "等待歌曲调度",
    songPercent,
    songActive: active && Boolean(current),
    songMeta: current
      ? songProgressMeta(current.commentsProcessed, current.totalComments, undefined, current.pageInSong)
      : job.status === "complete"
      ? "当前任务已完成"
      : "开始读取后显示最近活跃歌曲的完成度",
    note: [job.note, job.error, ...(job.sourceErrors || [])].filter(Boolean).join(" · "),
  });
  el.stop.disabled = !active;
  syncTaskStartAvailability();
  observeTaskSettlement(job, "source");
}

function shouldRenderJob(jobMode, job) {
  const { elapsedMs: _elapsedMs, ...view } = job;
  const signature = JSON.stringify([jobMode, view]);
  if (signature === renderedJobSignature) return false;
  renderedJobSignature = signature;
  return true;
}

function renderProgress({ globalPercent, globalContext, songTitle, songPercent, songActive, songMeta, note }) {
  setProgressBar(el.bar, globalPercent, false);
  el.percent.textContent = `${globalPercent}%`;
  el.globalContext.textContent = globalContext;
  setProgressBar(el.songBar, songPercent, songActive);
  el.songPercent.textContent = Number.isFinite(songPercent) ? `${songPercent}%` : "--";
  el.current.textContent = songTitle;
  el.songMeta.textContent = songMeta;
  el.note.hidden = !note;
  el.note.textContent = note || "";
}

function setProgressBar(bar, percent, indeterminate) {
  const known = Number.isFinite(percent);
  bar.parentElement.classList.toggle("indeterminate", !known && indeterminate);
  bar.style.width = known ? `${Math.max(0, Math.min(100, percent))}%` : "0%";
}

function completionPercent(processed, total, status) {
  const completed = Number(processed || 0);
  const available = Number(total);
  if (Number.isFinite(available) && available > 0) {
    return Math.max(0, Math.min(100, Math.round(completed / available * 100)));
  }
  return status === "complete" ? 100 : undefined;
}

function songProgressMeta(processed, total, pages, pageInSong) {
  const details = [];
  const available = Number(total);
  if (Number.isFinite(available) && available > 0) {
    details.push(`${fmt(processed)} / ${fmt(available)} 条评论`);
  } else {
    details.push(`${fmt(processed)} 条评论已读取`, "总量等待接口返回");
  }
  if (pageInSong) details.push(`第 ${fmt(pageInSong)} 页`);
  else if (pages) details.push(`${fmt(pages)} 页`);
  return details.join(" · ");
}

function syncRuntimeTimer(job) {
  if (!job?.id || job.status === "idle") {
    runtimeClock = undefined;
    runtimeClockText = "";
    el.runtimeTimer.hidden = true;
    return;
  }
  runtimeClock = {
    id: job.id,
    elapsedMs: Math.max(0, Number(job.elapsedMs || 0)),
    syncedAt: performance.now(),
    active: ["running", "stopping"].includes(job.status),
  };
  el.runtimeTimer.hidden = false;
  el.runtimeTimer.dataset.active = String(runtimeClock.active);
  el.runtimeTimerLabel.textContent = runtimeClock.active ? "已运行" : "总用时";
  renderRuntimeTimer();
}

function renderRuntimeTimer() {
  if (!runtimeClock || el.runtimeTimer.hidden) return;
  const elapsedMs = runtimeClock.elapsedMs + (runtimeClock.active ? performance.now() - runtimeClock.syncedAt : 0);
  const value = clockDuration(elapsedMs);
  if (value !== runtimeClockText) {
    runtimeClockText = value;
    el.runtimeTimerValue.textContent = value;
  }
}

function observeTaskSettlement(job, jobMode) {
  if (!job.id) return;
  if (["running", "stopping"].includes(job.status)) {
    settlementPending[jobMode] = job.id;
    return;
  }
  if (job.status === "idle" || settlementPending[jobMode] !== job.id) return;
  settlementPending[jobMode] = undefined;
  renderSettlement(job, jobMode);
}

function renderSettlement(job, jobMode) {
  const titles = { complete: "检索已完成", matched: "已找到目标评论", paused: "本轮扫描已暂停", cooldown: "扫描进入冷却", "dry-run": "候选歌曲读取完成", stopped: "任务已停止", error: "任务异常结束" };
  const defaults = {
    complete: "所选范围已处理完成。",
    matched: "已命中目标评论。",
    paused: "检查点已保存，可以使用相同参数继续。",
    cooldown: job.blockedUntil ? `远端风控/限流，建议在 ${date(job.blockedUntil)} 后继续。` : "远端返回风控/限流信号，检查点已保存。",
    "dry-run": "只读取了候选歌曲，未扫描评论。",
    stopped: "已按要求停止，当前进度可续跑。",
    error: "任务未正常完成，请查看运行日志。",
  };
  el.settlementDialog.dataset.mode = jobMode;
  el.settlementTitle.textContent = titles[job.status] || "任务已结束";
  el.settlementStatus.textContent = statusLabels[job.status] || job.status;
  el.settlementContext.textContent = jobMode === "parallel"
    ? `${job.songName || `歌曲 ${job.songId || "-"}`} · UID ${job.uid || "-"}`
    : `UID ${job.uid || "-"} · ${sourceName(job.source)}`;
  el.settlementElapsed.textContent = duration(Math.round(Number(job.elapsedMs || 0) / 1000));
  el.settlementMatches.textContent = fmt(job.matches);
  el.settlementPages.textContent = fmt(job.pagesProcessed);
  el.settlementRequests.textContent = fmt(job.requestsTotal);
  el.settlementNote.textContent = [job.note, job.error, ...(job.sourceErrors || []), defaults[job.status]].filter(Boolean).join(" · ");
  el.settlementLogPath.textContent = job.logPath || "未生成日志文件";
  if (!el.settlementDialog.open) el.settlementDialog.showModal();
}

function openTaskTab(tabName) {
  const tab = $(`.tab[data-tab="${tabName}"]`);
  if (tab && !tab.classList.contains("active")) tab.click();
  panelForTab(tabName)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function renderPool(pool) {
  if (!poolSourceInitialized && pool.source) {
    poolSourceInitialized = true;
    poolSource = pool.source;
    const sourceInput = $(`input[name="poolSource"][value="${poolSource}"]`);
    if (sourceInput) sourceInput.checked = true;
    el.clashPoolPane.hidden = poolSource !== "clash-verge";
    el.externalPoolPane.hidden = poolSource !== "external";
  }
  const previousLaneCount = poolLaneCount;
  const previousNetworkMs = poolNetworkMs;
  poolStatus = pool.status;
  poolRunning = pool.status === "running";
  poolLaneCount = poolRunning ? Math.max(1, pool.entries.length) : 1;
  const latencies = poolRunning ? pool.entries.map((entry) => Number(entry.ncmLatencyMs)).filter(Number.isFinite) : [];
  poolNetworkMs = latencies.length > 0 ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length) : 400;
  if (poolLaneCount !== previousLaneCount || poolNetworkMs !== previousNetworkMs) scheduleEstimateRefresh();
  el.poolStatus.textContent = pool.status === "running"
    ? `${pool.entries.length} 个出口在线 · ${pool.refreshing ? "正在复测" : pool.refreshError ? "复测待重试" : "延迟已更新"}`
    : { starting: "正在测速与验证", "not-running": "未运行" }[pool.status] || pool.status;
  el.poolToggle.querySelector("span").textContent = poolRunning ? "停止" : poolSource === "external" ? "验证并使用" : "自动优选";
  const discovery = pool.discovery;
  const configCount = renderClashConfigs(discovery, pool.sourceConfigPaths || (pool.sourceConfigPath ? [pool.sourceConfigPath] : []), pool.status);
  el.poolSize.disabled = pool.status !== "not-running";
  el.poolCandidates.disabled = pool.status !== "not-running";
  el.poolDiscovery.textContent = discovery?.installed
    ? configCount > 1
      ? `已找到 ${fmt(configCount)} 套可选配置与 Mihomo 内核，可勾选一套或多套合并优选。`
      : `已找到 Clash Verge 配置与 Mihomo 内核 · ${shortPath(discovery.configPath)}`
    : "未自动找到 Clash Verge，可切换到“其他代理池”手动接入。";
  renderPoolEntries(poolRunning ? pool.entries : [], pool.status);
  syncToolbarContext();
  syncTaskStartAvailability();
}

function renderPoolEntries(entries, status) {
  if (status === "starting") {
    if (poolEntriesSignature !== "starting") {
      poolEntriesSignature = "starting";
      el.poolEntries.innerHTML = '<div class="pool-selecting"><span class="pool-selecting-ring" aria-hidden="true"></span><span>正在轮换测速并优选出口</span></div>';
      el.poolTable.innerHTML = '<tr class="empty-row"><td colspan="5">正在测速与验证候选节点…</td></tr>';
    }
    return;
  }
  if (status !== "running" || entries.length === 0) {
    if (poolEntriesSignature !== "stopped") {
      poolEntriesSignature = "stopped";
      el.poolEntries.innerHTML = '<div class="pool-empty">等待代理节点</div>';
      el.poolTable.innerHTML = '<tr class="empty-row"><td colspan="5">代理池未运行</td></tr>';
    }
    return;
  }
  const signature = JSON.stringify(entries.map((entry) => [entry.name, entry.endpoint, entry.egressIp, entry.ncmLatencyMs, entry.ncmVerified]));
  if (signature !== poolEntriesSignature) {
    poolEntriesSignature = signature;
    el.poolEntries.replaceChildren(...entries.map((entry, index) => {
      const row = document.createElement("div");
      row.className = "pool-entry";
      row.innerHTML = `<span class="lane-swatch lane-${index % 4}"></span><strong>${escapeHtml(entry.egressIp)}</strong><span>${fmt(entry.ncmLatencyMs)}ms</span>`;
      return row;
    }));
    el.poolTable.replaceChildren(...entries.map((entry) => tableRow([entry.name, entry.endpoint, entry.egressIp, `${fmt(entry.ncmLatencyMs)} ms`, entry.ncmVerified ? "已验证" : "待验证"])));
  }
}

function selectedClashConfigPaths() {
  return $$('input[name="clashConfig"]:checked').map((input) => input.value);
}

function renderClashConfigs(discovery, activePoolPaths, poolStatus) {
  if (!discovery) { el.clashConfigField.hidden = true; return 0; }
  const profilePaths = new Set((discovery.profiles || []).map((profile) => profile.path));
  const choices = [];
  if (discovery.configPath && !profilePaths.has(discovery.configPath)) {
    choices.push({ path: discovery.configPath, label: "当前生效配置（合并）" });
  }
  (discovery.profiles || []).forEach((profile) => choices.push({
    path: profile.path,
    label: `${profile.name}${profile.active ? " · 当前订阅" : ""}`,
  }));
  const uniqueChoices = [...new Map(choices.map((choice) => [choice.path, choice])).values()];
  const signature = JSON.stringify(uniqueChoices);
  const previous = new Set(selectedClashConfigPaths());
  const active = new Set(activePoolPaths || []);
  if (signature !== clashConfigSignature) {
    clashConfigSignature = signature;
    el.clashConfig.replaceChildren(...uniqueChoices.map((choice) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "clashConfig";
      input.value = choice.path;
      const text = document.createElement("span");
      text.textContent = choice.label;
      label.append(input, text);
      return label;
    }));
  }
  const available = new Set(uniqueChoices.map((choice) => choice.path));
  const preferred = poolStatus === "running" && active.size > 0
    ? active
    : previous.size > 0
    ? previous
    : new Set([
      uniqueChoices.find((choice) => choice.label.includes("当前订阅"))?.path,
      discovery.configPath,
      uniqueChoices[0]?.path,
    ].filter((path) => path && available.has(path)).slice(0, 1));
  $$('input[name="clashConfig"]').forEach((input) => {
    input.checked = preferred.has(input.value);
    input.disabled = poolStatus !== "not-running";
  });
  el.clashConfigField.hidden = uniqueChoices.length <= 1;
  return uniqueChoices.length;
}

async function refreshResults() {
  try {
    const requestedMode = mode;
    const data = await api(`${requestedMode === "parallel" ? "/api/parallel/results" : "/api/results"}?limit=50`);
    if (requestedMode !== mode) return;
    if (resultMode !== mode) resetVisibleResults();
    data.results.forEach((item) => visibleResults.set(String(item.commentId), item));
    clearTimeout(resultRenderTimer);
    resultRenderTimer = undefined;
    pendingLiveCommentId = undefined;
    resultsNeedRefresh = false;
    if ($("#resultsPanel").hidden) resultsRenderPending = true;
    else {
      resultsRenderPending = false;
      renderResults();
    }
  }
  catch (error) { toast(error.message); }
}

function refreshLogs(force = true) {
  if (!force && Date.now() - lastLogsRefreshAt < 3_000) return Promise.resolve();
  if (logsRefreshInFlight) return logsRefreshInFlight;
  lastLogsRefreshAt = Date.now();
  const pending = performLogsRefresh().finally(() => {
    if (logsRefreshInFlight === pending) logsRefreshInFlight = undefined;
  });
  logsRefreshInFlight = pending;
  return pending;
}

async function performLogsRefresh() {
  const requestedMode = mode;
  try {
    const data = await api(`/api/logs?mode=${encodeURIComponent(requestedMode)}&limit=200`);
    if (requestedMode !== mode) return;
    const signature = JSON.stringify([requestedMode, data.path, data.entries]);
    if (signature === logsSignature) return;
    logsSignature = signature;
    el.logPath.textContent = data.path || "任务启动后将在本地生成结构化日志。";
    el.logs.replaceChildren(...(data.entries.length ? data.entries.map(logRow) : [emptyLogRow()]));
  } catch (error) {
    toast(`读取日志失败：${error.message}`);
  }
}

function logRow(entry) {
  const row = document.createElement("tr");
  appendTextCell(row, entry.timestamp ? date(entry.timestamp) : "-");
  const levelCell = document.createElement("td");
  const level = document.createElement("span");
  level.className = `log-level ${entry.level || "info"}`;
  level.textContent = entry.level || "info";
  levelCell.append(level);
  row.append(levelCell);
  appendTextCell(row, ({ page_start: "请求开始", page_success: "读取成功", page_failure: "读取失败", rate_limited: "风控/限流", adaptive_split: "自适应拆分", resume_descriptor_failure: "续跑参数警告", task_started: "任务启动", task_finished: "任务结束", task_error: "任务异常" })[entry.event] || entry.event || "-");
  appendTextCell(row, entry.message || "-");
  return row;
}

function emptyLogRow() {
  const row = document.createElement("tr");
  row.className = "empty-row";
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.textContent = "暂无日志";
  row.append(cell);
  return row;
}

function connectResultStream() {
  resultStream?.close();
  const streamMode = mode;
  const path = streamMode === "parallel" ? "/api/parallel/results/stream" : "/api/results/stream";
  const stream = new EventSource(path);
  stream.addEventListener("match", (event) => {
    if (mode !== streamMode || resultStream !== stream) return;
    try {
      const item = JSON.parse(event.data);
      if (resultMode !== mode) resetVisibleResults();
      const id = String(item.commentId);
      const isNew = !visibleResults.has(id);
      visibleResults.set(id, item);
      if (visibleResults.size > 120) pruneVisibleResults(100);
      if (isNew) pendingLiveCommentId = id;
      scheduleResultsRender();
      knownMatches = Math.max(knownMatches, visibleResults.size);
    } catch { /* The next status refresh remains a safe fallback. */ }
  });
  resultStream = stream;
}

function resetVisibleResults() {
  resultMode = mode;
  visibleResults.clear();
  pendingLiveCommentId = undefined;
  resultsRenderPending = false;
  resultsNeedRefresh = false;
  clearTimeout(resultRenderTimer);
  resultRenderTimer = undefined;
}

function renderResults(liveCommentId) {
  const items = [...visibleResults.values()]
    .sort((left, right) => resultTimestamp(right) - resultTimestamp(left))
    .slice(0, 50);
  if (visibleResults.size > 100) {
    visibleResults.clear();
    items.forEach((item) => visibleResults.set(String(item.commentId), item));
  }
  el.results.replaceChildren(...(items.length ? items.map((item) => resultRow(item, String(item.commentId) === liveCommentId)) : [emptyRow()]));
}

function scheduleResultsRender() {
  resultsRenderPending = true;
  if (resultRenderTimer || document.hidden || $("#resultsPanel").hidden) return;
  resultRenderTimer = setTimeout(flushResultsRender, 120);
}

function flushResultsRender() {
  clearTimeout(resultRenderTimer);
  resultRenderTimer = undefined;
  resultsRenderPending = false;
  const liveCommentId = pendingLiveCommentId;
  pendingLiveCommentId = undefined;
  renderResults(liveCommentId);
}

function pruneVisibleResults(limit) {
  const items = [...visibleResults.values()]
    .sort((left, right) => resultTimestamp(right) - resultTimestamp(left))
    .slice(0, limit);
  visibleResults.clear();
  items.forEach((item) => visibleResults.set(String(item.commentId), item));
}

function resultRow(item, live) {
  const row = document.createElement("tr");
  row.dataset.commentId = String(item.commentId);
  if (live) row.classList.add("result-live");
  appendTextCell(row, item.time ? date(item.time) : "-");
  appendTextCell(row, `${item.nickname || "-"} · ${item.userId}`);
  const songCell = document.createElement("td");
  const songName = document.createElement("span");
  songName.className = "result-song-name";
  songName.textContent = item.songName || item.resourceName || item.songId || "-";
  songCell.append(songName);
  const target = commentTarget(item);
  if (target) {
    const link = document.createElement("a");
    link.className = "comment-link";
    link.href = target;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = `在网易云音乐打开评论 ${item.commentId}`;
    link.textContent = "打开评论";
    songCell.append(link);
  }
  row.append(songCell);
  appendTextCell(row, item.content || "");
  appendTextCell(row, fmt(item.likedCount));
  return row;
}

function appendTextCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
}

function resultTimestamp(item) {
  const time = Number(item.time);
  if (Number.isFinite(time) && time > 0) return time;
  const captured = Date.parse(item.capturedAt);
  return Number.isFinite(captured) ? captured : 0;
}

function commentTarget(item) {
  const songId = String(item.songId || "");
  const commentId = String(item.commentId || "");
  if (!/^\d+$/.test(songId) || !/^\d+$/.test(commentId)) return undefined;
  return `https://music.163.com/#/song?id=${encodeURIComponent(songId)}&commentId=${encodeURIComponent(commentId)}`;
}

function estimateForm() {
  return mode === "parallel" ? el.parallelForm : el.sourceForm;
}

function estimateInputs() {
  const form = estimateForm();
  return [
    el.estimateComments,
    form.elements.minDelayMs,
    form.elements.jitterMs,
    form.elements.workersPerProxy,
    form.elements.pageSize,
  ];
}

function allEstimateInputs() {
  return [
    el.estimateComments,
    el.parallelForm.elements.minDelayMs,
    el.parallelForm.elements.jitterMs,
    el.parallelForm.elements.workersPerProxy,
    el.parallelForm.elements.pageSize,
    el.sourceForm.elements.minDelayMs,
    el.sourceForm.elements.jitterMs,
    el.sourceForm.elements.workersPerProxy,
    el.sourceForm.elements.pageSize,
    el.sourceForm.elements.proxy,
  ];
}

function scheduleEstimateRefresh(delay = 240) {
  clearTimeout(estimateTimer);
  if ($('.tab.active')?.dataset.tab !== "estimate") return;
  estimateTimer = setTimeout(() => void refreshEstimate(false), delay);
}

async function refreshEstimate(reportInvalid = true) {
  const invalid = estimateInputs().find((input) => !input.checkValidity() || input.value === "");
  if (invalid) { if (reportInvalid) invalid.reportValidity(); return; }
  const request = ++estimateRequest;
  el.estimateButton.disabled = true;
  try {
    const form = estimateForm();
    const minDelayMs = Number(form.elements.minDelayMs.value);
    const jitterMs = Number(form.elements.jitterMs.value);
    const workersPerLane = Number(form.elements.workersPerProxy.value);
    const pageSize = Number(form.elements.pageSize.value);
    const proxyTransport = mode === "parallel" || poolRunning || Boolean(form.elements.proxy?.value.trim());
    const params = new URLSearchParams({ comments: el.estimateComments.value, pageSize: String(pageSize), minDelayMs: String(minDelayMs), jitterMs: String(jitterMs), networkMs: String(poolNetworkMs), lanes: String(poolLaneCount), workersPerLane: String(workersPerLane), proxyTransport: proxyTransport ? "1" : "0" });
    const value = await api(`/api/estimate?${params}`);
    if (request !== estimateRequest) return;
    el.estimatePages.textContent = fmt(value.pages);
    el.estimateOptimistic.textContent = duration(value.optimisticSeconds);
    el.estimateExpected.textContent = duration(value.expectedSeconds);
    el.estimateConservative.textContent = duration(value.conservativeSeconds);
    const scanMode = mode === "parallel" ? "单曲并行" : "用户来源";
    const transport = value.proxyTransportMaxConcurrent
      ? ` · 主机聚合保护：总并发最多 ${fmt(value.proxyTransportMaxConcurrent)}，启动间隔至少 ${fmt(value.proxyTransportStartDelayMs)}ms`
      : "";
    el.estimateContext.textContent = `${scanMode} · ${fmt(value.lanes)} 个出口 × 每出口 ${fmt(value.workersPerLane)} 并发 · 每页 ${fmt(pageSize)} 条 · 每线程间隔 ${fmt(minDelayMs)}ms + 0..${fmt(jitterMs)}ms · 实测延迟约 ${fmt(poolNetworkMs)}ms${transport} · 预期 ${fmt(value.expectedCommentsPerSecond)} 条/秒`;
  } catch (error) { if (request === estimateRequest) toast(error.message); }
  finally { if (request === estimateRequest) el.estimateButton.disabled = false; }
}

function tableRow(values) { const row = document.createElement("tr"); values.forEach((value) => appendTextCell(row, value)); return row; }
function emptyRow() { const row = document.createElement("tr"); row.className = "empty-row"; const cell = document.createElement("td"); cell.colSpan = 5; cell.textContent = "暂无命中"; row.append(cell); return row; }

async function stopJob() {
  try {
    const targetMode = activeTaskMode || mode;
    const job = await api(targetMode === "parallel" ? "/api/parallel/job/stop" : "/api/job/stop", { method: "POST", body: "{}" });
    targetMode === "parallel" ? renderParallel(job) : renderSource(job);
    if (targetMode !== mode) toast(`已停止${targetMode === "parallel" ? "单曲并行" : "用户来源"}任务`);
    void refresh();
  } catch (error) { toast(error.message); }
}
function refreshAuth() {
  if (authRefreshInFlight) return authRefreshInFlight;
  const pending = performAuthRefresh().finally(() => {
    if (authRefreshInFlight === pending) authRefreshInFlight = undefined;
  });
  authRefreshInFlight = pending;
  return pending;
}
async function performAuthRefresh() {
  try {
    const auth = await api("/api/auth");
    const connectionText = auth.cookiePresent ? "已保存登录会话" : "本地服务";
    if (el.connection.dataset.label !== connectionText) {
      el.connection.dataset.label = connectionText;
      el.connection.innerHTML = `<span class="status-dot"></span>${connectionText}`;
      el.login.querySelector("span").textContent = auth.cookiePresent ? "更新登录" : "二维码登录";
    }
    if (el.qrDialog.open) renderAuth(auth);
  } catch { /* Connection state is reflected by the main status poll. */ }
}
async function startAuth() { el.qrDialog.showModal(); el.qrStatus.textContent = "正在生成"; el.qrImage.removeAttribute("src"); try { renderAuth(await api("/api/auth/qr", { method: "POST", body: "{}" })); } catch (error) { el.qrStatus.textContent = error.message; } }
function renderAuth(auth) { const labels = { idle: "等待开始", creating: "正在生成", waiting: "等待扫码", scanned: "等待手机确认", authorized: "登录完成", expired: "二维码已过期", error: auth.error || "登录出错" }; el.qrStatus.textContent = labels[auth.status] || auth.status; if (auth.qrImageUrl) el.qrImage.src = auth.qrImageUrl; if (auth.status === "authorized") setTimeout(() => el.qrDialog.close(), 700); }

async function checkUpdates(notifyWhenCurrent) {
  el.updateButton.disabled = true;
  el.updateButton.classList.add("checking");
  try {
    const desktop = window.ncmDesktop;
    if (desktop?.platform === "win32" && typeof desktop.checkForUpdates === "function") {
      const state = await desktop.checkForUpdates();
      if (state?.supported) {
        renderWindowsUpdate(state);
        if (state.phase === "up-to-date" && notifyWhenCurrent) toast(`当前 v${state.currentVersion} 已是最新版本`);
        if (state.phase === "error" && notifyWhenCurrent) toast(`检查更新失败：${state.error || "未知错误"}`);
        return;
      }
    }
    const update = await api("/api/update");
    nativeUpdateState = undefined;
    el.updateButtonLabel.textContent = `v${update.currentVersion}`;
    el.updateButton.classList.toggle("available", update.updateAvailable);
    el.updateIndicator.hidden = !update.updateAvailable;
    if (update.updateAvailable) {
      renderUpdate(update);
      if (!el.updateDialog.open) el.updateDialog.showModal();
    } else if (notifyWhenCurrent) {
      toast(`当前 v${update.currentVersion} 已是最新版本`);
    }
  } catch (error) {
    if (notifyWhenCurrent) toast(`检查更新失败：${error.message}`);
  } finally {
    const busy = nativeUpdateState?.phase === "checking" || nativeUpdateState?.phase === "downloading";
    el.updateButton.disabled = busy;
    el.updateButton.classList.toggle("checking", busy);
  }
}

function renderUpdate(update) {
  el.updateReleaseName.textContent = update.releaseName || `云评检索台 v${update.latestVersion}`;
  el.updatePublishedAt.textContent = update.publishedAt ? `发布于 ${dateOnly(update.publishedAt)}` : "已有新版本可下载";
  el.currentVersion.textContent = `v${update.currentVersion}`;
  el.latestVersion.textContent = `v${update.latestVersion}`;
  el.updateNotes.textContent = update.notes || "查看 GitHub Release 获取本次更新内容。";
  el.updateAsset.textContent = update.assetName
    ? `已匹配当前设备：${update.assetName}${update.assetSize ? ` · ${fileSize(update.assetSize)}` : ""}`
    : "当前设备暂无专用安装包，将打开版本发布页面。";
  renderUpdateProgress();
  el.updateDownload.href = update.downloadUrl || update.releaseUrl;
  el.updateDownload.classList.remove("is-disabled");
  el.updateDownload.removeAttribute("aria-disabled");
  el.updateDownload.querySelector("span").textContent = update.downloadUrl ? "下载更新" : "查看版本";
}

function renderWindowsUpdate(state) {
  nativeUpdateState = state;
  const hasUpdate = ["available", "downloading", "downloaded"].includes(state.phase);
  const busy = state.phase === "checking" || state.phase === "downloading";
  el.updateButtonLabel.textContent = `v${state.currentVersion}`;
  el.updateButton.classList.toggle("available", hasUpdate);
  el.updateButton.classList.toggle("checking", busy);
  el.updateButton.disabled = busy;
  el.updateIndicator.hidden = !hasUpdate;

  if (state.latestVersion) {
    el.updateReleaseName.textContent = state.releaseName || `云评检索台 v${state.latestVersion}`;
    el.updatePublishedAt.textContent = state.releaseDate ? `发布于 ${dateOnly(state.releaseDate)}` : "已有新版本可安装";
    el.currentVersion.textContent = `v${state.currentVersion}`;
    el.latestVersion.textContent = `v${state.latestVersion}`;
    el.updateNotes.textContent = state.releaseNotes || "本次更新将通过 GitHub Release 安全下载。";
  }

  if (state.phase === "available") {
    el.updateAsset.textContent = "Windows 安装包可在应用内下载，下载完成后将验证完整性。";
    renderUpdateProgress();
    setNativeUpdateAction("下载并更新");
    if (!el.updateDialog.open) el.updateDialog.showModal();
  } else if (state.phase === "downloading") {
    const detail = [
      state.transferred !== undefined && state.total ? `${fileSize(state.transferred)} / ${fileSize(state.total)}` : null,
      state.bytesPerSecond ? `${fileSize(state.bytesPerSecond)}/秒` : null,
    ].filter(Boolean).join(" · ");
    el.updateAsset.textContent = detail || "正在安全下载 Windows 安装包…";
    renderUpdateProgress(state);
    setNativeUpdateAction("正在下载…", true);
    if (!el.updateDialog.open) el.updateDialog.showModal();
  } else if (state.phase === "downloaded") {
    el.updateAsset.textContent = "安装包下载并校验完成。重启客户端后将静默安装并自动打开新版。";
    renderUpdateProgress(state);
    setNativeUpdateAction(activeTaskMode ? "保存进度并重启" : "重启并安装");
    if (!el.updateDialog.open) el.updateDialog.showModal();
  } else if (state.phase === "error") {
    el.updateAsset.textContent = `更新失败：${state.error || "未知错误"}`;
    renderUpdateProgress();
    setNativeUpdateAction("重新检查");
  } else if (state.phase === "checking") {
    el.updateAsset.textContent = "正在检查 GitHub Release…";
    renderUpdateProgress();
    setNativeUpdateAction("正在检查…", true);
  }
}

function renderUpdateProgress(state) {
  const visible = state?.phase === "downloading" || state?.phase === "downloaded";
  el.updateProgress.hidden = !visible;
  if (!visible) {
    el.updateProgressBar.style.width = "0%";
    return;
  }
  const percent = Math.max(0, Math.min(100, Number(state.percent || 0)));
  el.updateProgressLabel.textContent = state.phase === "downloaded" ? "下载完成" : "正在下载安装包";
  el.updateProgressPercent.textContent = `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
  el.updateProgressBar.style.width = `${percent}%`;
}

function setNativeUpdateAction(label, disabled = false) {
  el.updateDownload.href = "#";
  el.updateDownload.querySelector("span").textContent = label;
  el.updateDownload.classList.toggle("is-disabled", disabled);
  el.updateDownload.setAttribute("aria-disabled", String(disabled));
}

async function activateUpdate(event) {
  if (!nativeUpdateState?.supported) {
    el.updateDialog.close();
    return;
  }
  event.preventDefault();
  if (el.updateDownload.classList.contains("is-disabled")) return;
  try {
    if (nativeUpdateState.phase === "available") {
      renderWindowsUpdate(await window.ncmDesktop.downloadUpdate());
    } else if (nativeUpdateState.phase === "downloaded") {
      await prepareTaskForUpdate();
      setNativeUpdateAction("正在重启…", true);
      await window.ncmDesktop.installUpdate();
    } else {
      renderWindowsUpdate(await window.ncmDesktop.checkForUpdates());
    }
  } catch (error) {
    if (nativeUpdateState) renderWindowsUpdate(nativeUpdateState);
    toast(`更新失败：${error.message}`);
  }
}

async function prepareTaskForUpdate() {
  const taskMode = activeTaskMode;
  if (!taskMode) return;
  setNativeUpdateAction("正在保存扫描进度…", true);
  const base = taskMode === "parallel" ? "/api/parallel/job" : "/api/job";
  await api(`${base}/stop`, { method: "POST", body: "{}" });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const job = await api(base);
    if (!["running", "stopping"].includes(job.status)) {
      activeTaskMode = undefined;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待扫描检查点落盘超时，已取消安装；请稍后重试。");
}

async function setupDesktopUpdates() {
  const desktop = window.ncmDesktop;
  if (desktop?.platform !== "win32" || typeof desktop.getUpdateState !== "function") return;
  const state = await desktop.getUpdateState();
  if (!state?.supported) return;
  renderWindowsUpdate(state);
  desktop.onUpdateState((next) => renderWindowsUpdate(next));
}

async function restoreResumeTask() {
  try {
    const descriptor = (await api("/api/resume")).task;
    if (!descriptor || !["parallel", "source"].includes(descriptor.mode)) return false;
    const form = descriptor.mode === "parallel" ? el.parallelForm : el.sourceForm;
    const allowed = descriptor.mode === "parallel"
      ? new Set(["uid", "songId", "workersPerProxy", "shards", "pageSize", "requestBudget", "maxPages", "minDelayMs", "jitterMs", "forbiddenCooldownMs"])
      : new Set(["uid", "source", "recordScope", "pageSize", "requestBudget", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxCommentPagesPerSong", "maxSongs", "workersPerProxy", "allowDirect"]);
    for (const [savedName, value] of Object.entries(descriptor.input || {})) {
      if (!allowed.has(savedName)) continue;
      const name = savedName === "maxCommentPagesPerSong" ? "maxPages" : savedName;
      const control = form.elements.namedItem(name);
      if (!control) continue;
      if (control instanceof RadioNodeList) {
        for (const item of control) item.checked = item.value === String(value);
      } else if (control instanceof HTMLInputElement && control.type === "checkbox") {
        control.checked = Boolean(value);
      } else {
        control.value = String(value);
      }
    }
    mode = descriptor.mode;
    document.body.dataset.mode = mode;
    for (const input of $$('input[name="mode"]')) input.checked = input.value === mode;
    el.parallelForm.hidden = mode !== "parallel";
    el.parallelForm.setAttribute("aria-hidden", String(mode !== "parallel"));
    el.sourceForm.hidden = mode !== "source";
    el.sourceForm.setAttribute("aria-hidden", String(mode !== "source"));
    $("#parallelFresh").checked = false;
    $("#fresh").checked = false;
    const source = el.sourceForm.elements.namedItem("source")?.value;
    $("#recordScopeField").hidden = source === "likes";
    return true;
  } catch {
    return false;
  }
}

async function switchMode(value) {
  if (value === mode) return;
  const previous = mode;
  mode = value;
  document.body.dataset.mode = mode;
  syncToolbarContext();
  resetVisibleResults();
  connectResultStream();
  await slideSwap(previous === "parallel" ? el.parallelForm : el.sourceForm, mode === "parallel" ? el.parallelForm : el.sourceForm, mode === "source" ? 1 : -1);
  knownMatches = -1;
  void refresh(); void refreshResults();
  if ($('.tab.active')?.dataset.tab === "estimate") void refreshEstimate(false);
  if ($('.tab.active')?.dataset.tab === "logs") void refreshLogs();
}
async function switchPoolSource(value) {
  if (value === poolSource) return;
  const previous = poolSource;
  poolSource = value;
  await slideSwap(previous === "clash-verge" ? el.clashPoolPane : el.externalPoolPane, poolSource === "clash-verge" ? el.clashPoolPane : el.externalPoolPane, poolSource === "external" ? 1 : -1);
  if (!poolRunning) el.poolToggle.querySelector("span").textContent = poolSource === "external" ? "验证并使用" : "自动优选";
}
async function slideSwap(outgoing, incoming, direction = 1) {
  if (outgoing === incoming) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && !outgoing.hidden) {
    await playMotion(outgoing, [
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${-18 * direction}px)` },
    ], 170, "cubic-bezier(.4,0,.2,1)");
  }
  outgoing.hidden = true; outgoing.setAttribute("aria-hidden", "true");
  incoming.hidden = false; incoming.setAttribute("aria-hidden", "false");
  if (!reduced) void playMotion(incoming, [
    { opacity: 0, transform: `translateX(${18 * direction}px)` },
    { opacity: 1, transform: "translateX(0)" },
  ], 240, "cubic-bezier(.2,.8,.2,1)");
}
async function playMotion(element, frames, duration, easing) {
  if (typeof element.animate === "function") {
    const animation = element.animate(frames, { duration, easing });
    await animation.finished.catch(() => {});
    return;
  }
  Object.assign(element.style, frames[0]);
  void element.offsetWidth;
  element.style.transition = `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}`;
  Object.assign(element.style, frames[1]);
  await new Promise((resolve) => setTimeout(resolve, duration));
  element.style.removeProperty("opacity");
  element.style.removeProperty("transform");
  element.style.removeProperty("transition");
}

function setupAnimatedDisclosures() {
  $$("details.animated-disclosure").forEach((details) => {
    const summary = details.querySelector(":scope > summary");
    if (!summary) return;
    details.dataset.expanded = String(details.open);
    summary.setAttribute("aria-expanded", String(details.open));
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      void animateDisclosure(details, details.dataset.expanded !== "true");
    });
  });
}

async function animateDisclosure(details, expanded) {
  const summary = details.querySelector(":scope > summary");
  const content = details.querySelector(":scope > .advanced-content");
  if (!summary || !content) return;
  const activeAnimation = disclosureAnimations.get(details);
  const startHeight = details.open ? content.getBoundingClientRect().height : 0;
  activeAnimation?.cancel();
  if (expanded && !details.open) details.open = true;
  details.dataset.expanded = String(expanded);
  summary.setAttribute("aria-expanded", String(expanded));
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || typeof content.animate !== "function") {
    details.open = expanded;
    details.classList.remove("is-animating");
    disclosureAnimations.delete(details);
    return;
  }
  const endHeight = expanded ? content.scrollHeight : 0;
  details.classList.add("is-animating");
  const animation = content.animate([
    { height: `${startHeight}px`, opacity: expanded ? 0.35 : 1, transform: expanded ? "translateY(-6px)" : "translateY(0)" },
    { height: `${endHeight}px`, opacity: expanded ? 1 : 0.25, transform: expanded ? "translateY(0)" : "translateY(-6px)" },
  ], { duration: expanded ? 280 : 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
  disclosureAnimations.set(details, animation);
  await animation.finished.catch(() => {});
  if (disclosureAnimations.get(details) !== animation) return;
  if (!expanded) details.open = false;
  animation.cancel();
  disclosureAnimations.delete(details);
  details.classList.remove("is-animating");
}

function renderMaximized(maximized) {
  el.windowMaximize.classList.toggle("is-maximized", maximized);
  el.windowMaximize.title = maximized ? "还原" : "最大化";
  el.windowMaximize.setAttribute("aria-label", maximized ? "还原" : "最大化");
}

async function setupDesktopWindowControls() {
  const desktop = window.ncmDesktop;
  if (!desktop || desktop.platform !== "win32") return;
  el.windowMinimize.addEventListener("click", () => desktop.minimize());
  el.windowClose.addEventListener("click", () => desktop.close());
  el.windowMaximize.addEventListener("click", async () => renderMaximized(await desktop.toggleMaximize()));
  desktop.onMaximizedChange(renderMaximized);
  renderMaximized(await desktop.isMaximized());
}

function syncTaskStartAvailability() {
  const disabled = startSubmissionBusy || Boolean(activeTaskMode) || poolChangeInFlight || poolStatus === "starting";
  el.parallelStart.disabled = disabled;
  el.sourceStart.disabled = disabled;
  el.dryRun.disabled = disabled;
  el.toolbarStart.disabled = disabled;
}
function syncToolbarContext() {
  const form = mode === "parallel" ? el.parallelForm : el.sourceForm;
  const uid = mode === "parallel" ? el.parallelUid.value.trim() : el.uid.value.trim();
  const workers = Number(form.elements.workersPerProxy?.value || 1);
  el.toolbarUid.textContent = uid ? `UID ${uid}` : "UID 待填写";
  el.toolbarMode.textContent = mode === "parallel" ? "单曲并行" : `用户来源 · ${sourceName(form.elements.source?.value)}`;
  el.toolbarTopology.textContent = `${fmt(poolRunning ? poolLaneCount : 1)} 出口 · ${fmt(workers)} 线程/IP`;
}
function setActiveNavigation(view) {
  $$('[data-nav-view]').forEach((item) => {
    const active = item.dataset.navView === view;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}
async function activateNavigation(view) {
  setActiveNavigation(view);
  if (view === "search") {
    setTaskPanelCollapsed(false);
    el.taskSidebar?.scrollIntoView({ behavior: "auto", block: "start" });
    return;
  }
  if (view === "settings") {
    setTaskPanelCollapsed(false);
    const details = (mode === "parallel" ? el.parallelForm : el.sourceForm).querySelector("details.advanced");
    if (details && details.dataset.expanded !== "true") await animateDisclosure(details, true);
    details?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    return;
  }
  setTaskPanelCollapsed(true);
  if (view === "pool") setInspectorCollapsed(false);
  openTaskTab(view);
}
function setNavigationCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  el.navCollapse.setAttribute("aria-label", collapsed ? "展开导航" : "收起导航");
  el.navCollapse.title = collapsed ? "展开导航" : "收起导航";
  el.navCollapse.querySelector("img").src = collapsed ? "/icons/panel-left-open.svg" : "/icons/panel-left-close.svg";
}
function setTaskPanelCollapsed(collapsed) {
  document.body.classList.toggle("task-panel-collapsed", collapsed);
  el.taskPanelToggle.setAttribute("aria-label", collapsed ? "展开任务面板" : "收起任务面板");
  el.taskPanelToggle.title = collapsed ? "展开任务面板" : "收起任务面板";
}
function setInspectorCollapsed(collapsed) {
  document.body.classList.toggle("inspector-collapsed", collapsed);
  el.inspectorToggle.setAttribute("aria-label", collapsed ? "展开运行详情" : "收起运行详情");
  el.inspectorToggle.title = collapsed ? "展开运行详情" : "收起运行详情";
}
function setBusy(value) {
  startSubmissionBusy = value;
  el.toolbarStart.querySelector("span").textContent = value ? "启动中…" : "启动";
  el.parallelStart.querySelector("span").textContent = value ? "正在启动…" : "开始并行扫描";
  el.sourceStart.querySelector("span").textContent = value ? "正在启动…" : "开始扫描";
  el.toolbarStart.setAttribute("aria-busy", String(value));
  syncTaskStartAvailability();
}
function sourceName(value) { return { record: "听歌排行", likes: "喜欢歌曲", both: "两者" }[value] || value || "-"; }
function fmt(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function date(value) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function dateOnly(value) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function duration(seconds) { const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return [days ? `${days}天` : "", hours ? `${hours}小时` : "", minutes ? `${minutes}分` : "", rest && !days ? `${rest}秒` : ""].filter(Boolean).join(" ") || "0秒"; }
function clockDuration(milliseconds) { const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":"); }
function fileSize(bytes) { return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`; }
function shortPath(value) { if (!value) return ""; const parts = value.split(/[\\/]/); return parts.slice(-3).join("/"); }
function panelForTab(value) { return $({ results: "#resultsPanel", logs: "#logsPanel", pool: "#poolPanel", estimate: "#estimatePanel" }[value]); }
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
function toast(message) { clearTimeout(toastTimer); el.toast.textContent = message; el.toast.hidden = false; toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4500); }

function dismissSplash() {
  if (!el.appSplash || el.appSplash.classList.contains("is-leaving")) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const delay = reduced ? 0 : Math.max(0, 760 - performance.now());
  setTimeout(() => {
    el.appSplash.classList.add("is-leaving");
    setTimeout(() => el.appSplash?.remove(), reduced ? 20 : 460);
  }, delay);
}

async function boot() {
  await setupDesktopUpdates();
  const restored = await restoreResumeTask();
  connectResultStream();
  await Promise.allSettled([refresh(), refreshResults(), refreshAuth()]);
  dismissSplash();
  if (restored) toast("已恢复上次任务参数；保持“新建状态”关闭即可从检查点继续。");
  void checkUpdates(false);
}

el.parallelForm.addEventListener("submit", (event) => { event.preventDefault(); void startParallel(); });
el.sourceForm.addEventListener("submit", (event) => { event.preventDefault(); void startSource(false); });
el.dryRun.addEventListener("click", () => void startSource(true)); el.songLookup.addEventListener("click", () => void lookupSong()); el.lookup.addEventListener("click", () => void lookupUser());
el.poolToggle.addEventListener("click", () => void togglePool()); el.stop.addEventListener("click", () => void stopJob()); el.refresh.addEventListener("click", () => void refresh());
el.toolbarStart.addEventListener("click", () => (mode === "parallel" ? el.parallelForm : el.sourceForm).requestSubmit());
el.navCollapse.addEventListener("click", () => setNavigationCollapsed(!document.body.classList.contains("nav-collapsed")));
el.taskPanelToggle.addEventListener("click", () => setTaskPanelCollapsed(!document.body.classList.contains("task-panel-collapsed")));
el.inspectorToggle.addEventListener("click", () => setInspectorCollapsed(!document.body.classList.contains("inspector-collapsed")));
$$('[data-nav-view]').forEach((item) => item.addEventListener("click", () => void activateNavigation(item.dataset.navView)));
$$('#parallelForm input, #sourceForm input').forEach((input) => input.addEventListener("input", syncToolbarContext));
el.estimateButton.addEventListener("click", () => void refreshEstimate());
allEstimateInputs().forEach((input) => input.addEventListener("input", () => scheduleEstimateRefresh()));
$$('[data-comments]').forEach((button) => button.addEventListener("click", () => { el.estimateComments.value = button.dataset.comments; void refreshEstimate(); }));
$$('[data-open-uid-help]').forEach((button) => button.addEventListener("click", () => el.uidHelpDialog.showModal()));
$("#closeUidHelpButton").addEventListener("click", () => el.uidHelpDialog.close());
$("#gotUidHelpButton").addEventListener("click", () => el.uidHelpDialog.close());
el.login.addEventListener("click", () => void startAuth()); $("#closeQrButton").addEventListener("click", () => el.qrDialog.close());
$("#closeSettlementButton").addEventListener("click", () => el.settlementDialog.close());
$("#viewSettlementLogsButton").addEventListener("click", () => { el.settlementDialog.close(); openTaskTab("logs"); void refreshLogs(); });
$("#viewSettlementResultsButton").addEventListener("click", () => { el.settlementDialog.close(); openTaskTab("results"); });
el.updateButton.addEventListener("click", () => void checkUpdates(true));
$("#closeUpdateButton").addEventListener("click", () => el.updateDialog.close());
$("#laterUpdateButton").addEventListener("click", () => el.updateDialog.close());
el.updateDownload.addEventListener("click", (event) => void activateUpdate(event));
$$('input[name="mode"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) void switchMode(input.value); }));
$$('input[name="poolSource"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) void switchPoolSource(input.value); }));
$$('input[name="source"]').forEach((input) => input.addEventListener("change", () => { $("#recordScopeField").hidden = input.checked && input.value === "likes"; }));
$$('.tab').forEach((tab) => tab.addEventListener("click", () => void activateTaskTab(tab)));
setupAnimatedDisclosures(); void setupDesktopWindowControls();
if (innerWidth <= 1120 && innerWidth > 820) setInspectorCollapsed(true);
syncToolbarContext();
void boot().finally(() => {
  scheduleRefreshLoop();
  scheduleAuthRefreshLoop();
});
const runtimeTimerInterval = setInterval(renderRuntimeTimer, 1_000);

function scheduleRefreshLoop(delay = document.hidden ? 10_000 : 1_500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!document.hidden) await refresh();
    scheduleRefreshLoop();
  }, delay);
}

function scheduleAuthRefreshLoop(delay = el.qrDialog.open ? 1_500 : document.hidden ? 15_000 : 10_000) {
  clearTimeout(authRefreshTimer);
  authRefreshTimer = setTimeout(async () => {
    if (!document.hidden || el.qrDialog.open) await refreshAuth();
    scheduleAuthRefreshLoop();
  }, delay);
}

addEventListener("visibilitychange", () => {
  scheduleRefreshLoop();
  scheduleAuthRefreshLoop();
  if (!document.hidden) {
    void refresh();
    void refreshAuth();
    if (resultsRenderPending) scheduleResultsRender();
  }
});
addEventListener("pagehide", () => {
  resultStream?.close();
  clearTimeout(resultRenderTimer);
  clearTimeout(refreshTimer);
  clearTimeout(authRefreshTimer);
  clearInterval(runtimeTimerInterval);
});

async function activateTaskTab(tab) {
  const current = $('.tab.active');
  if (current === tab) {
    if (tab.dataset.tab === "logs") await refreshLogs();
    if (tab.dataset.tab === "results") {
      if (resultsNeedRefresh) await refreshResults();
      else if (resultsRenderPending) flushResultsRender();
    }
    return;
  }
  const tabs = $$('.tab');
  const direction = tabs.indexOf(tab) > tabs.indexOf(current) ? 1 : -1;
  tabs.forEach((item) => {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  setActiveNavigation(tab.dataset.tab);
  await slideSwap(panelForTab(current.dataset.tab), panelForTab(tab.dataset.tab), direction);
  if (tab.dataset.tab === "estimate") await refreshEstimate();
  if (tab.dataset.tab === "logs") await refreshLogs();
  if (tab.dataset.tab === "results") {
    if (resultsNeedRefresh) await refreshResults();
    else if (resultsRenderPending) flushResultsRender();
  }
}
