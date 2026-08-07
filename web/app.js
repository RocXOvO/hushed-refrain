document.documentElement.dataset.desktopPlatform = new URLSearchParams(location.search).get("desktop") || "web";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const el = {
  parallelForm: $("#parallelForm"), sourceForm: $("#sourceForm"), parallelUid: $("#parallelUid"), uid: $("#uid"),
  songId: $("#songId"), songPreview: $("#songPreview"), songLookup: $("#songLookupButton"), lookup: $("#lookupButton"),
  userPreview: $("#userPreview"), userNickname: $("#userNickname"), userMeta: $("#userMeta"), recordProbe: $("#recordProbe"), likesProbe: $("#likesProbe"),
  poolStatus: $("#poolStatus"), poolState: $("#poolStateIndicator"), poolEntries: $("#poolEntries"), poolTable: $("#poolTableBody"), poolToggle: $("#poolToggleButton"),
  poolDiscovery: $("#poolDiscovery"), clashPoolPane: $("#clashPoolPane"), clashConfigField: $("#clashConfigField"), clashConfig: $("#clashConfigSelect"), clashConfigSelectAll: $("#clashConfigSelectAllButton"), poolSize: $("#poolSize"), poolCandidates: $("#poolCandidates"), externalPoolPane: $("#externalPoolPane"), externalProxies: $("#externalProxies"),
  parallelStart: $("#parallelStartButton"), sourceStart: $("#sourceStartButton"), dryRun: $("#dryRunButton"), stop: $("#stopButton"), refresh: $("#refreshButton"),
  taskTitle: $("#taskTitle"), status: $("#statusMetric"), progressLabel: $("#progressLabel"), progress: $("#progressMetric"), workLabel: $("#workLabel"), work: $("#workMetric"),
  matches: $("#matchesMetric"), requests: $("#requestsMetric"), speed: $("#speedMetric"), globalContext: $("#globalProgressContext"), percent: $("#progressPercent"), bar: $("#progressBar"), note: $("#taskNote"), results: $("#resultsBody"),
  logs: $("#logsBody"), logPath: $("#logPath"),
  connection: $("#connectionBadge"), login: $("#loginButton"), uidHelpDialog: $("#uidHelpDialog"), qrDialog: $("#qrDialog"), qrImage: $("#qrImage"), qrStatus: $("#qrStatus"), toast: $("#toast"),
  settlementDialog: $("#settlementDialog"), settlementTitle: $("#settlementTitle"), settlementStatus: $("#settlementStatus"), settlementContext: $("#settlementContext"), settlementElapsed: $("#settlementElapsed"), settlementMatches: $("#settlementMatches"), settlementPages: $("#settlementPages"), settlementRequests: $("#settlementRequests"), settlementNote: $("#settlementNote"), settlementLogPath: $("#settlementLogPath"),
  updateButton: $("#updateButton"), updateButtonLabel: $("#updateButtonLabel"), updateIndicator: $("#updateIndicator"), updateDialog: $("#updateDialog"),
  updateReleaseName: $("#updateReleaseName"), updatePublishedAt: $("#updatePublishedAt"), currentVersion: $("#currentVersionLabel"), latestVersion: $("#latestVersionLabel"), updateNotes: $("#updateNotes"), updateAsset: $("#updateAsset"), updateDownload: $("#downloadUpdateButton"),
  updateProgress: $("#updateProgress"), updateProgressLabel: $("#updateProgressLabel"), updateProgressPercent: $("#updateProgressPercent"), updateProgressBar: $("#updateProgressBar"),
  estimateComments: $("#estimateComments"), estimateButton: $("#estimateButton"), estimatePages: $("#estimatePages"), estimateOptimistic: $("#estimateOptimistic"), estimateExpected: $("#estimateExpected"), estimateConservative: $("#estimateConservative"), estimateContext: $("#estimateContext"),
  windowMinimize: $("#windowMinimizeButton"), windowMaximize: $("#windowMaximizeButton"), windowClose: $("#windowCloseButton"),
  runtimeTimer: $("#runtimeTimer"), runtimeTimerLabel: $("#runtimeTimerLabel"), runtimeTimerValue: $("#runtimeTimerValue"),
  toolbarUid: $("#toolbarUidLabel"), toolbarMode: $("#toolbarModeLabel"), toolbarTopology: $("#toolbarTopologyLabel"), toolbarStart: $("#toolbarStartButton"), hostConcurrency: $("#taskHostConcurrency"), exitLimit: $("#taskExitLimit"),
  primaryNavigation: $("#primaryNavigation"), taskSidebar: $("#taskSidebar"), taskPanelOpen: $("#taskPanelOpenButton"), taskPanelToggle: $("#taskPanelToggleButton"), inspectorToggle: $("#inspectorToggleButton"),
  activeSongCount: $("#activeSongCount"), activeWorkerCount: $("#activeWorkerCount"), activeSongSummary: $("#activeSongSummary"), activeSongsList: $("#activeSongsList"),
  appSplash: $("#appSplash"),
};
const statusLabels = { idle: "空闲", running: "运行中", stopping: "停止中", complete: "已完成", matched: "已命中", paused: "已暂停", cooldown: "冷却中", "dry-run": "歌曲已读取", stopped: "已停止", error: "错误" };
let mode = "parallel";
let poolSource = "clash-verge";
let poolSourceInitialized = false;
let poolRunning = false;
let poolStatus = "not-running";
let poolRefreshing = false;
let poolBuildError = "";
let poolChangeInFlight = false;
let poolMutationVersion = 0;
let poolSourceSwitchVersion = 0;
let poolLaneCount = 1;
let poolNetworkMs = 400;
let knownMatches = -1;
let toastTimer;
let estimateTimer;
let estimateRequest = 0;
let refreshInFlight;
let authRefreshInFlight;
let clashConfigSignature = "";
let clashConfigSelection;
let poolEntriesSignature = "";
let renderedJobSignature = "";
let logsSignature = "";
let logsRefreshInFlight;
let logsRefreshMode;
let logsRequest = 0;
let lastLogsRefreshAt = 0;
let resultStream;
let resultMode = mode;
let resultRequest = 0;
const resultJobIds = { parallel: undefined, source: undefined };
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
let modeSwitchVersion = 0;
let tabSwitchVersion = 0;
const settlementPending = { parallel: undefined, source: undefined };
const visibleResults = new Map();
let visibleResultOrder = [];
const disclosureAnimations = new WeakMap();
let activeSongsSignature = "";

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
  if (!el.parallelForm.reportValidity() || !el.hostConcurrency.reportValidity() || !el.exitLimit.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting" || poolRefreshing) {
    toast("代理池正在验证节点，请等待状态灯变绿并显示“已就绪”后再启动");
    return;
  }
  setBusy(true);
  const requestedMode = mode;
  const requestedModeVersion = modeSwitchVersion;
  try {
    const value = payload(el.parallelForm);
    value.fresh = $("#parallelFresh").checked;
    value.maxProxyLanes = Number(el.exitLimit.value);
    value.hostConcurrency = Number(el.hostConcurrency.value);
    const job = await api("/api/parallel/job", { method: "POST", body: JSON.stringify(value) });
    syncResultJob("parallel", job.id);
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "parallel" : undefined;
    settlementPending.parallel = job.id;
    if (requestedMode === mode && requestedModeVersion === modeSwitchVersion) {
      renderParallel(job);
      syncRuntimeTimer(job);
    } else void refresh();
    setTaskPanelCollapsed(true);
    toast("并行扫描已启动");
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}

async function startSource(dryRun) {
  if (!el.sourceForm.reportValidity() || !el.hostConcurrency.reportValidity() || !el.exitLimit.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting" || poolRefreshing) {
    toast("代理池正在验证节点，请等待状态灯变绿并显示“已就绪”后再启动");
    return;
  }
  setBusy(true);
  const requestedMode = mode;
  const requestedModeVersion = modeSwitchVersion;
  try {
    const value = payload(el.sourceForm);
    value.maxCommentPagesPerSong = value.maxPages; delete value.maxPages;
    value.fresh = $("#fresh").checked; value.dryRun = dryRun;
    value.allowDirect = el.sourceForm.elements.allowDirect.checked;
    value.maxProxyLanes = Number(el.exitLimit.value);
    value.hostConcurrency = Number(el.hostConcurrency.value);
    const job = await api("/api/job", { method: "POST", body: JSON.stringify(value) });
    syncResultJob("source", job.id);
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "source" : undefined;
    settlementPending.source = job.id;
    if (requestedMode === mode && requestedModeVersion === modeSwitchVersion) {
      renderSource(job);
      syncRuntimeTimer(job);
    } else void refresh();
    setTaskPanelCollapsed(true);
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
  poolMutationVersion += 1;
  syncTaskStartAvailability();
  const stopping = poolRunning;
  if (!stopping) {
    poolBuildError = "";
    poolRefreshing = false;
    poolStatus = "starting";
    renderPoolState({ status: "starting", entries: [] });
    renderPoolEntries([], "starting");
  }
  try {
    const path = stopping ? "/api/pool/stop" : poolSource === "external" ? "/api/pool/import" : "/api/pool/start";
    const value = stopping
      ? {}
      : poolSource === "external"
      ? { proxies: el.externalProxies.value, size: 0 }
      : { size: Number(el.poolSize.value), candidates: Number(el.poolCandidates.value), sourceConfigPaths: selectedClashConfigPaths() };
    const nextPool = await api(path, { method: "POST", body: JSON.stringify(value) });
    poolBuildError = "";
    renderPool(nextPool);
    toast(stopping ? "代理池已停止" : "已选出可用的最优出口");
  } catch (error) {
    poolBuildError = stopping ? "" : error.message;
    if (!stopping) {
      poolRefreshing = false;
      poolStatus = "not-running";
      renderPoolState({ status: poolStatus, entries: [], refreshError: poolBuildError });
    }
    toast(error.message);
    void refresh();
  } finally {
    poolChangeInFlight = false;
    el.poolToggle.disabled = poolRefreshing;
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
  const poolVersion = poolMutationVersion;
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
    if (!poolChangeInFlight && poolVersion === poolMutationVersion) renderPool(pool);
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
  syncResultJob("parallel", job.id);
  if (!shouldRenderJob("parallel", job)) return;
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.songId ? `${job.songName || "歌曲"} · UID ${job.uid}` : "等待单曲任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "分片进度"; el.progress.textContent = `${fmt(job.shardsComplete)} / ${fmt(job.shards)}`;
  el.workLabel.textContent = "已读评论"; el.work.textContent = fmt(job.commentsInspected); el.speed.textContent = formatRate(job.commentsPerSecond); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const globalPercent = Number.isFinite(job.coveragePercent)
    ? Math.max(0, Math.min(100, job.coveragePercent))
    : job.shards ? Math.min(100, Math.round(job.shardsComplete / job.shards * 100)) : 0;
  renderProgress({
    globalPercent,
    globalContext: job.songId
      ? `${fmt(job.shardsComplete)} / ${fmt(job.shards)} 个分片 · ${fmt(job.lanes)} 个出口 · ${fmt(job.workers)} 个线程${transportConcurrencyText(job)}`
      : "尚未开始",
    note: [job.note || job.error, topologyCapacityNote(job)].filter(Boolean).join(" · "),
  });
  renderActiveSongs(
    active ? job.activeSongs || [] : [],
    job.songId ? `${fmt(job.lanes || 1)} 出口 · ${fmt(job.workers || 1)} Worker${transportConcurrencyText(job)}` : "等待任务调度",
    job.workers,
  );
  el.stop.disabled = !active;
  syncTaskStartAvailability();
}

function renderSource(job) {
  syncResultJob("source", job.id);
  if (!shouldRenderJob("source", job)) return;
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.uid ? `UID ${job.uid} · ${sourceName(job.source)}` : "等待来源任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "歌曲进度"; el.progress.textContent = `${fmt(job.songsProcessed)} / ${fmt(job.songs)}`;
  el.workLabel.textContent = "已扫页面"; el.work.textContent = fmt(job.pagesProcessed); el.speed.textContent = formatRate(job.commentsPerSecond); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const globalPercent = job.songs ? Math.min(100, Math.round(job.songsProcessed / job.songs * 100)) : 0;
  const topology = `${fmt(job.lanes || 1)} 个出口 · ${fmt(job.workers || 1)} 个工作线程${transportConcurrencyText(job)}`;
  renderProgress({
    globalPercent,
    globalContext: job.uid
      ? `${fmt(job.songsProcessed)} / ${fmt(job.songs)} 首歌曲 · ${topology}`
      : "尚未开始",
    note: [job.note, job.error, ...(job.sourceErrors || []), topologyCapacityNote(job)].filter(Boolean).join(" · "),
  });
  renderActiveSongs(
    active ? job.activeSongs || [] : [],
    job.uid ? `${topology.replaceAll(" 个", " ")}` : "等待任务调度",
    job.workers,
  );
  el.stop.disabled = !active;
  syncTaskStartAvailability();
}

function shouldRenderJob(jobMode, job) {
  const { elapsedMs: _elapsedMs, ...view } = job;
  const signature = JSON.stringify([jobMode, view]);
  if (signature === renderedJobSignature) return false;
  renderedJobSignature = signature;
  return true;
}

function renderProgress({ globalPercent, globalContext, note }) {
  setProgressBar(el.bar, globalPercent, false);
  el.percent.textContent = `${globalPercent}%`;
  el.globalContext.textContent = globalContext;
  el.note.hidden = !note;
  el.note.textContent = note || "";
}

function renderActiveSongs(songs, summary, configuredWorkers = 0) {
  const normalized = songs.map((song) => ({
    id: String(song.id || ""),
    name: String(song.name || ""),
    workers: Math.max(1, Number(song.workers || 1)),
    pagesProcessed: finiteNumber(song.pagesProcessed),
    requestingPage: finiteNumber(song.requestingPage),
    commentsProcessed: finiteNumber(song.commentsProcessed),
    totalComments: finiteNumber(song.totalComments),
    progressPercent: finiteNumber(song.progressPercent),
    progressBasis: song.progressBasis === "time" ? "time" : "comments",
  }));
  const activeWorkers = normalized.reduce((total, song) => total + song.workers, 0);
  const workerCapacity = Math.max(0, Number(configuredWorkers || 0));
  const signature = JSON.stringify([normalized, summary, workerCapacity]);
  if (signature === activeSongsSignature) return;
  activeSongsSignature = signature;
  el.activeSongCount.textContent = `${fmt(normalized.length)} 首`;
  el.activeWorkerCount.textContent = `${fmt(activeWorkers)} / ${fmt(workerCapacity)} Worker 活跃`;
  el.activeSongSummary.textContent = summary;
  if (normalized.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "暂无正在扫描的歌曲";
    row.append(cell);
    el.activeSongsList.replaceChildren(row);
    return;
  }
  el.activeSongsList.replaceChildren(...normalized.map((song) => {
    const row = document.createElement("tr");
    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "activity-status";
    badge.textContent = "扫描中";
    status.append(badge);
    const name = document.createElement("td");
    name.textContent = song.name || "正在读取歌曲名称";
    const id = document.createElement("td");
    id.textContent = song.id;
    const progress = renderSongReadProgress(song);
    const workers = document.createElement("td");
    workers.className = "activity-worker-count";
    workers.textContent = `${fmt(song.workers)} Worker`;
    row.append(status, name, id, progress, workers);
    return row;
  }));
}

function renderSongReadProgress(song) {
  const cell = document.createElement("td");
  cell.className = "song-read-progress";
  const comments = Math.max(0, song.commentsProcessed ?? 0);
  const total = song.totalComments !== undefined && song.totalComments > 0
    ? Math.max(comments, song.totalComments)
    : undefined;
  const measuredPercent = total ? comments / total * 100 : undefined;
  const percent = Math.max(0, Math.min(100, song.progressPercent ?? measuredPercent ?? 0));
  const label = document.createElement("span");
  label.textContent = song.progressBasis === "time" && song.progressPercent !== undefined
    ? `已读 ${fmt(comments)} 条 · 时间覆盖 ${Math.round(percent)}%`
    : total
    ? `已读 ${fmt(comments)} / ${fmt(total)} 条 · ${Math.round(percent)}%`
    : song.requestingPage !== undefined
    ? `已读 ${fmt(comments)} 条 · 正在请求第 ${fmt(song.requestingPage)} 页`
    : song.pagesProcessed !== undefined
    ? `已读 ${fmt(comments)} 条 · 已完成 ${fmt(song.pagesProcessed)} 页`
    : "等待首个评论页";
  const track = document.createElement("span");
  track.className = `song-read-track${song.progressPercent === undefined && measuredPercent === undefined ? " is-unknown" : ""}`;
  const fill = document.createElement("i");
  fill.style.width = `${percent}%`;
  track.append(fill);
  cell.setAttribute("aria-label", label.textContent);
  cell.append(label, track);
  return cell;
}

function setProgressBar(bar, percent, indeterminate) {
  const known = Number.isFinite(percent);
  bar.parentElement.classList.toggle("indeterminate", !known && indeterminate);
  bar.style.width = known ? `${Math.max(0, Math.min(100, percent))}%` : "0%";
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
  setTaskPanelCollapsed(true);
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
  poolRefreshing = Boolean(pool.refreshing);
  if (poolRunning) poolBuildError = "";
  poolLaneCount = poolRunning ? Math.max(1, pool.entries.length) : 1;
  const latencies = poolRunning ? pool.entries.map((entry) => Number(entry.ncmLatencyMs)).filter(Number.isFinite) : [];
  poolNetworkMs = latencies.length > 0 ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length) : 400;
  if (poolLaneCount !== previousLaneCount || poolNetworkMs !== previousNetworkMs) scheduleEstimateRefresh();
  renderPoolState(pool);
  el.poolToggle.disabled = poolChangeInFlight || poolRefreshing;
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

function renderPoolState(pool) {
  let state = "is-offline";
  let text = "未构建";
  if (pool.status === "starting") {
    state = "is-building";
    text = "构建中 · 正在测速与验证";
  } else if (pool.status === "running" && pool.refreshing) {
    state = "is-checking";
    text = `${pool.entries.length} 个出口 · 正在复测`;
  } else if (pool.status === "running" && pool.refreshError) {
    state = "is-degraded";
    text = `${pool.entries.length} 个出口 · 复测待重试`;
  } else if (pool.status === "running") {
    state = "is-ready";
    text = `${pool.entries.length} 个出口 · 已就绪`;
  } else if (poolBuildError) {
    state = "is-error";
    text = "构建失败 · 请重新优选";
  }
  el.poolState.className = `pool-state-indicator ${state}`;
  el.poolStatus.textContent = text;
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
  if (!discovery) {
    clashConfigSignature = "";
    el.clashConfig.replaceChildren();
    el.clashConfigField.hidden = true;
    el.clashConfigSelectAll.disabled = true;
    return 0;
  }
  const profiles = discovery.profiles || [];
  const choices = profiles.map((profile) => ({
    path: profile.path,
    label: `${profile.name}${profile.active ? " · 当前订阅" : ""}`,
  }));
  if (choices.length === 0 && discovery.configPath) {
    choices.push({ path: discovery.configPath, label: "Clash Verge 默认配置" });
  }
  const uniqueChoices = [...new Map(choices.map((choice) => [choice.path, choice])).values()];
  const signature = JSON.stringify(uniqueChoices);
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
  const activeAvailable = new Set([...active].filter((path) => available.has(path)));
  if (clashConfigSelection === undefined) {
    clashConfigSelection = poolStatus === "running" && activeAvailable.size > 0
      ? new Set(activeAvailable)
      : new Set(available);
  }
  const selectedAvailable = new Set([...clashConfigSelection].filter((path) => available.has(path)));
  const preferred = poolStatus === "running" && activeAvailable.size > 0
    ? activeAvailable
    : selectedAvailable;
  $$('input[name="clashConfig"]').forEach((input) => {
    input.checked = preferred.has(input.value);
    input.disabled = poolStatus !== "not-running";
  });
  el.clashConfigField.hidden = uniqueChoices.length === 0;
  syncClashSelectAllButton(poolStatus);
  return uniqueChoices.length;
}

function syncClashSelectAllButton(status = poolStatus) {
  const choices = $$('input[name="clashConfig"]');
  const allSelected = choices.length > 0 && choices.every((input) => input.checked);
  el.clashConfigSelectAll.textContent = allSelected ? "取消全选" : "全选";
  el.clashConfigSelectAll.disabled = choices.length === 0 || status !== "not-running";
}

function toggleClashConfigs() {
  const choices = $$('input[name="clashConfig"]:not(:disabled)');
  const shouldSelect = choices.some((input) => !input.checked);
  for (const input of choices) input.checked = shouldSelect;
  clashConfigSelection = new Set(selectedClashConfigPaths());
  syncClashSelectAllButton();
}

async function refreshResults() {
  const request = ++resultRequest;
  const requestedMode = mode;
  const baselineIds = new Set(visibleResultOrder);
  try {
    const data = await api(`${requestedMode === "parallel" ? "/api/parallel/results" : "/api/results"}?limit=50`);
    if (request !== resultRequest || requestedMode !== mode) return;
    if (resultMode !== mode) resetVisibleResults(false);
    if (data.jobId !== resultJobIds[requestedMode]) {
      resultJobIds[requestedMode] = data.jobId;
      resetVisibleResults(false);
      knownMatches = -1;
    }
    const mergedResults = new Map(visibleResults);
    const snapshotOrder = [];
    data.results.forEach((item) => {
      const id = String(item.commentId);
      if (!snapshotOrder.includes(id)) snapshotOrder.push(id);
      mergedResults.set(id, item);
    });
    const snapshotIds = new Set(snapshotOrder);
    const liveDuringRequest = visibleResultOrder.filter((id) =>
      !baselineIds.has(id) && !snapshotIds.has(id)
    );
    const liveIds = new Set(liveDuringRequest);
    const retainedOlder = visibleResultOrder.filter((id) =>
      !snapshotIds.has(id) && !liveIds.has(id)
    );
    visibleResults.clear();
    for (const [id, item] of mergedResults) visibleResults.set(id, item);
    visibleResultOrder = [...liveDuringRequest, ...snapshotOrder, ...retainedOlder];
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
  catch (error) {
    if (request === resultRequest && requestedMode === mode) toast(error.message);
  }
}

function refreshLogs(force = true) {
  if (!force && Date.now() - lastLogsRefreshAt < 3_000) return Promise.resolve();
  const requestedMode = mode;
  if (logsRefreshInFlight && logsRefreshMode === requestedMode) return logsRefreshInFlight;
  lastLogsRefreshAt = Date.now();
  const request = ++logsRequest;
  const pending = performLogsRefresh(request, requestedMode).finally(() => {
    if (logsRefreshInFlight === pending) {
      logsRefreshInFlight = undefined;
      logsRefreshMode = undefined;
    }
  });
  logsRefreshInFlight = pending;
  logsRefreshMode = requestedMode;
  return pending;
}

async function performLogsRefresh(request, requestedMode) {
  try {
    const data = await api(`/api/logs?mode=${encodeURIComponent(requestedMode)}&limit=200`);
    if (request !== logsRequest || requestedMode !== mode) return;
    const signature = JSON.stringify([requestedMode, data.path, data.entries]);
    if (signature === logsSignature) return;
    logsSignature = signature;
    el.logPath.textContent = data.path || "任务启动后将在本地生成结构化日志。";
    el.logs.replaceChildren(...(data.entries.length ? data.entries.map(logRow) : [emptyLogRow()]));
  } catch (error) {
    if (request === logsRequest && requestedMode === mode) toast(`读取日志失败：${error.message}`);
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
      if (isNew) visibleResultOrder.unshift(id);
      if (visibleResults.size > 120) pruneVisibleResults(100);
      if (isNew) pendingLiveCommentId = id;
      scheduleResultsRender();
      knownMatches = Math.max(knownMatches, visibleResults.size);
    } catch { /* The next status refresh remains a safe fallback. */ }
  });
  resultStream = stream;
}

function resetVisibleResults(invalidateRequest = true) {
  if (invalidateRequest) resultRequest += 1;
  resultMode = mode;
  visibleResults.clear();
  visibleResultOrder = [];
  pendingLiveCommentId = undefined;
  resultsRenderPending = false;
  resultsNeedRefresh = true;
  clearTimeout(resultRenderTimer);
  resultRenderTimer = undefined;
  renderResults();
}

function syncResultJob(jobMode, jobId) {
  if (resultJobIds[jobMode] === jobId) return;
  resultJobIds[jobMode] = jobId;
  if (jobMode !== mode) return;
  knownMatches = -1;
  resetVisibleResults();
}

function resetVisibleLogs() {
  logsRequest += 1;
  logsSignature = "";
  el.logPath.textContent = "任务启动后将在本地生成结构化日志。";
  el.logs.replaceChildren(emptyLogRow());
}

function renderResults(liveCommentId) {
  const items = visibleResultOrder.map((id) => visibleResults.get(id)).filter(Boolean).slice(0, 50);
  if (visibleResults.size > 100) {
    pruneVisibleResults(100);
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
  const keep = visibleResultOrder.slice(0, limit);
  const keepSet = new Set(keep);
  for (const id of visibleResults.keys()) {
    if (!keepSet.has(id)) visibleResults.delete(id);
  }
  visibleResultOrder = keep;
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
    el.hostConcurrency,
    el.exitLimit,
    form.elements.minDelayMs,
    form.elements.jitterMs,
    form.elements.workersPerProxy,
    form.elements.pageSize,
  ];
}

function allEstimateInputs() {
  return [
    el.estimateComments,
    el.hostConcurrency,
    el.exitLimit,
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
    const lanes = selectedTaskLaneCount(workersPerLane);
    const params = new URLSearchParams({ comments: el.estimateComments.value, pageSize: String(pageSize), minDelayMs: String(minDelayMs), jitterMs: String(jitterMs), networkMs: String(poolNetworkMs), lanes: String(lanes), workersPerLane: String(workersPerLane), proxyTransport: proxyTransport ? "1" : "0", hostConcurrency: el.hostConcurrency.value });
    const value = await api(`/api/estimate?${params}`);
    if (request !== estimateRequest) return;
    el.estimatePages.textContent = fmt(value.pages);
    el.estimateOptimistic.textContent = duration(value.optimisticSeconds);
    el.estimateExpected.textContent = duration(value.expectedSeconds);
    el.estimateConservative.textContent = duration(value.conservativeSeconds);
    const scanMode = mode === "parallel" ? "单曲并行" : "用户来源";
    const transport = value.proxyTransportMaxConcurrent
      ? ` · 主机聚合保护：总并发最多 ${fmt(value.proxyTransportMaxConcurrent)}，启动间隔 ${fmt(value.proxyTransportStartDelayMs)}..${fmt(value.proxyTransportStartDelayMs + value.proxyTransportStartJitterMs)}ms`
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
      ? new Set(["uid", "songId", "workersPerProxy", "shards", "pageSize", "requestBudget", "maxPages", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxProxyLanes", "hostConcurrency"])
      : new Set(["uid", "source", "recordScope", "pageSize", "requestBudget", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxCommentPagesPerSong", "maxSongs", "workersPerProxy", "allowDirect", "maxProxyLanes", "hostConcurrency"]);
    for (const [savedName, value] of Object.entries(descriptor.input || {})) {
      if (!allowed.has(savedName)) continue;
      if (savedName === "maxProxyLanes") {
        el.exitLimit.value = String(value);
        continue;
      }
      if (savedName === "hostConcurrency") {
        el.hostConcurrency.value = String(value);
        continue;
      }
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
  const switchVersion = ++modeSwitchVersion;
  const previous = mode;
  mode = value;
  document.body.dataset.mode = mode;
  syncToolbarContext();
  resetVisibleResults();
  resetVisibleLogs();
  connectResultStream();
  await slideSwap(previous === "parallel" ? el.parallelForm : el.sourceForm, mode === "parallel" ? el.parallelForm : el.sourceForm, mode === "source" ? 1 : -1);
  if (switchVersion !== modeSwitchVersion) {
    syncModeVisibility();
    return;
  }
  knownMatches = -1;
  void refresh(); void refreshResults();
  if ($('.tab.active')?.dataset.tab === "estimate") void refreshEstimate(false);
  if ($('.tab.active')?.dataset.tab === "logs") void refreshLogs();
}
function syncModeVisibility() {
  const parallel = mode === "parallel";
  el.parallelForm.hidden = !parallel;
  el.parallelForm.setAttribute("aria-hidden", String(!parallel));
  el.sourceForm.hidden = parallel;
  el.sourceForm.setAttribute("aria-hidden", String(parallel));
}
async function switchPoolSource(value) {
  if (value === poolSource) return;
  const switchVersion = ++poolSourceSwitchVersion;
  const previous = poolSource;
  poolSource = value;
  await slideSwap(previous === "clash-verge" ? el.clashPoolPane : el.externalPoolPane, poolSource === "clash-verge" ? el.clashPoolPane : el.externalPoolPane, poolSource === "external" ? 1 : -1);
  if (switchVersion !== poolSourceSwitchVersion) {
    syncPoolSourceVisibility();
    return;
  }
  if (!poolRunning) el.poolToggle.querySelector("span").textContent = poolSource === "external" ? "验证并使用" : "自动优选";
}
function syncPoolSourceVisibility() {
  const clash = poolSource === "clash-verge";
  el.clashPoolPane.hidden = !clash;
  el.clashPoolPane.setAttribute("aria-hidden", String(!clash));
  el.externalPoolPane.hidden = clash;
  el.externalPoolPane.setAttribute("aria-hidden", String(clash));
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
  const disabled = startSubmissionBusy || Boolean(activeTaskMode) || poolChangeInFlight || poolStatus === "starting" || poolRefreshing;
  el.parallelStart.disabled = disabled;
  el.sourceStart.disabled = disabled;
  el.dryRun.disabled = disabled;
  el.toolbarStart.disabled = disabled;
  el.hostConcurrency.disabled = disabled;
  el.exitLimit.disabled = disabled;
}
function selectedTaskLaneCount(workersPerLane) {
  if (!poolRunning) return 1;
  const requested = Math.max(0, Number(el.exitLimit.value || 0));
  return Math.min(poolLaneCount, requested > 0 ? requested : poolLaneCount);
}
function syncToolbarContext() {
  const form = mode === "parallel" ? el.parallelForm : el.sourceForm;
  const uid = mode === "parallel" ? el.parallelUid.value.trim() : el.uid.value.trim();
  const workers = Number(form.elements.workersPerProxy?.value || 1);
  const lanes = selectedTaskLaneCount(workers);
  const hostConcurrency = Math.max(1, Number(el.hostConcurrency.value || 8));
  const laneMode = Number(el.exitLimit.value || 0) > 0 ? "手动" : "自动";
  el.toolbarUid.textContent = uid ? `UID ${uid}` : "UID 待填写";
  el.toolbarMode.textContent = mode === "parallel" ? "单曲并行" : `用户来源 · ${sourceName(form.elements.source?.value)}`;
  el.toolbarTopology.textContent = poolRunning
    ? `${laneMode}使用 ${fmt(lanes)}/${fmt(poolLaneCount)} 出口 · 主机≤${fmt(hostConcurrency)}并发 · 每出口≤${fmt(workers)}线程`
    : `1 出口 · 主机≤${fmt(hostConcurrency)}并发 · 每出口≤${fmt(workers)}线程`;
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
  if (["search", "settings"].includes(view)) {
    const alreadyOpen = !document.body.classList.contains("task-panel-collapsed");
    const alreadyActive = $('[data-nav-view].active')?.dataset.navView === view;
    if (alreadyOpen && alreadyActive) {
      setTaskPanelCollapsed(true);
      return;
    }
    setActiveNavigation(view);
    setTaskPanelCollapsed(false);
    if (view === "search") {
      el.taskSidebar.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    const details = (mode === "parallel" ? el.parallelForm : el.sourceForm).querySelector("details.advanced");
    if (details && details.dataset.expanded !== "true") await animateDisclosure(details, true);
    if (details) el.taskSidebar.scrollTo({ top: Math.max(0, details.offsetTop - 12), behavior: "auto" });
    return;
  }
  if (view === "pool") {
    const alreadyOpen = !document.body.classList.contains("inspector-collapsed");
    const alreadyActive = $('[data-nav-view].active')?.dataset.navView === "pool";
    if (alreadyOpen && alreadyActive) {
      setInspectorCollapsed(true);
      setActiveNavigation($('.tab.active')?.dataset.tab || "results");
      return;
    }
  }
  setActiveNavigation(view);
  setTaskPanelCollapsed(true);
  if (view === "pool") setInspectorCollapsed(false);
  openTaskTab(view);
}
function setTaskPanelCollapsed(collapsed) {
  document.body.classList.toggle("task-panel-collapsed", collapsed);
  el.taskPanelToggle.setAttribute("aria-label", "收起任务面板");
  el.taskPanelToggle.title = "收起任务面板";
  el.taskPanelOpen.setAttribute("aria-expanded", String(!collapsed));
  el.taskPanelOpen.setAttribute("aria-label", collapsed ? "打开任务配置" : "关闭任务配置");
  el.taskPanelOpen.title = collapsed ? "打开任务配置" : "关闭任务配置";
  el.taskSidebar.setAttribute("aria-hidden", String(collapsed));
  $$('[data-nav-view="search"], [data-nav-view="settings"]').forEach((item) => item.setAttribute("aria-expanded", String(!collapsed && item.classList.contains("active"))));
  const activeView = $('[data-nav-view].active')?.dataset.navView;
  if (collapsed && ["search", "settings"].includes(activeView)) {
    setActiveNavigation($('.tab.active')?.dataset.tab || "results");
  }
  if (collapsed && el.taskSidebar.contains(document.activeElement)) {
    el.taskPanelOpen.focus({ preventScroll: true });
  }
}
function setInspectorCollapsed(collapsed) {
  document.body.classList.toggle("inspector-collapsed", collapsed);
  el.inspectorToggle.setAttribute("aria-label", collapsed ? "展开运行详情" : "收起运行详情");
  el.inspectorToggle.title = collapsed ? "展开运行详情" : "收起运行详情";
  el.inspectorToggle.setAttribute("aria-expanded", String(!collapsed));
  $('[data-nav-view="pool"]')?.setAttribute("aria-expanded", String(!collapsed));
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
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function formatRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return "0 条/秒";
  return `${rate.toLocaleString("zh-CN", { minimumFractionDigits: rate < 10 ? 1 : 0, maximumFractionDigits: 1 })} 条/秒`;
}
function transportConcurrencyText(job) {
  const configured = Number(job.proxyTransportMaxConcurrent);
  if (!Number.isFinite(configured) || configured <= 0) return "";
  const effective = Number(job.proxyTransportEffectiveConcurrent);
  return Number.isFinite(effective) && effective > 0 && effective < configured
    ? ` · 主机并发上限 ${fmt(configured)} · 自动降载至 ${fmt(effective)}`
    : ` · 主机并发上限 ${fmt(configured)}`;
}
function topologyCapacityNote(job) {
  const workers = Number(job.workers);
  const hostCeiling = Number(job.proxyTransportMaxConcurrent);
  if (!Number.isFinite(workers) || !Number.isFinite(hostCeiling) || workers <= 0 || workers >= hostCeiling) return "";
  return `当前拓扑只创建 ${fmt(workers)} 个 Worker，低于主机并发上限 ${fmt(hostCeiling)}；需要增加任务出口或每 IP 并发才能用满`;
}
function date(value) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function dateOnly(value) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function duration(seconds) { const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return [days ? `${days}天` : "", hours ? `${hours}小时` : "", minutes ? `${minutes}分` : "", rest && !days ? `${rest}秒` : ""].filter(Boolean).join(" ") || "0秒"; }
function clockDuration(milliseconds) { const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":"); }
function fileSize(bytes) { return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`; }
function shortPath(value) { if (!value) return ""; const parts = value.split(/[\\/]/); return parts.slice(-3).join("/"); }
function panelForTab(value) { return $({ results: "#resultsPanel", activity: "#activityPanel", logs: "#logsPanel", pool: "#poolPanel", estimate: "#estimatePanel" }[value]); }
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
el.clashConfigSelectAll.addEventListener("click", toggleClashConfigs);
el.clashConfig.addEventListener("change", () => {
  clashConfigSelection = new Set(selectedClashConfigPaths());
  syncClashSelectAllButton();
});
el.toolbarStart.addEventListener("click", () => (mode === "parallel" ? el.parallelForm : el.sourceForm).requestSubmit());
el.taskPanelOpen.addEventListener("click", () => {
  if (!document.body.classList.contains("task-panel-collapsed")) setTaskPanelCollapsed(true);
  else void activateNavigation("search");
});
el.taskPanelToggle.addEventListener("click", () => setTaskPanelCollapsed(true));
el.inspectorToggle.addEventListener("click", () => setInspectorCollapsed(!document.body.classList.contains("inspector-collapsed")));
$$('[data-nav-view]').forEach((item) => item.addEventListener("click", () => void activateNavigation(item.dataset.navView)));
$$('#parallelForm input, #sourceForm input').forEach((input) => input.addEventListener("input", syncToolbarContext));
el.exitLimit.addEventListener("input", syncToolbarContext);
el.hostConcurrency.addEventListener("input", syncToolbarContext);
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
$$('.tab').forEach((tab) => {
  tab.addEventListener("click", () => void activateTaskTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('.tab');
    const current = tabs.indexOf(tab);
    const next = event.key === "Home"
      ? tabs[0]
      : event.key === "End"
      ? tabs.at(-1)
      : tabs[(current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    void activateTaskTab(next);
  });
});
setupAnimatedDisclosures(); void setupDesktopWindowControls();
setTaskPanelCollapsed(document.body.classList.contains("task-panel-collapsed"));
if (innerWidth <= 1120) setInspectorCollapsed(true);
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
  const switchVersion = ++tabSwitchVersion;
  setTaskPanelCollapsed(true);
  const current = $('.tab.active');
  if (current === tab) {
    syncTaskTabVisibility();
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
    item.tabIndex = active ? 0 : -1;
  });
  setActiveNavigation(tab.dataset.tab);
  await slideSwap(panelForTab(current.dataset.tab), panelForTab(tab.dataset.tab), direction);
  if (switchVersion !== tabSwitchVersion) {
    syncTaskTabVisibility();
    return;
  }
  syncTaskTabVisibility();
  if (tab.dataset.tab === "estimate") await refreshEstimate();
  if (tab.dataset.tab === "logs") await refreshLogs();
  if (tab.dataset.tab === "results") {
    if (resultsNeedRefresh) await refreshResults();
    else if (resultsRenderPending) flushResultsRender();
  }
}

function syncTaskTabVisibility() {
  const activeName = $('.tab.active')?.dataset.tab || "results";
  $$('.tab').forEach((item) => {
    const active = item.dataset.tab === activeName;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  });
  for (const name of ["results", "activity", "logs", "pool", "estimate"]) {
    const panel = panelForTab(name);
    if (!panel) continue;
    panel.hidden = name !== activeName;
    panel.setAttribute("aria-hidden", String(name !== activeName));
  }
}
