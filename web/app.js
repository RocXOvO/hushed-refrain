const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const el = {
  parallelForm: $("#parallelForm"), sourceForm: $("#sourceForm"), parallelUid: $("#parallelUid"), uid: $("#uid"),
  songId: $("#songId"), songPreview: $("#songPreview"), songLookup: $("#songLookupButton"), lookup: $("#lookupButton"),
  userPreview: $("#userPreview"), userNickname: $("#userNickname"), userMeta: $("#userMeta"), recordProbe: $("#recordProbe"), likesProbe: $("#likesProbe"),
  poolStatus: $("#poolStatus"), poolEntries: $("#poolEntries"), poolTable: $("#poolTableBody"), poolToggle: $("#poolToggleButton"),
  parallelStart: $("#parallelStartButton"), sourceStart: $("#sourceStartButton"), dryRun: $("#dryRunButton"), stop: $("#stopButton"), refresh: $("#refreshButton"),
  taskTitle: $("#taskTitle"), status: $("#statusMetric"), progressLabel: $("#progressLabel"), progress: $("#progressMetric"), workLabel: $("#workLabel"), work: $("#workMetric"),
  matches: $("#matchesMetric"), requests: $("#requestsMetric"), current: $("#currentSong"), percent: $("#progressPercent"), bar: $("#progressBar"), note: $("#taskNote"), results: $("#resultsBody"),
  connection: $("#connectionBadge"), login: $("#loginButton"), qrDialog: $("#qrDialog"), qrImage: $("#qrImage"), qrStatus: $("#qrStatus"), toast: $("#toast"),
};
const statusLabels = { idle: "空闲", running: "运行中", stopping: "停止中", complete: "已完成", matched: "已命中", paused: "已暂停", cooldown: "冷却中", "dry-run": "歌曲已读取", stopped: "已停止", error: "错误" };
let mode = "parallel";
let poolRunning = false;
let knownMatches = -1;
let toastTimer;

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
    value.stopAfterFirst = $("#parallelStopFirst").checked;
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
    value.stopAfterFirst = $("#stopAfterFirst").checked; value.fresh = $("#fresh").checked; value.dryRun = dryRun;
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
  el.poolToggle.disabled = true;
  const stopping = poolRunning;
  try {
    const path = stopping ? "/api/pool/stop" : "/api/pool/start";
    renderPool(await api(path, { method: "POST", body: stopping ? "{}" : JSON.stringify({ size: 4, candidates: 24 }) }));
    toast(stopping ? "代理池已停止" : "代理池已完成出口验证");
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
  el.workLabel.textContent = "当前偏移"; el.work.textContent = fmt(job.commentOffset); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const percent = job.songs ? Math.min(100, Math.round(job.songsProcessed / job.songs * 100)) : 0;
  const current = job.currentSong ? `${job.currentSong.name || "未命名歌曲"} · ${job.currentSong.id}` : "尚未读取歌曲";
  progress(percent, current, [job.note, job.error, ...(job.sourceErrors || [])].filter(Boolean).join(" · "));
  el.stop.disabled = !active; el.sourceStart.disabled = active; el.dryRun.disabled = active;
}

function progress(percent, current, note) { el.bar.style.width = `${percent}%`; el.percent.textContent = `${percent}%`; el.current.textContent = current; el.note.hidden = !note; el.note.textContent = note || ""; }

function renderPool(pool) {
  poolRunning = pool.status === "running";
  el.poolStatus.textContent = { running: `${pool.entries.length} 个出口在线`, starting: "正在验证", "not-running": "未运行" }[pool.status] || pool.status;
  el.poolToggle.querySelector("span").textContent = poolRunning ? "停止" : "构建";
  if (!pool.entries.length) { el.poolEntries.innerHTML = '<div class="pool-empty">等待代理节点</div>'; el.poolTable.innerHTML = '<tr class="empty-row"><td colspan="5">代理池未运行</td></tr>'; return; }
  el.poolEntries.replaceChildren(...pool.entries.map((entry, index) => { const row = document.createElement("div"); row.className = "pool-entry"; row.innerHTML = `<span class="lane-swatch lane-${index % 4}"></span><strong>${escapeHtml(entry.egressIp)}</strong><span>${fmt(entry.ncmLatencyMs)}ms</span>`; return row; }));
  el.poolTable.replaceChildren(...pool.entries.map((entry) => tableRow([entry.name, entry.endpoint, entry.egressIp, `${fmt(entry.ncmLatencyMs)} ms`, entry.ncmVerified ? "已验证" : "待验证"])));
}

async function refreshResults() {
  try { const data = await api(`${mode === "parallel" ? "/api/parallel/results" : "/api/results"}?limit=50`); el.results.replaceChildren(...(data.results.length ? data.results.map((item) => tableRow([item.time ? date(item.time) : "-", `${item.nickname || "-"} · ${item.userId}`, item.songName || item.resourceName || item.songId || "-", item.content || "", fmt(item.likedCount)])) : [emptyRow()])); }
  catch (error) { toast(error.message); }
}

function tableRow(values) { const row = document.createElement("tr"); values.forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }); return row; }
function emptyRow() { const row = document.createElement("tr"); row.className = "empty-row"; const cell = document.createElement("td"); cell.colSpan = 5; cell.textContent = "暂无命中"; row.append(cell); return row; }

async function stopJob() { try { mode === "parallel" ? renderParallel(await api("/api/parallel/job/stop", { method: "POST", body: "{}" })) : renderSource(await api("/api/job/stop", { method: "POST", body: "{}" })); } catch (error) { toast(error.message); } }
async function refreshAuth() { try { const auth = await api("/api/auth"); el.connection.innerHTML = `<span class="status-dot"></span>${auth.cookiePresent ? "会话已登录" : "本地服务"}`; el.login.querySelector("span").textContent = auth.cookiePresent ? "更新登录" : "二维码登录"; if (el.qrDialog.open) renderAuth(auth); } catch {} }
async function startAuth() { el.qrDialog.showModal(); el.qrStatus.textContent = "正在生成"; el.qrImage.removeAttribute("src"); try { renderAuth(await api("/api/auth/qr", { method: "POST", body: "{}" })); } catch (error) { el.qrStatus.textContent = error.message; } }
function renderAuth(auth) { const labels = { idle: "等待开始", creating: "正在生成", waiting: "等待扫码", scanned: "等待手机确认", authorized: "登录完成", expired: "二维码已过期", error: auth.error || "登录出错" }; el.qrStatus.textContent = labels[auth.status] || auth.status; if (auth.qrImageUrl) el.qrImage.src = auth.qrImageUrl; if (auth.status === "authorized") setTimeout(() => el.qrDialog.close(), 700); }

function switchMode(value) { mode = value; el.parallelForm.hidden = mode !== "parallel"; el.sourceForm.hidden = mode !== "source"; knownMatches = -1; void refresh(); void refreshResults(); }
function setBusy(value) { el.parallelStart.disabled = value; el.sourceStart.disabled = value; el.dryRun.disabled = value; }
function sourceName(value) { return { record: "听歌排行", likes: "喜欢歌曲", both: "两者" }[value] || value || "-"; }
function fmt(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function date(value) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
function toast(message) { clearTimeout(toastTimer); el.toast.textContent = message; el.toast.hidden = false; toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4500); }

el.parallelForm.addEventListener("submit", (event) => { event.preventDefault(); void startParallel(); });
el.sourceForm.addEventListener("submit", (event) => { event.preventDefault(); void startSource(false); });
el.dryRun.addEventListener("click", () => void startSource(true)); el.songLookup.addEventListener("click", () => void lookupSong()); el.lookup.addEventListener("click", () => void lookupUser());
el.poolToggle.addEventListener("click", () => void togglePool()); el.stop.addEventListener("click", () => void stopJob()); el.refresh.addEventListener("click", () => void refresh());
el.login.addEventListener("click", () => void startAuth()); $("#closeQrButton").addEventListener("click", () => el.qrDialog.close());
$$('input[name="mode"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) switchMode(input.value); }));
$$('input[name="source"]').forEach((input) => input.addEventListener("change", () => { $("#recordScopeField").hidden = input.checked && input.value === "likes"; }));
$$('.tab').forEach((tab) => tab.addEventListener("click", () => { $$('.tab').forEach((item) => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); }); $("#resultsPanel").hidden = tab.dataset.tab !== "results"; $("#poolPanel").hidden = tab.dataset.tab !== "pool"; }));
void refresh(); void refreshResults(); void refreshAuth(); setInterval(() => void refresh(), 1500); setInterval(() => void refreshAuth(), 3000);
