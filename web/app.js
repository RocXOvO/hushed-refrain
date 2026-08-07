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
  matches: $("#matchesMetric"), requests: $("#requestsMetric"), current: $("#currentSong"), percent: $("#progressPercent"), bar: $("#progressBar"), note: $("#taskNote"), results: $("#resultsBody"),
  connection: $("#connectionBadge"), login: $("#loginButton"), uidHelpDialog: $("#uidHelpDialog"), qrDialog: $("#qrDialog"), qrImage: $("#qrImage"), qrStatus: $("#qrStatus"), toast: $("#toast"),
  updateButton: $("#updateButton"), updateButtonLabel: $("#updateButtonLabel"), updateIndicator: $("#updateIndicator"), updateDialog: $("#updateDialog"),
  updateReleaseName: $("#updateReleaseName"), updatePublishedAt: $("#updatePublishedAt"), currentVersion: $("#currentVersionLabel"), latestVersion: $("#latestVersionLabel"), updateNotes: $("#updateNotes"), updateAsset: $("#updateAsset"), updateDownload: $("#downloadUpdateButton"),
  updateProgress: $("#updateProgress"), updateProgressLabel: $("#updateProgressLabel"), updateProgressPercent: $("#updateProgressPercent"), updateProgressBar: $("#updateProgressBar"),
  estimateComments: $("#estimateComments"), estimateButton: $("#estimateButton"), estimatePages: $("#estimatePages"), estimateOptimistic: $("#estimateOptimistic"), estimateExpected: $("#estimateExpected"), estimateConservative: $("#estimateConservative"), estimateContext: $("#estimateContext"),
  windowMinimize: $("#windowMinimizeButton"), windowMaximize: $("#windowMaximizeButton"), windowClose: $("#windowCloseButton"),
  appSplash: $("#appSplash"),
};
const statusLabels = { idle: "空闲", running: "运行中", stopping: "停止中", complete: "已完成", matched: "已命中", paused: "已暂停", cooldown: "冷却中", "dry-run": "歌曲已读取", stopped: "已停止", error: "错误" };
let mode = "parallel";
let poolSource = "clash-verge";
let poolSourceInitialized = false;
let poolRunning = false;
let poolLaneCount = 1;
let poolNetworkMs = 400;
let knownMatches = -1;
let toastTimer;
let estimateTimer;
let estimateRequest = 0;
let clashConfigSignature = "";
let poolEntriesSignature = "";
let poolRotationTimer;
let poolRotationIndex = -1;
let resultStream;
let resultMode = mode;
let nativeUpdateState;
const visibleResults = new Map();
const disclosureAnimations = new WeakMap();

async function api(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function payload(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, ["uid", "songId"].includes(key) ? String(value).trim() : Number.isNaN(Number(value)) || value === "" ? value : Number(value)]));
}

async function startParallel() {
  if (!el.parallelForm.reportValidity()) return;
  setBusy(true);
  try {
    const value = payload(el.parallelForm);
    value.fresh = $("#parallelFresh").checked;
    renderParallel(await api("/api/parallel/job", { method: "POST", body: JSON.stringify(value) }));
    toast("并行扫描已启动");
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}

async function startSource(dryRun) {
  if (!el.sourceForm.reportValidity()) return;
  setBusy(true);
  try {
    const value = payload(el.sourceForm);
    value.maxCommentPagesPerSong = value.maxPages; delete value.maxPages;
    value.fresh = $("#fresh").checked; value.dryRun = dryRun;
    renderSource(await api("/api/job", { method: "POST", body: JSON.stringify(value) }));
    toast(dryRun ? "正在读取候选歌曲" : "来源扫描已启动");
  } catch (error) { toast(error.message); } finally { setBusy(false); }
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
    if (Number(el.poolCandidates.value) < Number(el.poolSize.value)) {
      toast("候选节点数不能少于独立出口数");
      return;
    }
  }
  el.poolToggle.disabled = true;
  const stopping = poolRunning;
  if (!stopping) renderPoolEntries([], "starting");
  try {
    const path = stopping ? "/api/pool/stop" : poolSource === "external" ? "/api/pool/import" : "/api/pool/start";
    const value = stopping
      ? {}
      : poolSource === "external"
      ? { proxies: el.externalProxies.value, size: 0 }
      : { size: Number(el.poolSize.value), candidates: Number(el.poolCandidates.value), sourceConfigPath: el.clashConfig.value || undefined };
    renderPool(await api(path, { method: "POST", body: JSON.stringify(value) }));
    toast(stopping ? "代理池已停止" : "已选出可用的最优出口");
  } catch (error) { toast(error.message); } finally { el.poolToggle.disabled = false; }
}

async function refresh() {
  try {
    const [job, pool] = await Promise.all([api(mode === "parallel" ? "/api/parallel/job" : "/api/job"), api("/api/pool")]);
    mode === "parallel" ? renderParallel(job) : renderSource(job);
    renderPool(pool);
    el.connection.classList.add("ready");
    if (job.matches !== knownMatches) { knownMatches = job.matches; await refreshResults(); }
  } catch (error) { el.connection.classList.remove("ready"); toast(error.message); }
}

function renderParallel(job) {
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.songId ? `${job.songName || "歌曲"} · UID ${job.uid}` : "等待单曲任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "分片进度"; el.progress.textContent = `${fmt(job.shardsComplete)} / ${fmt(job.shards)}`;
  el.workLabel.textContent = "已读评论"; el.work.textContent = fmt(job.commentsInspected); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const percent = job.shards ? Math.min(100, Math.round(job.shardsComplete / job.shards * 100)) : 0;
  progress(percent, job.songId ? `${fmt(job.lanes)} 个出口 · ${fmt(job.workers)} 个工作线程 · ${fmt(job.pagesProcessed)} 页` : "尚未开始", job.note || job.error);
  el.stop.disabled = !active; el.parallelStart.disabled = active;
}

function renderSource(job) {
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.uid ? `UID ${job.uid} · ${sourceName(job.source)}` : "等待来源任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "歌曲进度"; el.progress.textContent = `${fmt(job.songsProcessed)} / ${fmt(job.songs)}`;
  el.workLabel.textContent = "已扫页面"; el.work.textContent = fmt(job.pagesProcessed); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const percent = job.songs ? Math.min(100, Math.round(job.songsProcessed / job.songs * 100)) : 0;
  const current = job.currentSong ? `${job.currentSong.name || "未命名歌曲"} · ${job.currentSong.id}` : "尚未读取歌曲";
  const topology = `${fmt(job.lanes || 1)} 个出口 · ${fmt(job.workers || 1)} 个工作线程`;
  progress(percent, `${current} · ${topology}`, [job.note, job.error, ...(job.sourceErrors || [])].filter(Boolean).join(" · "));
  el.stop.disabled = !active; el.sourceStart.disabled = active; el.dryRun.disabled = active;
}

function progress(percent, current, note) { el.bar.style.width = `${percent}%`; el.percent.textContent = `${percent}%`; el.current.textContent = current; el.note.hidden = !note; el.note.textContent = note || ""; }

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
  const configCount = renderClashConfigs(discovery, pool.sourceConfigPath, pool.status);
  el.poolSize.disabled = pool.status !== "not-running";
  el.poolCandidates.disabled = pool.status !== "not-running";
  el.poolDiscovery.textContent = discovery?.installed
    ? configCount > 1
      ? `已找到 ${fmt(configCount)} 套可选配置与 Mihomo 内核，构建前请选择。`
      : `已找到 Clash Verge 配置与 Mihomo 内核 · ${shortPath(discovery.configPath)}`
    : "未自动找到 Clash Verge，可切换到“其他代理池”手动接入。";
  renderPoolEntries(poolRunning ? pool.entries : [], pool.status);
}

function renderPoolEntries(entries, status) {
  if (status === "starting") {
    stopPoolRotation();
    if (poolEntriesSignature !== "starting") {
      poolEntriesSignature = "starting";
      el.poolEntries.innerHTML = '<div class="pool-selecting"><span class="pool-selecting-ring" aria-hidden="true"></span><span>正在轮换测速并优选出口</span></div>';
      el.poolTable.innerHTML = '<tr class="empty-row"><td colspan="5">正在测速与验证候选节点…</td></tr>';
    }
    return;
  }
  if (status !== "running" || entries.length === 0) {
    stopPoolRotation();
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
    poolRotationIndex = -1;
    el.poolEntries.replaceChildren(...entries.map((entry, index) => {
      const row = document.createElement("div");
      row.className = "pool-entry";
      row.innerHTML = `<span class="lane-swatch lane-${index % 4}"></span><strong>${escapeHtml(entry.egressIp)}</strong><span>${fmt(entry.ncmLatencyMs)}ms</span>`;
      return row;
    }));
    el.poolTable.replaceChildren(...entries.map((entry) => tableRow([entry.name, entry.endpoint, entry.egressIp, `${fmt(entry.ncmLatencyMs)} ms`, entry.ncmVerified ? "已验证" : "待验证"])));
  }
  startPoolRotation();
}

function startPoolRotation() {
  if (poolRotationTimer || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  advancePoolRotation();
  poolRotationTimer = setInterval(advancePoolRotation, 1800);
}

function advancePoolRotation() {
  const rows = [...el.poolEntries.querySelectorAll(".pool-entry")];
  if (!rows.length) return;
  rows.forEach((row) => row.classList.remove("is-current"));
  poolRotationIndex = (poolRotationIndex + 1) % rows.length;
  rows[poolRotationIndex].classList.add("is-current");
}

function stopPoolRotation() {
  clearInterval(poolRotationTimer);
  poolRotationTimer = undefined;
  poolRotationIndex = -1;
  el.poolEntries.querySelectorAll(".pool-entry").forEach((row) => row.classList.remove("is-current"));
}

function renderClashConfigs(discovery, activePoolPath, poolStatus) {
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
  const previous = el.clashConfig.value;
  if (signature !== clashConfigSignature) {
    clashConfigSignature = signature;
    el.clashConfig.replaceChildren(...uniqueChoices.map((choice) => {
      const option = document.createElement("option");
      option.value = choice.path;
      option.textContent = choice.label;
      return option;
    }));
    const preferred = [previous, activePoolPath, discovery.configPath, uniqueChoices.find((choice) => choice.label.includes("当前订阅"))?.path]
      .find((path) => path && uniqueChoices.some((choice) => choice.path === path));
    if (preferred) el.clashConfig.value = preferred;
  } else if (poolStatus === "running" && activePoolPath && uniqueChoices.some((choice) => choice.path === activePoolPath)) {
    el.clashConfig.value = activePoolPath;
  }
  el.clashConfigField.hidden = uniqueChoices.length <= 1;
  el.clashConfig.disabled = poolStatus !== "not-running";
  return uniqueChoices.length;
}

async function refreshResults() {
  try {
    const requestedMode = mode;
    const data = await api(`${requestedMode === "parallel" ? "/api/parallel/results" : "/api/results"}?limit=50`);
    if (requestedMode !== mode) return;
    if (resultMode !== mode) resetVisibleResults();
    data.results.forEach((item) => visibleResults.set(String(item.commentId), item));
    renderResults();
  }
  catch (error) { toast(error.message); }
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
      renderResults(isNew ? id : undefined);
      knownMatches = Math.max(knownMatches, visibleResults.size);
    } catch { /* The next status refresh remains a safe fallback. */ }
  });
  resultStream = stream;
}

function resetVisibleResults() {
  resultMode = mode;
  visibleResults.clear();
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
    const params = new URLSearchParams({ comments: el.estimateComments.value, pageSize: String(pageSize), minDelayMs: String(minDelayMs), jitterMs: String(jitterMs), networkMs: String(poolNetworkMs), lanes: String(poolLaneCount), workersPerLane: String(workersPerLane) });
    const value = await api(`/api/estimate?${params}`);
    if (request !== estimateRequest) return;
    el.estimatePages.textContent = fmt(value.pages);
    el.estimateOptimistic.textContent = duration(value.optimisticSeconds);
    el.estimateExpected.textContent = duration(value.expectedSeconds);
    el.estimateConservative.textContent = duration(value.conservativeSeconds);
    const scanMode = mode === "parallel" ? "单曲并行" : "用户来源";
    el.estimateContext.textContent = `${scanMode} · ${fmt(value.lanes)} 个出口 × 每出口 ${fmt(value.workersPerLane)} 并发 · 每页 ${fmt(pageSize)} 条 · 每线程间隔 ${fmt(minDelayMs)}ms + 0..${fmt(jitterMs)}ms · 实测延迟约 ${fmt(poolNetworkMs)}ms · 预期 ${fmt(value.expectedCommentsPerSecond)} 条/秒`;
  } catch (error) { if (request === estimateRequest) toast(error.message); }
  finally { if (request === estimateRequest) el.estimateButton.disabled = false; }
}

function tableRow(values) { const row = document.createElement("tr"); values.forEach((value) => appendTextCell(row, value)); return row; }
function emptyRow() { const row = document.createElement("tr"); row.className = "empty-row"; const cell = document.createElement("td"); cell.colSpan = 5; cell.textContent = "暂无命中"; row.append(cell); return row; }

async function stopJob() { try { mode === "parallel" ? renderParallel(await api("/api/parallel/job/stop", { method: "POST", body: "{}" })) : renderSource(await api("/api/job/stop", { method: "POST", body: "{}" })); } catch (error) { toast(error.message); } }
async function refreshAuth() { try { const auth = await api("/api/auth"); el.connection.innerHTML = `<span class="status-dot"></span>${auth.cookiePresent ? "会话已登录" : "本地服务"}`; el.login.querySelector("span").textContent = auth.cookiePresent ? "更新登录" : "二维码登录"; if (el.qrDialog.open) renderAuth(auth); } catch {} }
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
    setNativeUpdateAction("重启并安装");
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
      setNativeUpdateAction("正在重启…", true);
      await window.ncmDesktop.installUpdate();
    } else {
      renderWindowsUpdate(await window.ncmDesktop.checkForUpdates());
    }
  } catch (error) {
    toast(`更新失败：${error.message}`);
  }
}

async function setupDesktopUpdates() {
  const desktop = window.ncmDesktop;
  if (desktop?.platform !== "win32" || typeof desktop.getUpdateState !== "function") return;
  const state = await desktop.getUpdateState();
  if (!state?.supported) return;
  renderWindowsUpdate(state);
  desktop.onUpdateState((next) => renderWindowsUpdate(next));
}

async function switchMode(value) {
  if (value === mode) return;
  const previous = mode;
  mode = value;
  document.body.dataset.mode = mode;
  resetVisibleResults();
  connectResultStream();
  await slideSwap(previous === "parallel" ? el.parallelForm : el.sourceForm, mode === "parallel" ? el.parallelForm : el.sourceForm, mode === "source" ? 1 : -1);
  knownMatches = -1;
  void refresh(); void refreshResults();
  if ($('.tab.active')?.dataset.tab === "estimate") void refreshEstimate(false);
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

function setBusy(value) { el.parallelStart.disabled = value; el.sourceStart.disabled = value; el.dryRun.disabled = value; }
function sourceName(value) { return { record: "听歌排行", likes: "喜欢歌曲", both: "两者" }[value] || value || "-"; }
function fmt(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function date(value) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function dateOnly(value) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function duration(seconds) { const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return [days ? `${days}天` : "", hours ? `${hours}小时` : "", minutes ? `${minutes}分` : "", rest && !days ? `${rest}秒` : ""].filter(Boolean).join(" ") || "0秒"; }
function fileSize(bytes) { return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`; }
function shortPath(value) { if (!value) return ""; const parts = value.split(/[\\/]/); return parts.slice(-3).join("/"); }
function panelForTab(value) { return $({ results: "#resultsPanel", pool: "#poolPanel", estimate: "#estimatePanel" }[value]); }
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
  connectResultStream();
  await setupDesktopUpdates();
  await Promise.allSettled([refresh(), refreshResults(), refreshAuth()]);
  dismissSplash();
  void checkUpdates(false);
}

el.parallelForm.addEventListener("submit", (event) => { event.preventDefault(); void startParallel(); });
el.sourceForm.addEventListener("submit", (event) => { event.preventDefault(); void startSource(false); });
el.dryRun.addEventListener("click", () => void startSource(true)); el.songLookup.addEventListener("click", () => void lookupSong()); el.lookup.addEventListener("click", () => void lookupUser());
el.poolToggle.addEventListener("click", () => void togglePool()); el.stop.addEventListener("click", () => void stopJob()); el.refresh.addEventListener("click", () => void refresh());
el.estimateButton.addEventListener("click", () => void refreshEstimate());
allEstimateInputs().forEach((input) => input.addEventListener("input", () => scheduleEstimateRefresh()));
$$('[data-comments]').forEach((button) => button.addEventListener("click", () => { el.estimateComments.value = button.dataset.comments; void refreshEstimate(); }));
$$('[data-open-uid-help]').forEach((button) => button.addEventListener("click", () => el.uidHelpDialog.showModal()));
$("#closeUidHelpButton").addEventListener("click", () => el.uidHelpDialog.close());
$("#gotUidHelpButton").addEventListener("click", () => el.uidHelpDialog.close());
el.login.addEventListener("click", () => void startAuth()); $("#closeQrButton").addEventListener("click", () => el.qrDialog.close());
el.updateButton.addEventListener("click", () => void checkUpdates(true));
$("#closeUpdateButton").addEventListener("click", () => el.updateDialog.close());
$("#laterUpdateButton").addEventListener("click", () => el.updateDialog.close());
el.updateDownload.addEventListener("click", (event) => void activateUpdate(event));
$$('input[name="mode"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) void switchMode(input.value); }));
$$('input[name="poolSource"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) void switchPoolSource(input.value); }));
$$('input[name="source"]').forEach((input) => input.addEventListener("change", () => { $("#recordScopeField").hidden = input.checked && input.value === "likes"; }));
$$('.tab').forEach((tab) => tab.addEventListener("click", () => { const current = $('.tab.active'); if (current === tab) return; const tabs = $$('.tab'); const direction = tabs.indexOf(tab) > tabs.indexOf(current) ? 1 : -1; tabs.forEach((item) => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); }); void slideSwap(panelForTab(current.dataset.tab), panelForTab(tab.dataset.tab), direction); if (tab.dataset.tab === "estimate") void refreshEstimate(); }));
setupAnimatedDisclosures(); void setupDesktopWindowControls();
void boot(); setInterval(() => void refresh(), 1500); setInterval(() => void refreshAuth(), 3000);
addEventListener("pagehide", () => { resultStream?.close(); stopPoolRotation(); });
