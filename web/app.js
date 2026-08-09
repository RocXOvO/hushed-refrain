document.documentElement.dataset.desktopPlatform = new URLSearchParams(location.search).get("desktop") || "web";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const el = {
  parallelForm: $("#parallelForm"), sourceForm: $("#sourceForm"), parallelUid: $("#parallelUid"), uid: $("#uid"),
  qqSongForm: $("#qqSongForm"), qqLikesForm: $("#qqLikesForm"), qqSongTarget: $("#qqSongTarget"), qqLikesTarget: $("#qqLikesTarget"),
  qqSongId: $("#qqSongId"), qqSongQuery: $("#qqSongQuery"), qqSongResults: $("#qqSongResults"), qqSongPreview: $("#qqSongPreview"), qqSongLookup: $("#qqSongLookupButton"),
  songId: $("#songId"), songQuery: $("#neteaseSongQuery"), songResults: $("#neteaseSongResults"), songPreview: $("#songPreview"), songLookup: $("#songLookupButton"), lookup: $("#lookupButton"),
  userPreview: $("#userPreview"), userNickname: $("#userNickname"), userMeta: $("#userMeta"), recordProbe: $("#recordProbe"), likesProbe: $("#likesProbe"),
  poolStatus: $("#poolStatus"), poolState: $("#poolStateIndicator"), poolEntries: $("#poolEntries"), poolTable: $("#poolTableBody"), poolToggle: $("#poolToggleButton"),
  poolDiscovery: $("#poolDiscovery"), clashPoolPane: $("#clashPoolPane"), clashConfigField: $("#clashConfigField"), clashConfig: $("#clashConfigSelect"), clashConfigSelectAll: $("#clashConfigSelectAllButton"), poolSize: $("#poolSize"), poolCandidates: $("#poolCandidates"), externalPoolPane: $("#externalPoolPane"), externalProxies: $("#externalProxies"),
  parallelStart: $("#parallelStartButton"), sourceStart: $("#sourceStartButton"), qqSongStart: $("#qqSongStartButton"), qqLikesStart: $("#qqLikesStartButton"), dryRun: $("#dryRunButton"), stop: $("#stopButton"), refresh: $("#refreshButton"),
  taskTitle: $("#taskTitle"), status: $("#statusMetric"), progressLabel: $("#progressLabel"), progress: $("#progressMetric"), workLabel: $("#workLabel"), work: $("#workMetric"),
  matches: $("#matchesMetric"), requests: $("#requestsMetric"), speed: $("#speedMetric"), globalContext: $("#globalProgressContext"), percent: $("#progressPercent"), bar: $("#progressBar"), note: $("#taskNote"), results: $("#resultsBody"), exportResults: $("#exportResultsButton"),
  logs: $("#logsBody"), logPath: $("#logPath"),
  connection: $("#connectionBadge"), login: $("#loginButton"), uidHelpDialog: $("#uidHelpDialog"), parameterHelpDialog: $("#parameterHelpDialog"), parameterHelpTitle: $("#parameterHelpTitle"), parameterHelpDescription: $("#parameterHelpDescription"), qrDialog: $("#qrDialog"), qrImage: $("#qrImage"), qrStatus: $("#qrStatus"), toast: $("#toast"),
  classicDialog: $("#classicEncryptUinDialog"), classicInput: $("#classicEncryptUinInput"), classicDecode: $("#classicDecodeButton"), classicResult: $("#classicDecodeResult"), classicIdentityKind: $("#classicIdentityKind"), classicMaskedIdentifier: $("#classicMaskedIdentifier"), classicIdentifierWarning: $("#classicIdentifierWarning"), classicReveal: $("#classicRevealButton"), classicCopy: $("#classicCopyButton"), classicVerify: $("#classicVerifyButton"), classicDecodeStatus: $("#classicDecodeStatus"), classicVerifyStatus: $("#classicVerifyStatus"),
  settlementDialog: $("#settlementDialog"), settlementTitle: $("#settlementTitle"), settlementStatus: $("#settlementStatus"), settlementContext: $("#settlementContext"), settlementElapsed: $("#settlementElapsed"), settlementMatches: $("#settlementMatches"), settlementPages: $("#settlementPages"), settlementRequests: $("#settlementRequests"), settlementCoverage: $("#settlementCoverage"), settlementNote: $("#settlementNote"), settlementLogPath: $("#settlementLogPath"), settlementFootnote: $("#settlementFootnote"),
  updateButton: $("#updateButton"), updateButtonLabel: $("#updateButtonLabel"), updateIndicator: $("#updateIndicator"), updateDialog: $("#updateDialog"),
  updateReleaseName: $("#updateReleaseName"), updatePublishedAt: $("#updatePublishedAt"), currentVersion: $("#currentVersionLabel"), latestVersion: $("#latestVersionLabel"), updateNotes: $("#updateNotes"), updateAsset: $("#updateAsset"), updateDownload: $("#downloadUpdateButton"),
  updateProgress: $("#updateProgress"), updateProgressLabel: $("#updateProgressLabel"), updateProgressPercent: $("#updateProgressPercent"), updateProgressBar: $("#updateProgressBar"),
  estimateComments: $("#estimateComments"), estimateButton: $("#estimateButton"), estimatePages: $("#estimatePages"), estimateOptimistic: $("#estimateOptimistic"), estimateExpected: $("#estimateExpected"), estimateConservative: $("#estimateConservative"), estimateContext: $("#estimateContext"),
  windowMinimize: $("#windowMinimizeButton"), windowMaximize: $("#windowMaximizeButton"), windowClose: $("#windowCloseButton"),
  runtimeTimer: $("#runtimeTimer"), runtimeTimerLabel: $("#runtimeTimerLabel"), runtimeTimerValue: $("#runtimeTimerValue"),
  toolbarUid: $("#toolbarUidLabel"), toolbarMode: $("#toolbarModeLabel"), toolbarTopology: $("#toolbarTopologyLabel"), toolbarStart: $("#toolbarStartButton"), hostConcurrency: $("#taskHostConcurrency"), exitLimit: $("#taskExitLimit"),
  primaryNavigation: $("#primaryNavigation"), taskSidebar: $("#taskSidebar"), taskPanelOpen: $("#taskPanelOpenButton"), taskPanelToggle: $("#taskPanelToggleButton"), inspectorToggle: $("#inspectorToggleButton"), inspectorBody: $("#runtimeInspectorBody"),
  activeSongCount: $("#activeSongCount"), activeWorkerCount: $("#activeWorkerCount"), activeSongSummary: $("#activeSongSummary"), activeSongsList: $("#activeSongsList"),
  appSplash: $("#appSplash"), platformIdentity: $("#platformIdentity"), platformSurface: $("#platformSurface"), platformLiveRegion: $("#platformLiveRegion"),
  neteaseWorkbench: $("#neteaseWorkbench"), qqWorkbench: $("#qqWorkbench"),
};
const statusLabels = { idle: "空闲", running: "运行中", stopping: "停止中", complete: "已完成", matched: "已命中", paused: "已暂停", cooldown: "冷却中", "dry-run": "歌曲已读取", stopped: "已停止", error: "错误" };
let platform = "netease";
let mode = "parallel";
const selectedModes = { netease: "parallel", qq: "song" };
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
let neteaseAuthCookiePresent = false;
let clashConfigSignature = "";
let clashConfigSelection;
let poolEntriesSignature = "";
let renderedJobSignature = "";
let logsSignature = "";
let logsRefreshInFlight;
let logsRefreshView;
let logsRequest = 0;
let lastLogsRefreshAt = 0;
let resultStream;
let resultView = "netease:parallel";
let resultRequest = 0;
const resultGenerations = Object.fromEntries(["netease:parallel", "netease:source", "qq:song", "qq:likes"].map((key) => [key, undefined]));
const resultGenerationRevisions = Object.fromEntries(["netease:parallel", "netease:source", "qq:song", "qq:likes"].map((key) => [key, 0]));
const latestJobs = Object.fromEntries(["netease:parallel", "netease:source", "qq:song", "qq:likes"].map((key) => [key, undefined]));
const localRequestedTargets = Object.fromEntries(["qq:song", "qq:likes"].map((key) => [key, undefined]));
let resultExportInProgress = false;
let resultRenderTimer;
let pendingLiveCommentId;
let resultsRenderPending = false;
let resultsNeedRefresh = false;
let nativeUpdateState;
let activeTaskMode;
let activeTaskViewKey;
let startSubmissionBusy = false;
let qqLookupBusy = false;
const qqLookupControllers = new Set();
let classicDecoded;
let classicDecodeVersion = 0;
let classicDecodeController;
let classicVerificationController;
let desiredPlatform = platform;
let platformTransition;
let pendingPlatformScrollRestore;
const PLATFORM_SCROLL_RESTORE_TTL_MS = 2_500;
let runtimeClock;
let runtimeClockText = "";
let refreshTimer;
let authRefreshTimer;
let runtimeTimerInterval;
let pageLifecycleSuspended = false;
let modeSwitchVersion = 0;
let platformSwitchVersion = 0;
let tabSwitchVersion = 0;
const selectedTabs = { netease: "results", qq: "results" };
const settlementPending = Object.fromEntries(["netease:parallel", "netease:source", "qq:song", "qq:likes"].map((key) => [key, undefined]));
const visibleResults = new Map();
let visibleResultOrder = [];
const disclosureAnimations = new WeakMap();
const activeDisclosureDetails = new Set();
const interfaceAnimations = new Set();
const fallbackMotionElements = new Set();
let activeSongsSignature = "";
const activeSongRows = new Map();
const inspectorOverlayQuery = matchMedia("(max-width: 1280px)");

const PARAMETER_HELP = {
  "target-netease": ["用户 UID", "输入网易云音乐用户主页里的数字 UID。它不是昵称；可以使用右侧的获取教程查看具体位置。"],
  "target-qq": ["QQ 目标用户", "可输入数字 QQ 号、个人主页链接或 EncryptUin。实际匹配会使用规范化后的完整 EncryptUin。"],
  song: ["歌曲", "输入 2–80 个字符的歌名或歌手，然后从候选项中选择。也可直接粘贴纯数字歌曲 ID，客户端会继续兼容这条高级路径。"],
  "workers-per-exit": ["每出口工作线程", "同一个代理出口最多可同时调度的工作数。增加工作线程不会缩短该出口的请求启动间隔；它只允许慢请求的网络等待互相重叠，并提升跨歌曲调度能力。"],
  "total-workers": ["总工作线程上限", "整个任务在本机可创建的工作线程硬上限。实际数量还受可用出口、每出口工作线程和主机保护限制。"],
  "exit-limit": ["任务出口上限", "只限制当前任务最多使用多少个已验证独立出口，不会缩小或重建共享代理池。0 表示自动使用当前全部可用出口。"],
  "request-interval": ["每出口请求启动间隔", "同一出口相邻两次远程请求开始之间的真实最小间隔，随机抖动只会在此基础上增加。工作线程数不会缩短这个值；不同出口分别计时。数值越小越快，但触发上游限流的概率也更高。"],
  "request-limit": ["请求上限（0不限）", "限制当次运行可以预约的逻辑评论页数。0 表示不设任务级上限；停止后仍可从检查点继续。"],
  fresh: ["新建状态", "开启后忽略该模式的旧检查点并重新扫描。关闭时会尝试按已保存的游标或分片续跑；已持久化结果仍会去重。"],
};

const TASK_VIEWS = {
  "netease:parallel": { platform: "netease", mode: "parallel", form: el.parallelForm, taskMode: "parallel", jobBase: "/api/parallel/job", resultsBase: "/api/parallel/results", label: "单曲并行" },
  "netease:source": { platform: "netease", mode: "source", form: el.sourceForm, taskMode: "source", jobBase: "/api/job", resultsBase: "/api/results", label: "用户来源" },
  "qq:song": { platform: "qq", mode: "song", form: el.qqSongForm, taskMode: "qq", jobBase: "/api/qq/job", resultsBase: "/api/qq/results", label: "QQ 单曲顺序" },
  "qq:likes": { platform: "qq", mode: "likes", form: el.qqLikesForm, taskMode: "qq", jobBase: "/api/qq/job", resultsBase: "/api/qq/results", label: "QQ 公开喜欢歌曲" },
};

const SONG_SEARCHES = {
  netease: {
    platform: "netease",
    query: el.songQuery,
    id: el.songId,
    results: el.songResults,
    preview: el.songPreview,
    button: el.songLookup,
    searchRoute: "/api/song/search",
  },
  qq: {
    platform: "qq",
    query: el.qqSongQuery,
    id: el.qqSongId,
    results: el.qqSongResults,
    preview: el.qqSongPreview,
    button: el.qqSongLookup,
    searchRoute: "/api/qq/song/search",
  },
};
for (const search of Object.values(SONG_SEARCHES)) {
  search.generation = 0;
  search.songs = [];
  search.activeIndex = -1;
  search.selectedQuery = "";
}

function taskViewKey(platformValue = platform, modeValue = mode) { return `${platformValue}:${modeValue}`; }
function currentView() {
  const view = TASK_VIEWS[taskViewKey()];
  if (!view) throw new Error(`Unsupported task view: ${taskViewKey()}`);
  return view;
}
function currentForm() { return currentView().form; }
function taskBase(taskMode) { return taskMode === "qq" ? "/api/qq/job" : taskMode === "parallel" ? "/api/parallel/job" : "/api/job"; }

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

function setClassicStatus(node, message, tone) {
  node.textContent = message;
  node.classList.toggle("is-success", tone === "success");
  node.classList.toggle("is-error", tone === "error");
}

function classicIdentityLabel(identityKind) {
  return identityKind === "qq-number-candidate"
    ? "QQ号候选"
    : identityKind === "wxuin-candidate"
    ? "QQ音乐微信内部ID（wxuin候选）"
    : undefined;
}

function cancelClassicVerification() {
  classicVerificationController?.abort();
}

function cancelClassicResolution() {
  classicDecodeController?.abort();
}

function classicResolutionHint(value) {
  const input = String(value || "").trim();
  if (!input) return undefined;
  if (/^\d+$/.test(input)) return "network";
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname !== "y.qq.com") return "local";
    const pathIdentity = url.pathname.match(/^\/n\/ryqq\/profile\/([^/]+)\/?$/)?.[1];
    const queryIdentity = /^\/(?:n\/ryqq_v2\/profile\/?|portal\/profile\.html)$/.test(url.pathname)
      ? url.searchParams.get("uin")
      : undefined;
    return /^\d+$/.test(pathIdentity || queryIdentity || "") ? "network" : "local";
  } catch {
    return "local";
  }
}

function syncClassicDecodeButton() {
  const hint = classicResolutionHint(el.classicInput.value);
  el.classicDecode.textContent = hint === "network"
    ? "联网解析"
    : hint === "local"
    ? "本地提取 / 离线解码"
    : "解析输入";
}

function resetClassicDecodeState() {
  classicDecodeVersion += 1;
  cancelClassicResolution();
  cancelClassicVerification();
  classicDecoded = undefined;
  el.classicDecode.disabled = false;
  el.classicResult.hidden = true;
  el.classicIdentityKind.textContent = "解析结果";
  el.classicMaskedIdentifier.textContent = "-";
  el.classicReveal.textContent = "显示完整标识";
  el.classicReveal.disabled = true;
  el.classicCopy.disabled = true;
  el.classicVerify.disabled = true;
  el.classicVerifyStatus.hidden = true;
  syncClassicDecodeButton();
  setClassicStatus(el.classicDecodeStatus, "输入只会在你点击后处理一次；数字候选需要联网，EncryptUin 或携带它的官方链接只做本地提取。", undefined);
}

function openClassicEncryptUinDialog(button) {
  resetClassicDecodeState();
  el.classicInput.value = "";
  el.classicDialog.dataset.formId = button.closest("form")?.id || "qqSongForm";
  el.classicDialog.showModal();
  el.classicInput.focus();
}

function closeClassicEncryptUinDialog() {
  el.classicDialog.close();
}

async function decodeClassicEncryptUin() {
  const sourceInput = el.classicInput.value.trim();
  if (!el.classicInput.reportValidity()) return undefined;
  const version = ++classicDecodeVersion;
  const resolutionHint = classicResolutionHint(sourceInput);
  cancelClassicResolution();
  const controller = new AbortController();
  classicDecodeController = controller;
  qqLookupControllers.add(controller);
  qqLookupBusy = true;
  syncTaskStartAvailability();
  el.classicDecode.disabled = true;
  setClassicStatus(
    el.classicDecodeStatus,
    resolutionHint === "network"
      ? "正在经当前 QQ 代理配置联网获取 canonical EncryptUin…"
      : "正在本机提取并离线校验受支持格式…",
    undefined,
  );
  const form = document.getElementById(el.classicDialog.dataset.formId) || el.qqSongForm;
  const proxy = form.elements.proxy.value.trim();
  const allowDirect = form.elements.allowDirect.checked;
  try {
    const decoded = await api("/api/qq/encrypt-uin/decode", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ input: sourceInput, proxy, allowDirect }),
    });
    if (controller.signal.aborted || version !== classicDecodeVersion || sourceInput !== el.classicInput.value.trim()) return undefined;
    const identityLabel = classicIdentityLabel(decoded.identityKind);
    if (!identityLabel
      || !["classic-qq-short", "wechat-28"].includes(decoded.format)
      || !["raw-encrypt-uin", "profile-url-encrypt-uin", "numeric-identifier", "profile-url-numeric"].includes(decoded.inputKind)
      || !["local", "network"].includes(decoded.resolution)
      || typeof decoded.encryptUin !== "string"
      || typeof decoded.identifier !== "string"
      || typeof decoded.maskedIdentifier !== "string") {
      throw new Error("本地解析响应格式无效。");
    }
    classicDecoded = {
      sourceInput,
      inputKind: decoded.inputKind,
      resolution: decoded.resolution,
      encryptUin: decoded.encryptUin,
      format: decoded.format,
      identityKind: decoded.identityKind,
      identifier: decoded.identifier,
      maskedIdentifier: decoded.maskedIdentifier,
    };
    el.classicIdentityKind.textContent = identityLabel;
    el.classicMaskedIdentifier.textContent = decoded.maskedIdentifier;
    el.classicIdentifierWarning.textContent = decoded.identityKind === "wxuin-candidate"
      ? "这是 QQ 音乐微信内部ID（wxuin候选），不是微信号，也不能公开转换为微信号。完整值属于个人标识符；只有明确显示或复制后才会进入可见界面或剪贴板。在线验证会把原 EncryptUin 与候选 ID 经当前代理发送到 QQ 官方公开资料接口。"
      : "这是 QQ号候选，不代表账号所有权。完整值属于个人标识符；只有明确显示或复制后才会进入可见界面或剪贴板。在线验证会把原 EncryptUin 与候选 QQ 经当前代理发送到 QQ 官方公开资料接口。";
    el.classicResult.hidden = false;
    el.classicReveal.disabled = false;
    el.classicCopy.disabled = false;
    el.classicVerify.disabled = false;
    const completedStage = decoded.resolution === "network"
      ? "联网解析完成"
      : decoded.inputKind === "profile-url-encrypt-uin" ? "本地提取与离线解码完成" : "本地离线解码完成";
    setClassicStatus(el.classicDecodeStatus, `${completedStage}：${identityLabel} ${decoded.maskedIdentifier}。完整值默认保持隐藏。`, "success");
    return classicDecoded;
  } catch (error) {
    if (controller.signal.aborted || version !== classicDecodeVersion) return undefined;
    classicDecoded = undefined;
    el.classicResult.hidden = true;
    const message = String(error.message || "不支持此格式。");
    setClassicStatus(el.classicDecodeStatus, resolutionHint === "network"
      ? `联网解析失败：${message}`
      : message.includes("不支持") ? message : `格式不支持：${message}`, "error");
    return undefined;
  } finally {
    qqLookupControllers.delete(controller);
    qqLookupBusy = qqLookupControllers.size > 0;
    if (classicDecodeController === controller) classicDecodeController = undefined;
    if (version === classicDecodeVersion) el.classicDecode.disabled = false;
    syncTaskStartAvailability();
  }
}

function toggleClassicIdentifierReveal() {
  if (!classicDecoded || classicDecoded.sourceInput !== el.classicInput.value.trim()) return;
  const revealed = el.classicMaskedIdentifier.textContent === classicDecoded.identifier;
  el.classicMaskedIdentifier.textContent = revealed ? classicDecoded.maskedIdentifier : classicDecoded.identifier;
  el.classicReveal.textContent = revealed ? "显示完整标识" : "隐藏完整标识";
  if (!revealed) setClassicStatus(el.classicDecodeStatus, `已按你的操作显示${classicIdentityLabel(classicDecoded.identityKind)}完整值；请勿公开传播。`, undefined);
}

async function copyClassicIdentifier() {
  if (!classicDecoded || classicDecoded.sourceInput !== el.classicInput.value.trim()) return;
  try {
    await navigator.clipboard.writeText(classicDecoded.identifier);
    toast(`${classicIdentityLabel(classicDecoded.identityKind)}完整值已复制；请妥善处理`);
  } catch {
    setClassicStatus(el.classicDecodeStatus, "复制失败；请先点击“显示完整标识”后手动复制。", "error");
  }
}

async function verifyClassicEncryptUin() {
  const decoded = classicDecoded?.sourceInput === el.classicInput.value.trim()
    ? classicDecoded
    : await decodeClassicEncryptUin();
  if (!decoded) return;

  cancelClassicVerification();
  const controller = new AbortController();
  classicVerificationController = controller;
  qqLookupControllers.add(controller);
  qqLookupBusy = true;
  syncTaskStartAvailability();
  el.classicVerify.disabled = true;
  el.classicVerifyStatus.hidden = false;
  setClassicStatus(el.classicVerifyStatus, "正在通过当前 QQ 代理配置进行官方正向验证…", undefined);
  const form = document.getElementById(el.classicDialog.dataset.formId) || el.qqSongForm;
  const proxy = form.elements.proxy.value.trim();
  const allowDirect = form.elements.allowDirect.checked;
  try {
    const verification = await api("/api/qq/encrypt-uin/verify", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ encryptUin: decoded.encryptUin, proxy, allowDirect }),
    });
    if (controller.signal.aborted
      || decoded.sourceInput !== el.classicInput.value.trim()
      || verification.format !== decoded.format
      || verification.identityKind !== decoded.identityKind
      || verification.maskedIdentifier !== decoded.maskedIdentifier) return;
    if (verification.status === "match") {
      setClassicStatus(el.classicVerifyStatus, "验证匹配：两次官方公开资料响应的 EncryptUin、昵称和头像均一致。", "success");
    } else if (verification.status === "mismatch") {
      const failedChecks = [
        verification.checks?.encryptUin === false ? "EncryptUin" : "",
        verification.checks?.nickname === false ? "昵称" : "",
        verification.checks?.avatar === false ? "头像" : "",
      ].filter(Boolean).join("、");
      setClassicStatus(el.classicVerifyStatus, `验证不匹配：${failedChecks || "公开身份字段"}不一致，请不要把解析结果当作有效映射。`, "error");
    } else throw new Error("在线验证响应格式无效。");
  } catch (error) {
    if (controller.signal.aborted) return;
    setClassicStatus(el.classicVerifyStatus, `网络验证失败：${error.message}`, "error");
  } finally {
    qqLookupControllers.delete(controller);
    qqLookupBusy = qqLookupControllers.size > 0;
    if (classicVerificationController === controller) {
      classicVerificationController = undefined;
      if (decoded.sourceInput === el.classicInput.value.trim()) el.classicVerify.disabled = false;
    }
    syncTaskStartAvailability();
  }
}

function payload(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, ["uid", "songId", "target", "proxy"].includes(key) ? String(value).trim() : Number.isNaN(Number(value)) || value === "" ? value : Number(value)]));
}

async function startParallel() {
  if (document.body.classList.contains("platform-switching")) return;
  if (!ensureSongSelection(SONG_SEARCHES.netease) || !el.parallelForm.reportValidity() || !el.hostConcurrency.reportValidity() || !el.exitLimit.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting" || poolRefreshing) {
    toast("代理池正在验证节点，请等待状态灯变绿并显示“已就绪”后再启动");
    return;
  }
  setBusy(true);
  const requestedView = taskViewKey();
  const requestedModeVersion = modeSwitchVersion;
  try {
    const value = payload(el.parallelForm);
    value.fresh = $("#parallelFresh").checked;
    value.maxProxyLanes = Number(el.exitLimit.value);
    value.hostConcurrency = Number(el.hostConcurrency.value);
    const job = await api("/api/parallel/job", { method: "POST", body: JSON.stringify(value) });
    syncResultGeneration("netease:parallel", generationFromJob("netease:parallel", job));
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "parallel" : undefined;
    activeTaskViewKey = activeTaskMode ? "netease:parallel" : undefined;
    settlementPending["netease:parallel"] = job.id;
    if (requestedView === taskViewKey() && requestedModeVersion === modeSwitchVersion) {
      renderParallel(job);
      syncRuntimeTimer(job);
    } else void refresh();
    setTaskPanelCollapsed(true);
    toast("并行扫描已启动");
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}

async function startSource(dryRun) {
  if (document.body.classList.contains("platform-switching")) return;
  if (!el.sourceForm.reportValidity() || !el.hostConcurrency.reportValidity() || !el.exitLimit.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting" || poolRefreshing) {
    toast("代理池正在验证节点，请等待状态灯变绿并显示“已就绪”后再启动");
    return;
  }
  setBusy(true);
  const requestedView = taskViewKey();
  const requestedModeVersion = modeSwitchVersion;
  try {
    const value = payload(el.sourceForm);
    value.maxCommentPagesPerSong = value.maxPages; delete value.maxPages;
    value.fresh = $("#fresh").checked; value.dryRun = dryRun;
    value.allowDirect = el.sourceForm.elements.allowDirect.checked;
    value.maxProxyLanes = Number(el.exitLimit.value);
    value.hostConcurrency = Number(el.hostConcurrency.value);
    const job = await api("/api/job", { method: "POST", body: JSON.stringify(value) });
    syncResultGeneration("netease:source", generationFromJob("netease:source", job));
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "source" : undefined;
    activeTaskViewKey = activeTaskMode ? "netease:source" : undefined;
    settlementPending["netease:source"] = job.id;
    if (requestedView === taskViewKey() && requestedModeVersion === modeSwitchVersion) {
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

async function startQQ(qqMode) {
  if (document.body.classList.contains("platform-switching")) return;
  if (startSubmissionBusy) return;
  const viewKey = `qq:${qqMode}`;
  const form = TASK_VIEWS[viewKey].form;
  if ((qqMode === "song" && !ensureSongSelection(SONG_SEARCHES.qq)) || !form.reportValidity() || !el.hostConcurrency.reportValidity() || !el.exitLimit.reportValidity()) return;
  if (poolChangeInFlight || poolStatus === "starting" || poolRefreshing) {
    toast("代理池正在验证节点，请等待状态灯变绿并显示“已就绪”后再启动");
    return;
  }
  setBusy(true);
  const requestedView = taskViewKey();
  const requestedModeVersion = modeSwitchVersion;
  try {
    const value = payload(form);
    value.mode = qqMode;
    value.maxCommentPagesPerSong = value.maxPages;
    delete value.maxPages;
    delete value.workersPerProxy;
    value.fresh = $(qqMode === "song" ? "#qqSongFresh" : "#qqLikesFresh").checked;
    value.allowDirect = form.elements.allowDirect.checked;
    value.maxProxyLanes = Number(el.exitLimit.value);
    value.hostConcurrency = Number(el.hostConcurrency.value);
    const job = await api("/api/qq/job", { method: "POST", body: JSON.stringify(value) });
    localRequestedTargets[viewKey] = { jobId: String(job.id || ""), value: String(value.target || "") };
    const generation = generationFromJob(viewKey, job);
    syncResultGeneration(viewKey, generation);
    activeTaskMode = ["running", "stopping"].includes(job.status) ? "qq" : undefined;
    activeTaskViewKey = activeTaskMode ? viewKey : undefined;
    settlementPending[viewKey] = job.id;
    latestJobs[viewKey] = job;
    if (requestedView === taskViewKey() && requestedModeVersion === modeSwitchVersion) {
      renderQQ(job);
      syncRuntimeTimer(job);
    } else void refresh();
    setTaskPanelCollapsed(true);
    toast(qqMode === "song" ? "QQ 音乐单曲扫描已启动" : "QQ 音乐喜欢歌曲扫描已启动");
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}

function songLabel(song) {
  const artists = Array.isArray(song.artists) ? song.artists.filter(Boolean).join(" / ") : "";
  return [song.name || "未命名歌曲", artists, song.album].filter(Boolean).join(" · ");
}

function clearSongResults(search) {
  search.songs = [];
  search.activeIndex = -1;
  search.results.replaceChildren();
  search.results.hidden = true;
  search.query.setAttribute("aria-expanded", "false");
  search.query.removeAttribute("aria-activedescendant");
}

function cancelSongLookup(search) {
  clearTimeout(search?.timer);
  if (!search) return;
  search.timer = undefined;
  search.generation += 1;
  const controller = search.controller;
  search.controller = undefined;
  controller?.abort();
  clearSongResults(search);
  search.button.disabled = false;
}

function renderSongResults(search, songs) {
  search.songs = songs;
  search.activeIndex = -1;
  search.results.replaceChildren();
  if (songs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "song-search-empty";
    empty.textContent = "没有找到匹配歌曲，可尝试更完整的歌名或歌手。";
    search.results.append(empty);
  } else {
    songs.forEach((song, index) => {
      const option = document.createElement("button");
      option.id = `${search.platform}-song-option-${search.generation}-${index}`;
      option.className = "song-search-option";
      option.type = "button";
      option.setAttribute("role", "option");
      const title = document.createElement("strong");
      title.textContent = song.name || "未命名歌曲";
      const detail = document.createElement("span");
      detail.textContent = [Array.isArray(song.artists) ? song.artists.filter(Boolean).join(" / ") : "", song.album].filter(Boolean).join(" · ") || "未提供歌手信息";
      const id = document.createElement("small");
      id.textContent = `ID ${song.id}`;
      option.append(title, detail, id);
      option.addEventListener("click", () => selectSongResult(search, index));
      search.results.append(option);
    });
  }
  search.results.hidden = false;
  search.query.setAttribute("aria-expanded", "true");
}

function selectSongResult(search, index) {
  const song = search.songs[index];
  if (!song) return;
  search.query.value = song.name || String(song.id);
  search.id.value = String(song.id);
  search.selectedQuery = search.query.value.trim();
  search.query.setCustomValidity("");
  search.preview.textContent = `${songLabel(song)} · ID ${song.id}`;
  search.preview.hidden = false;
  clearSongResults(search);
  syncToolbarContext();
}

function setActiveSongOption(search, index) {
  if (search.songs.length === 0) return;
  search.activeIndex = (index + search.songs.length) % search.songs.length;
  const options = [...search.results.querySelectorAll(".song-search-option")];
  options.forEach((option, optionIndex) => option.classList.toggle("is-active", optionIndex === search.activeIndex));
  const active = options[search.activeIndex];
  if (active) {
    search.query.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
}

function songSearchParams(search, key, value) {
  const params = new URLSearchParams({ [key]: value });
  if (search.platform === "qq") {
    const proxy = el.qqSongForm.elements.proxy.value.trim();
    if (proxy) params.set("proxy", proxy);
    if (el.qqSongForm.elements.allowDirect.checked) params.set("allowDirect", "1");
  }
  return params;
}

async function runSongSearch(search, userInitiated = false) {
  const query = search.query.value.trim();
  const numeric = /^\d+$/.test(query);
  if (!numeric && (query.length < 2 || query.length > 80)) {
    clearSongResults(search);
    if (userInitiated) {
      search.query.setCustomValidity("请输入 2–80 个字符的歌名或歌手，或粘贴纯数字歌曲 ID。");
      search.query.reportValidity();
    }
    return;
  }
  search.query.setCustomValidity("");
  search.controller?.abort();
  const controller = new AbortController();
  search.controller = controller;
  const generation = ++search.generation;
  search.button.disabled = true;
  if (search.platform === "qq") {
    qqLookupControllers.add(controller);
    qqLookupBusy = true;
    syncTaskStartAvailability();
  }
  try {
    if (numeric) {
      search.id.value = query;
      search.selectedQuery = query;
      const route = search.platform === "qq" ? "/api/qq/song" : "/api/song";
      const song = await api(`${route}?${songSearchParams(search, "id", query)}`, { signal: controller.signal });
      if (generation !== search.generation || query !== search.query.value.trim()) return;
      search.preview.textContent = `${songLabel(song)} · ID ${song.id || query}`;
      search.preview.hidden = false;
      clearSongResults(search);
      return;
    }
    const response = await api(`${search.searchRoute}?${songSearchParams(search, "q", query)}`, { signal: controller.signal });
    if (generation !== search.generation || query !== search.query.value.trim()) return;
    const songs = Array.isArray(response.songs)
      ? response.songs.filter((song) => song && /^\d+$/.test(String(song.id))).slice(0, 10)
      : [];
    renderSongResults(search, songs);
  } catch (error) {
    if (controller.signal.aborted || generation !== search.generation) return;
    if (numeric) {
      search.preview.textContent = `数字 ID ${query} · 未能获取歌曲信息，仍可按 ID 启动`;
      search.preview.hidden = false;
    } else {
      clearSongResults(search);
    }
    if (userInitiated) toast(error.message);
  } finally {
    if (search.controller === controller) search.controller = undefined;
    if (generation === search.generation) search.button.disabled = false;
    if (search.platform === "qq") {
      qqLookupControllers.delete(controller);
      qqLookupBusy = qqLookupControllers.size > 0;
      syncTaskStartAvailability();
    }
  }
}

function handleSongQueryInput(search) {
  clearTimeout(search.timer);
  search.controller?.abort();
  search.generation += 1;
  clearSongResults(search);
  const query = search.query.value.trim();
  const numeric = /^\d+$/.test(query);
  search.id.value = numeric ? query : "";
  search.selectedQuery = numeric ? query : "";
  search.query.setCustomValidity("");
  search.preview.hidden = true;
  if (numeric) {
    search.preview.textContent = `数字 ID ${query} · 正在确认歌曲信息…`;
    search.preview.hidden = false;
    search.timer = setTimeout(() => void runSongSearch(search), 320);
  } else if (query.length >= 2 && query.length <= 80) {
    search.timer = setTimeout(() => void runSongSearch(search), 320);
  }
}

function ensureSongSelection(search) {
  const query = search.query.value.trim();
  if (/^\d+$/.test(query)) {
    search.id.value = query;
    search.selectedQuery = query;
  }
  const valid = /^\d+$/.test(search.id.value) && search.selectedQuery === query;
  search.query.setCustomValidity(valid ? "" : "请从候选列表选择歌曲，或输入纯数字歌曲 ID。");
  if (!valid) search.query.reportValidity();
  return valid;
}

function restoreSongSearchSelection(search) {
  const id = search.id.value.trim();
  if (!/^\d+$/.test(id)) return;
  search.query.value = id;
  search.selectedQuery = id;
  search.preview.textContent = `已恢复歌曲 ID ${id}`;
  search.preview.hidden = false;
}

function setupSongSearch(search) {
  search.query.removeAttribute("minlength");
  search.query.setAttribute("role", "combobox");
  search.query.setAttribute("aria-haspopup", "listbox");
  search.query.setAttribute("aria-expanded", "false");
  search.query.addEventListener("input", () => handleSongQueryInput(search));
  search.query.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearSongResults(search);
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && !search.results.hidden && search.songs.length > 0) {
      event.preventDefault();
      setActiveSongOption(search, search.activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" && !search.results.hidden && search.activeIndex >= 0) {
      event.preventDefault();
      selectSongResult(search, search.activeIndex);
      return;
    }
    if (event.key === "Enter" && !/^\d+$/.test(search.query.value.trim())) {
      event.preventDefault();
      void runSongSearch(search, true);
    }
  });
  search.button.addEventListener("click", () => void runSongSearch(search, true));
}

function openParameterHelp(key) {
  const content = PARAMETER_HELP[key];
  if (!content) return;
  el.parameterHelpTitle.textContent = content[0];
  el.parameterHelpDescription.textContent = content[1];
  el.parameterHelpDialog.showModal();
}

async function lookupUser() {
  if (!el.uid.reportValidity()) return;
  el.lookup.disabled = true;
  try {
    const result = await api(`/api/user?uid=${encodeURIComponent(el.uid.value.trim())}`);
    el.userNickname.textContent = result.profile.nickname;
    const probeRoute = result.route === "managed-pool"
      ? `代理池 ${result.routeName || "节点"}${Number(result.routeAttempts) > 1 ? `（第 ${fmt(result.routeAttempts)} 个出口成功）` : ""}`
      : result.route === "explicit-proxy" ? "手动代理" : "本机直连";
    el.userMeta.textContent = [`UID ${result.profile.userId}`, result.profile.level === undefined ? null : `Lv.${result.profile.level}`, probeRoute, `${fmt(result.elapsedMs)}ms`].filter(Boolean).join(" · ");
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
    toast(stopping ? "代理池已停止" : nextPool.managementNotice || "已选出可用的最优出口");
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
    const [parallelJob, sourceJob, qqJob, pool] = await Promise.all([api("/api/parallel/job"), api("/api/job"), api("/api/qq/job"), api("/api/pool")]);
    const qqViewKey = ["song", "likes"].includes(qqJob.mode) ? `qq:${qqJob.mode}` : undefined;
    if (qqViewKey) {
      invalidateQQSibling(qqViewKey, qqJob.id);
      latestJobs[qqViewKey] = qqJob;
      syncResultGeneration(qqViewKey, generationFromJob(qqViewKey, qqJob));
    }
    activeTaskMode = ["running", "stopping"].includes(parallelJob.status)
      ? "parallel"
      : ["running", "stopping"].includes(sourceJob.status)
      ? "source"
      : ["running", "stopping"].includes(qqJob.status)
      ? "qq"
      : undefined;
    activeTaskViewKey = activeTaskMode === "parallel"
      ? "netease:parallel"
      : activeTaskMode === "source"
      ? "netease:source"
      : activeTaskMode === "qq"
      ? qqViewKey
      : undefined;
    if (nativeUpdateState?.phase === "downloaded") {
      setNativeUpdateAction(activeTaskMode || startSubmissionBusy || qqLookupBusy ? "保存进度并重启" : "重启并安装");
    }
    observeTaskSettlement(parallelJob, "netease:parallel");
    observeTaskSettlement(sourceJob, "netease:source");
    if (qqViewKey) observeTaskSettlement(qqJob, qqViewKey);
    const currentKey = taskViewKey();
    const job = currentKey === "netease:parallel"
      ? parallelJob
      : currentKey === "netease:source"
      ? sourceJob
      : latestJobs[currentKey] ?? emptyQQSnapshot(mode);
    currentKey === "netease:parallel"
      ? renderParallel(job)
      : currentKey === "netease:source"
      ? renderSource(job)
      : renderQQ(job);
    const activeJob = activeTaskMode === "parallel"
      ? parallelJob
      : activeTaskMode === "source"
      ? sourceJob
      : activeTaskMode === "qq"
      ? qqJob
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
    if ($('.tab.active')?.dataset.tab === "estimate") scheduleEstimateRefresh(80);
  } catch (error) {
    el.connection.classList.remove("ready"); toast(error.message);
  }
}

function renderParallel(job) {
  const viewKey = "netease:parallel";
  latestJobs[viewKey] = job;
  syncResultGeneration(viewKey, generationFromJob(viewKey, job));
  if (viewKey !== taskViewKey() || !shouldRenderJob(viewKey, job)) return;
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
    job.songId ? `${fmt(job.lanes || 1)} 出口 · ${fmt(job.workers || 1)} 工作线程${transportConcurrencyText(job)}` : "等待任务调度",
    job.workers,
  );
  el.stop.disabled = !active;
  syncTaskStartAvailability();
}

function renderSource(job) {
  const viewKey = "netease:source";
  latestJobs[viewKey] = job;
  syncResultGeneration(viewKey, generationFromJob(viewKey, job));
  if (viewKey !== taskViewKey() || !shouldRenderJob(viewKey, job)) return;
  const active = ["running", "stopping"].includes(job.status);
  el.taskTitle.textContent = job.uid ? `UID ${job.uid} · ${sourceName(job.source)}` : "等待来源任务";
  el.status.textContent = statusLabels[job.status] || job.status; el.progressLabel.textContent = "歌曲进度"; el.progress.textContent = `${fmt(job.songsProcessed)} / ${fmt(job.songs)}`;
  el.workLabel.textContent = "已读评论"; el.work.textContent = fmt(job.commentsInspected); el.speed.textContent = formatRate(job.commentsPerSecond); el.matches.textContent = fmt(job.matches); el.requests.textContent = fmt(job.requestsTotal);
  const globalPercent = job.songs ? Math.min(100, Math.round(job.songsProcessed / job.songs * 100)) : 0;
  const topology = `${fmt(job.lanes || 1)} 个出口 · ${fmt(job.workers || 1)} 个工作线程${transportConcurrencyText(job)}`;
  renderProgress({
    globalPercent,
    globalContext: job.uid
      ? `${fmt(job.songsProcessed)} / ${fmt(job.songs)} 首歌曲 · ${topology}`
      : "尚未开始",
    note: [sourceCoverageSummary(job), job.note, job.error, ...(job.sourceErrors || []), topologyCapacityNote(job)].filter(Boolean).join(" · "),
  });
  renderActiveSongs(
    active ? job.activeSongs || [] : [],
    job.uid ? `${topology.replaceAll(" 个", " ")}` : "等待任务调度",
    job.workers,
  );
  el.stop.disabled = !active;
  syncTaskStartAvailability();
}

function renderQQ(job) {
  const viewKey = job?.mode === "likes" ? "qq:likes" : "qq:song";
  if (job?.id) invalidateQQSibling(viewKey, job.id);
  latestJobs[viewKey] = job;
  syncResultGeneration(viewKey, generationFromJob(viewKey, job));
  if (viewKey !== taskViewKey() || !shouldRenderJob(viewKey, job)) return;
  const active = ["running", "stopping"].includes(job.status);
  const target = job.targetLabel || "QQ 目标";
  const songs = Math.max(0, Number(job.songs || 0));
  const songsProcessed = Math.max(0, Number(job.songsProcessed ?? job.songsComplete ?? 0));
  const globalPercent = songs > 0 ? Math.min(100, Math.round(songsProcessed / songs * 100)) : 0;
  const configuredWorkers = Number(job.configuredWorkers || (job.mode === "song" ? 1 : 0));
  const hostWorkerLimit = Math.max(1, Number(job.hostConcurrency || el.hostConcurrency.value || 8));
  const topology = job.mode === "song"
    ? `${fmt(job.configuredLanes || 1)} 个可轮转出口 · SeqNo 协议链 1 在途 · 主机线程上限 ${fmt(hostWorkerLimit)}`
    : `${fmt(job.configuredLanes || 1)} 个配置出口 · 主机线程上限 ${fmt(hostWorkerLimit)} · 可调度 ${fmt(configuredWorkers)} 个工作线程`;
  el.taskTitle.textContent = !job.id
    ? job.mode === "song" ? "等待 QQ 单曲任务" : "等待 QQ 喜欢歌曲任务"
    : job.mode === "song"
    ? `${job.songName || `QQ 歌曲 ${job.songId || "-"}`} · ${target}`
    : `${target} · 公开喜欢歌曲`;
  el.status.textContent = statusLabels[job.status] || job.status;
  el.progressLabel.textContent = "歌曲进度";
  el.progress.textContent = `${fmt(songsProcessed)} / ${fmt(songs)}`;
  el.workLabel.textContent = "已读评论";
  el.work.textContent = fmt(job.commentsInspected);
  el.speed.textContent = formatRate(job.commentsPerSecond);
  el.matches.textContent = fmt(job.matches);
  el.requests.textContent = fmt(job.requestsTotal);
  renderProgress({
    globalPercent,
    globalContext: job.id ? `${fmt(songsProcessed)} / ${fmt(songs)} 首歌曲 · ${topology}` : "尚未开始",
    note: [job.note, job.error, job.id && job.coverageComplete === false && !active ? "本次覆盖不完整，请查看日志和检查点。" : ""].filter(Boolean).join(" · "),
  });
  renderActiveSongs(
    active ? job.activeSongs || [] : [],
    job.id ? `${topology} · 本轮已参与 ${fmt(job.participatedLanes)} 出口 / ${fmt(job.participatedWorkers)} 工作线程 · 峰值在途 ${fmt(job.peakInFlight)}` : "等待任务调度",
    configuredWorkers,
  );
  el.stop.disabled = !active;
  syncTaskStartAvailability();
}

function invalidateQQSibling(viewKey, activeJobId) {
  const sibling = viewKey === "qq:song" ? "qq:likes" : "qq:song";
  const siblingJobId = resultGenerations[sibling]?.jobId ?? latestJobs[sibling]?.id;
  if (!siblingJobId || siblingJobId === String(activeJobId || "")) return;
  latestJobs[sibling] = undefined;
  localRequestedTargets[sibling] = undefined;
  settlementPending[sibling] = undefined;
  syncResultGeneration(sibling, undefined);
}

function emptyQQSnapshot(qqMode) {
  return {
    platform: "qq", mode: qqMode, status: "idle", songs: 0, songsProcessed: 0,
    activeSongs: [], pagesProcessed: 0, commentsInspected: 0, matches: 0,
    requestsTotal: 0, commentsPerSecond: 0, configuredLanes: 0,
    configuredWorkers: 0, participatedLanes: 0, participatedWorkers: 0,
    peakInFlight: 0, coverageComplete: false,
  };
}

function shouldRenderJob(viewKey, job) {
  const { elapsedMs: _elapsedMs, ...view } = job;
  const signature = JSON.stringify([viewKey, view]);
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

function sourceCoverageSummary(job) {
  if (!job?.uid) return "";
  return `目录总数 ${fmt(job.catalogSongs ?? job.songs)} · 历史已完成 ${fmt(job.historicalCompletedSongs)} · 已复用/跳过 ${fmt(job.reusedSongs)} · 新增待扫 ${fmt(job.newPendingSongs)}`;
}

function renderActiveSongs(songs, summary, configuredWorkers = 0) {
  const normalized = songs.map((song) => ({
    id: String(song.id || ""),
    name: String(song.name || ""),
    workers: Math.max(0, Number(song.workers || 0)),
    pagesProcessed: finiteNumber(song.pagesProcessed),
    requestingPage: finiteNumber(song.requestingPage),
    requestStartedAt: song.requestStartedAt == null ? undefined : finiteNumber(song.requestStartedAt),
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
  el.activeWorkerCount.textContent = `${fmt(activeWorkers)} / ${fmt(workerCapacity)} 工作线程活跃`;
  el.activeSongSummary.textContent = summary;
  if (normalized.length === 0) {
    activeSongRows.clear();
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "暂无正在扫描的歌曲";
    row.append(cell);
    if (!el.activeSongsList.querySelector(".empty-row")) el.activeSongsList.replaceChildren(row);
    return;
  }
  el.activeSongsList.querySelector(".empty-row")?.remove();
  const visibleIds = new Set(normalized.map((song) => song.id));
  for (const [songId, entry] of activeSongRows) {
    if (visibleIds.has(songId)) continue;
    entry.row.remove();
    activeSongRows.delete(songId);
  }
  for (const song of normalized) {
    let entry = activeSongRows.get(song.id);
    if (!entry) {
      entry = createActiveSongRow();
      activeSongRows.set(song.id, entry);
      el.activeSongsList.append(entry.row);
    }
    updateActiveSongRow(entry, song);
  }
}

function createActiveSongRow() {
    const row = document.createElement("tr");
    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "activity-status";
    status.append(badge);
    const name = document.createElement("td");
    const id = document.createElement("td");
    const progress = document.createElement("td");
    progress.className = "song-read-progress";
    const progressLabel = document.createElement("span");
    const progressTrack = document.createElement("span");
    progressTrack.className = "song-read-track";
    const progressFill = document.createElement("i");
    progressTrack.append(progressFill);
    progress.append(progressLabel, progressTrack);
    const workers = document.createElement("td");
    workers.className = "activity-worker-count";
    row.append(status, name, id, progress, workers);
    return { row, badge, name, id, progress, progressLabel, progressTrack, progressFill, workers };
}

function updateActiveSongRow(entry, song) {
  entry.song = song;
  entry.badge.textContent = song.workers > 0 ? "扫描中" : "等待调度";
  entry.badge.classList.toggle("is-waiting", song.workers === 0);
  entry.name.textContent = song.name || "正在读取歌曲名称";
  entry.id.textContent = song.id;
  entry.workers.textContent = `${fmt(song.workers)} 工作线程`;
  renderSongReadProgress(song, entry);
}

function renderSongReadProgress(song, entry) {
  const comments = Math.max(0, song.commentsProcessed ?? 0);
  const total = song.totalComments !== undefined && song.totalComments > 0
    ? Math.max(comments, song.totalComments)
    : undefined;
  const measuredPercent = total ? comments / total * 100 : undefined;
  const percent = Math.max(0, Math.min(100, song.progressPercent ?? measuredPercent ?? 0));
  const activeRequest = song.workers > 0
    ? ` · ${fmt(song.workers)} 个分片请求中${song.requestStartedAt !== undefined
      ? ` · 最长 ${duration(Math.max(0, Math.floor((Date.now() - song.requestStartedAt) / 1_000)))}`
      : ""}`
    : "";
  const completedPages = song.pagesProcessed !== undefined && song.pagesProcessed > 0
    ? ` · 已完成 ${fmt(song.pagesProcessed)} 页`
    : "";
  const coverage = percent > 0 && percent < 1 ? "<1" : String(Math.round(percent));
  const label = song.progressBasis === "time" && song.progressPercent !== undefined
    ? `已读 ${fmt(comments)} 条 · 时间覆盖 ${coverage}%${completedPages}${activeRequest}`
    : total
    ? `已读 ${fmt(comments)} / ${fmt(total)} 条 · ${coverage}%${completedPages}${activeRequest}`
    : song.pagesProcessed !== undefined && song.pagesProcessed > 0
    ? `已读 ${fmt(comments)} 条${completedPages}${activeRequest}`
    : song.requestingPage !== undefined
    ? `正在请求第 ${fmt(song.requestingPage)} 页${activeRequest}`
    : song.workers > 0
    ? `正在请求首批评论分片${activeRequest}`
    : song.pagesProcessed !== undefined
    ? `已读 ${fmt(comments)} 条 · 已完成 ${fmt(song.pagesProcessed)} 页`
    : "等待首个评论页";
  entry.progressLabel.textContent = label;
  entry.progressTrack.classList.toggle("is-unknown", song.progressPercent === undefined && measuredPercent === undefined);
  entry.progressFill.style.width = `${percent}%`;
  entry.progress.setAttribute("aria-label", label);
}

function refreshActiveSongRequestAges() {
  for (const entry of activeSongRows.values()) {
    if (entry.song?.workers > 0) renderSongReadProgress(entry.song, entry);
  }
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

function observeTaskSettlement(job, viewKey) {
  if (!job.id) return;
  if (["running", "stopping"].includes(job.status)) {
    settlementPending[viewKey] = job.id;
    return;
  }
  if (job.status === "idle" || settlementPending[viewKey] !== job.id) return;
  settlementPending[viewKey] = undefined;
  renderSettlement(job, viewKey);
}

function renderSettlement(job, viewKey) {
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
  el.settlementDialog.dataset.view = viewKey;
  el.settlementTitle.textContent = titles[job.status] || "任务已结束";
  el.settlementStatus.textContent = statusLabels[job.status] || job.status;
  el.settlementContext.textContent = viewKey === "netease:parallel"
    ? `${job.songName || `歌曲 ${job.songId || "-"}`} · UID ${job.uid || "-"}`
    : viewKey === "netease:source"
    ? `UID ${job.uid || "-"} · ${sourceName(job.source)}`
    : viewKey === "qq:song"
    ? `${job.songName || `QQ 歌曲 ${job.songId || "-"}`} · ${job.targetLabel || "QQ 目标"}`
    : `${job.targetLabel || "QQ 目标"} · 公开喜欢歌曲`;
  el.settlementElapsed.textContent = duration(Math.round(Number(job.elapsedMs || 0) / 1000));
  el.settlementMatches.textContent = fmt(job.matches);
  el.settlementPages.textContent = fmt(job.pagesProcessed);
  el.settlementRequests.textContent = fmt(job.requestsTotal);
  el.settlementCoverage.hidden = viewKey !== "netease:source" && job.coverageComplete !== false;
  el.settlementCoverage.textContent = viewKey === "netease:source"
    ? sourceCoverageSummary(job)
    : job.coverageComplete === false ? "任务未达到完整覆盖，已保留检查点与已保存结果。" : "";
  el.settlementNote.textContent = [job.note, job.error, ...(job.sourceErrors || []), defaults[job.status]].filter(Boolean).join(" · ");
  el.settlementLogPath.textContent = job.logPath || "未生成日志文件";
  el.settlementFootnote.textContent = viewKey.startsWith("qq:")
    ? "命中指标按当前 QQ 检查点累计；结果页按歌曲 ID + 评论 ID 展示已经持久化的累计去重结果；耗时只统计本次任务。"
    : "命中指标按当前检查点累计；结果页按 UID 展示 target-v3 已保存的累计去重结果；耗时只统计本次任务。";
  if (!el.settlementDialog.open) el.settlementDialog.showModal();
}

function openTaskTab(tabName) {
  setTaskPanelCollapsed(true);
  const tab = $(`.tab[data-tab="${tabName}"]`);
  const alreadyActive = Boolean(tab?.classList.contains("active"));
  if (tab && !alreadyActive) tab.click();
  panelForTab(tabName)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  return alreadyActive;
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
  } else if (pool.status === "running" && pool.managementNotice) {
    state = "is-degraded";
    text = `${pool.entries.length} 个出口 · 新代已接管`;
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

function generationFromJob(viewKey, job) {
  if (!job?.id) return undefined;
  const view = TASK_VIEWS[viewKey];
  if (!view) return undefined;
  if (view.platform === "netease") {
    const uid = String(job.uid || "");
    return /^\d+$/.test(uid)
      ? { platform: "netease", mode: view.mode, jobId: String(job.id), target: { kind: "uid", value: uid } }
      : undefined;
  }
  const raw = job.generation;
  const targetValue = typeof raw?.target === "object"
    ? raw.target.value
    : raw?.canonicalTarget;
  if (raw?.platform !== "qq" || raw.mode !== view.mode || raw.target?.kind !== "encryptUin" || String(raw.jobId || "") !== String(job.id)
    || typeof targetValue !== "string" || !targetValue || targetValue.length > 512) return undefined;
  return {
    platform: "qq",
    mode: view.mode,
    jobId: String(job.id),
    target: { kind: "encryptUin", value: targetValue },
  };
}

function generationFromEnvelope(value) {
  const raw = value?.generation;
  if (!raw || !TASK_VIEWS[`${raw.platform}:${raw.mode}`]) return undefined;
  const target = raw.target;
  if (!target || typeof target.value !== "string") return undefined;
  return {
    platform: raw.platform,
    mode: raw.mode,
    jobId: String(raw.jobId || ""),
    target: { kind: target.kind, value: target.value },
  };
}

function sameGeneration(left, right) {
  if (!left && !right) return true;
  return Boolean(left && right)
    && left.platform === right.platform
    && left.mode === right.mode
    && left.jobId === right.jobId
    && left.target?.kind === right.target?.kind
    && left.target?.value === right.target?.value;
}

function syncResultGeneration(viewKey, generation) {
  const previous = resultGenerations[viewKey];
  resultGenerations[viewKey] = generation;
  syncResultExportAvailability();
  if (sameGeneration(previous, generation)) return;
  resultGenerationRevisions[viewKey] += 1;
  if (viewKey !== taskViewKey()) return;
  knownMatches = -1;
  resetVisibleResults();
  connectResultStream();
}

async function refreshResults() {
  const request = ++resultRequest;
  const requestedView = taskViewKey();
  const expectedGeneration = resultGenerations[requestedView];
  if (!expectedGeneration?.jobId) {
    if (resultView !== requestedView) resetVisibleResults(false);
    resultsNeedRefresh = false;
    return;
  }
  const baselineIds = new Set(visibleResultOrder);
  try {
    const view = TASK_VIEWS[requestedView];
    const params = new URLSearchParams({ limit: "50" });
    if (view.platform === "qq") params.set("jobId", expectedGeneration.jobId);
    const data = await api(`${view.resultsBase}?${params}`);
    if (request !== resultRequest || requestedView !== taskViewKey()
      || !sameGeneration(expectedGeneration, resultGenerations[requestedView])) return;
    if (view.platform === "qq") {
      if (!sameGeneration(expectedGeneration, generationFromEnvelope(data))) return;
    } else if (String(data.jobId || "") !== expectedGeneration.jobId) return;
    if (resultView !== requestedView) resetVisibleResults(false);
    const mergedResults = new Map(visibleResults);
    const snapshotOrder = [];
    data.results.forEach((item) => {
      const id = resultKey(item, requestedView);
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
    if (request === resultRequest && requestedView === taskViewKey()
      && sameGeneration(expectedGeneration, resultGenerations[requestedView])) toast(error.message);
  }
}

function refreshLogs(force = true) {
  if (!force && Date.now() - lastLogsRefreshAt < 3_000) return Promise.resolve();
  const requestedView = taskViewKey();
  const expectedGeneration = resultGenerations[requestedView];
  if (logsRefreshInFlight && logsRefreshView === requestedView) return logsRefreshInFlight;
  lastLogsRefreshAt = Date.now();
  const request = ++logsRequest;
  const pending = performLogsRefresh(request, requestedView, expectedGeneration).finally(() => {
    if (logsRefreshInFlight === pending) {
      logsRefreshInFlight = undefined;
      logsRefreshView = undefined;
    }
  });
  logsRefreshInFlight = pending;
  logsRefreshView = requestedView;
  return pending;
}

async function performLogsRefresh(request, requestedView, expectedGeneration) {
  try {
    const view = TASK_VIEWS[requestedView];
    const params = new URLSearchParams({ mode: view.taskMode, limit: "200" });
    if (view.platform === "qq") {
      if (!expectedGeneration?.jobId) {
        if (request === logsRequest && requestedView === taskViewKey()) resetVisibleLogs();
        return;
      }
      params.set("jobId", expectedGeneration.jobId);
    }
    const data = await api(`/api/logs?${params}`);
    if (request !== logsRequest || requestedView !== taskViewKey()
      || !sameGeneration(expectedGeneration, resultGenerations[requestedView])) return;
    if (view.platform === "qq" && !sameGeneration(expectedGeneration, generationFromEnvelope(data))) return;
    const signature = JSON.stringify([requestedView, expectedGeneration?.jobId, data.path, data.entries]);
    if (signature === logsSignature) return;
    logsSignature = signature;
    el.logPath.textContent = data.path || "任务启动后将在本地生成结构化日志。";
    el.logs.replaceChildren(...(data.entries.length ? data.entries.map(logRow) : [emptyLogRow()]));
  } catch (error) {
    if (request === logsRequest && requestedView === taskViewKey()
      && sameGeneration(expectedGeneration, resultGenerations[requestedView])) toast(`读取日志失败：${error.message}`);
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
  resultStream = undefined;
  if (pageLifecycleSuspended) return;
  const streamView = taskViewKey();
  const view = TASK_VIEWS[streamView];
  const expectedGeneration = resultGenerations[streamView];
  if (!expectedGeneration?.jobId) return;
  const params = new URLSearchParams();
  if (view.platform === "qq") params.set("jobId", expectedGeneration.jobId);
  const path = `${view.resultsBase}/stream${params.size ? `?${params}` : ""}`;
  const stream = new EventSource(path);
  stream.addEventListener("match", (event) => {
    if (taskViewKey() !== streamView || resultStream !== stream
      || !sameGeneration(expectedGeneration, resultGenerations[streamView])) return;
    try {
      const parsed = JSON.parse(event.data);
      const item = view.platform === "qq" ? parsed.comment : parsed;
      if (view.platform === "qq" && !sameGeneration(expectedGeneration, generationFromEnvelope(parsed))) return;
      if (!item) return;
      if (resultView !== streamView) resetVisibleResults();
      const id = resultKey(item, streamView);
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
  resultView = taskViewKey();
  visibleResults.clear();
  visibleResultOrder = [];
  pendingLiveCommentId = undefined;
  resultsRenderPending = false;
  resultsNeedRefresh = true;
  clearTimeout(resultRenderTimer);
  resultRenderTimer = undefined;
  renderResults();
}

function syncResultExportAvailability() {
  const current = resultGenerations[taskViewKey()];
  el.exportResults.disabled = resultExportInProgress || !validExportGeneration(current);
}

async function exportCurrentResults() {
  const exportView = taskViewKey();
  const current = resultGenerations[exportView];
  if (!validExportGeneration(current) || resultExportInProgress) return;
  const request = {
    platform: current.platform,
    mode: current.mode,
    jobId: current.jobId,
    target: { ...current.target },
  };
  resultExportInProgress = true;
  syncResultExportAvailability();
  el.exportResults.setAttribute("aria-busy", "true");
  el.exportResults.querySelector("span").textContent = "正在生成…";
  let removeProgressListener;
  try {
    if (typeof window.ncmDesktop?.exportResultsPdf === "function") {
      if (typeof window.ncmDesktop.onResultsPdfProgress === "function") {
        const labels = {
          "save-dialog": "选择位置…",
          "load-report": "读取结果…",
          fonts: "准备排版…",
          print: "生成 PDF…",
          write: "写入文件…",
        };
        removeProgressListener = window.ncmDesktop.onResultsPdfProgress((progress) => {
          const label = labels[progress?.stage];
          if (label) el.exportResults.querySelector("span").textContent = label;
        });
      }
      const result = await window.ncmDesktop.exportResultsPdf(request);
      if (result?.status === "saved") toast(`PDF 已导出：${shortPath(result.path)}`);
      else if (result?.status === "cancelled") toast("已取消 PDF 导出。");
      else if (result?.status === "failed") {
        const suffix = result.logAvailable ? " 诊断已写入 desktop.log。" : "";
        toast(`${result.message || "PDF 导出失败，请重试。"}${suffix}`);
      }
    } else {
      const report = new URL("/report/results", location.origin);
      report.searchParams.set("platform", request.platform);
      report.searchParams.set("mode", request.mode);
      report.searchParams.set("jobId", request.jobId);
      report.searchParams.set("targetKind", request.target.kind);
      report.searchParams.set("target", request.target.value);
      const opened = window.open(report.toString(), "_blank", "noopener");
      if (!opened) throw new Error("浏览器阻止了报告窗口，请允许弹出窗口后重试。");
      toast("报告已打开，请选择“打印 / 保存 PDF”。");
    }
  } catch (error) {
    toast(error.message || "PDF 导出失败。");
  } finally {
    removeProgressListener?.();
    resultExportInProgress = false;
    el.exportResults.removeAttribute("aria-busy");
    el.exportResults.querySelector("span").textContent = "导出 PDF";
    syncResultExportAvailability();
  }
}

function validExportGeneration(generation) {
  if (!generation?.jobId || !generation.target) return false;
  if (generation.platform === "netease") {
    return ["source", "parallel"].includes(generation.mode)
      && generation.target.kind === "uid"
      && /^\d+$/.test(generation.target.value);
  }
  return generation.platform === "qq"
    && ["song", "likes"].includes(generation.mode)
    && generation.target.kind === "encryptUin"
    && typeof generation.target.value === "string"
    && generation.target.value.length > 0
    && generation.target.value.length <= 512;
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
  el.results.replaceChildren(...(items.length ? items.map((item) => resultRow(item, resultKey(item, resultView) === liveCommentId)) : [emptyRow()]));
  if (items.length) restorePendingPlatformScroll();
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
  const isQQ = item.platform === "qq" || resultView.startsWith("qq:");
  row.dataset.commentId = resultKey(item, resultView);
  if (live) row.classList.add("result-live");
  const timestamp = isQQ && Number(item.time) > 0 && Number(item.time) < 1_000_000_000_000
    ? Number(item.time) * 1_000
    : item.time;
  appendTextCell(row, timestamp ? date(timestamp) : "-");
  appendTextCell(row, `${item.nickname || "-"} · ${isQQ ? item.authorEncryptUin || "QQ 身份" : item.userId}`);
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
    link.title = isQQ ? "在 QQ 音乐打开歌曲" : `在网易云音乐打开评论 ${item.commentId}`;
    link.textContent = isQQ ? "打开歌曲" : "打开评论";
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
  if (item.platform === "qq" || resultView.startsWith("qq:")) {
    const resource = String(item.songMid || item.songId || "");
    const valid = item.songMid ? /^[A-Za-z0-9]+$/.test(resource) : /^\d+$/.test(resource);
    return valid ? `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(resource)}` : undefined;
  }
  const songId = String(item.songId || "");
  const commentId = String(item.commentId || "");
  if (!/^\d+$/.test(songId) || !/^\d+$/.test(commentId)) return undefined;
  return `https://music.163.com/#/song?id=${encodeURIComponent(songId)}&commentId=${encodeURIComponent(commentId)}`;
}

function resultKey(item, viewKey = taskViewKey()) {
  const commentId = String(item.commentId || "");
  return viewKey.startsWith("qq:") || item.platform === "qq"
    ? `${String(item.songId || "")}:${commentId}`
    : commentId;
}

function estimateForm() {
  return currentForm();
}

function estimateInputs() {
  const form = estimateForm();
  return [
    el.estimateComments,
    el.hostConcurrency,
    el.exitLimit,
    form.elements.minDelayMs,
    form.elements.jitterMs,
    ...(form.elements.workersPerProxy ? [form.elements.workersPerProxy] : []),
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
    el.qqSongForm.elements.minDelayMs,
    el.qqSongForm.elements.jitterMs,
    el.qqSongForm.elements.pageSize,
    el.qqSongForm.elements.proxy,
    el.qqLikesForm.elements.minDelayMs,
    el.qqLikesForm.elements.jitterMs,
    el.qqLikesForm.elements.pageSize,
    el.qqLikesForm.elements.likedPageSize,
    el.qqLikesForm.elements.proxy,
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
  const requestedView = taskViewKey();
  el.estimateButton.disabled = true;
  try {
    const view = TASK_VIEWS[requestedView];
    const form = estimateForm();
    const minDelayMs = Number(form.elements.minDelayMs.value);
    const jitterMs = Number(form.elements.jitterMs.value);
    const pageSize = Number(form.elements.pageSize.value);
    const proxyTransport = view.platform === "qq" || view.mode === "parallel" || poolRunning || Boolean(form.elements.proxy?.value.trim());
    const hostConcurrency = Math.max(1, Number(el.hostConcurrency.value || 8));
    const configuredWorkersPerLane = Number(form.elements.workersPerProxy?.value || 1);
    const lanes = selectedTaskLaneCount(configuredWorkersPerLane);
    const workersPerLane = view.platform === "qq"
      ? view.mode === "song" ? 1 : Math.max(1, Math.ceil(hostConcurrency / lanes))
      : configuredWorkersPerLane;
    const actualWorkers = view.mode === "song"
      ? 1
      : view.platform === "qq" ? hostConcurrency : Math.min(lanes * workersPerLane, hostConcurrency);
    const job = latestJobs[requestedView];
    const formTarget = view.platform === "qq"
      ? String((view.mode === "song" ? el.qqSongTarget : el.qqLikesTarget).value || "").trim()
      : String((view.mode === "parallel" ? el.parallelUid : el.uid).value || "").trim();
    const requestedParallelShards = view.mode === "parallel"
      ? Math.max(1, Number(form.elements.shards?.value || 1))
      : undefined;
    const localQQTarget = localRequestedTargets[requestedView]?.jobId === String(job?.id || "")
      ? localRequestedTargets[requestedView].value
      : resultGenerations[requestedView]?.target?.value;
    const sameTarget = Boolean(job?.id) && (view.platform === "qq"
      ? String(localQQTarget || "") === formTarget
        && (view.mode !== "song" || String(job.songId || "") === String(form.elements.songId?.value || "").trim())
      : String(job.uid || "") === formTarget
        && (view.mode !== "parallel" || String(job.songId || "") === String(form.elements.songId?.value || "").trim()));
    const sameConfiguration = sameTarget
      && Number(job.pageSize) === pageSize
      && Number(job.minDelayMs) === minDelayMs
      && Number(job.jitterMs) === jitterMs
      && Number(job.workersPerLane) === workersPerLane
      && Number(job.hostConcurrency) === hostConcurrency
      && Number(view.platform === "qq" ? job.configuredLanes : job.lanes) === lanes
      && (view.mode === "parallel"
        ? Number(job.configuredShardCount) === requestedParallelShards
        : view.mode === "source"
        ? String(job.source || "") === String(form.elements.source?.value || "")
        : view.mode === "likes"
        ? Number(job.likedPageSize) === Number(form.elements.likedPageSize.value)
        : true);
    const calibrated = sameConfiguration
      && Number(job.pageRequestSamples) >= 3
      && Number(job.successfulPageRequests) > 0
      && Number(job.averagePageRequestMs) >= 0
      && Number(job.averageCommentsPerPage) > 0;
    const effectiveTransport = view.platform === "qq"
      ? sameConfiguration && Number(job.proxyTransportEffectiveConcurrent) > 0
        ? Math.min(actualWorkers, Number(job.proxyTransportEffectiveConcurrent))
        : actualWorkers
      : proxyTransport && sameConfiguration && Number(job.proxyTransportEffectiveConcurrent) > 0
      ? Math.min(hostConcurrency, Number(job.proxyTransportEffectiveConcurrent))
      : hostConcurrency;
    const configuredPartitions = view.mode === "parallel"
      ? requestedParallelShards
      : view.mode === "song" ? 1 : Math.max(1, sameTarget ? Number(job.songs || 1) : 1);
    const partitions = view.mode === "parallel"
      ? Math.max(1, Math.min(configuredPartitions, actualWorkers, effectiveTransport))
      : configuredPartitions;
    const params = new URLSearchParams({
      platform: view.platform,
      mode: view.mode,
      comments: el.estimateComments.value,
      pageSize: String(pageSize),
      partitions: String(partitions),
      minDelayMs: String(minDelayMs),
      jitterMs: String(jitterMs),
      networkMs: String(calibrated ? job.averagePageRequestMs : poolNetworkMs),
      lanes: String(lanes),
      workersPerLane: String(workersPerLane),
      proxyTransport: proxyTransport ? "1" : "0",
      hostConcurrency: String(hostConcurrency),
      proxyTransportEffectiveConcurrent: String(effectiveTransport),
    });
    if (calibrated) {
      params.set("observedCommentsPerPage", String(job.averageCommentsPerPage));
      params.set("requestSuccessRatio", String(job.pageRequestSuccessRatio || 1));
    }
    const value = await api(`/api/estimate?${params}`);
    if (request !== estimateRequest || requestedView !== taskViewKey()) return;
    el.estimatePages.textContent = fmt(value.estimatedRequests);
    el.estimateOptimistic.textContent = duration(value.optimisticSeconds);
    el.estimateExpected.textContent = duration(value.expectedSeconds);
    el.estimateConservative.textContent = duration(value.conservativeSeconds);
    const scanMode = view.label;
    const transport = value.proxyTransportMaxConcurrent
      ? view.platform === "qq"
        ? ` · QQ 动态聚合保护：最多 ${fmt(value.proxyTransportEffectiveConcurrent)} 个在途，请求启动间隔至少 ${fmt(value.proxyTransportEffectiveStartDelayMs)}ms`
        : ` · 主机聚合保护：配置 ${fmt(value.proxyTransportMaxConcurrent)}，当前有效 ${fmt(value.proxyTransportEffectiveConcurrent)} 并发，实际启动间隔 ${fmt(value.proxyTransportEffectiveStartDelayMs)}..${fmt(value.proxyTransportEffectiveStartDelayMs + value.proxyTransportStartJitterMs)}ms`
      : "";
    const calibration = calibrated
      ? `实况校准 ${fmt(job.pageRequestSamples)} 页 / ${fmt(job.pageRequestAttempts)} 次远端尝试：平均 ${fmt(job.averageCommentsPerPage)} 条/页、${fmt(job.averagePageRequestMs)}ms、成功率 ${(Number(job.pageRequestSuccessRatio || 0) * 100).toFixed(1)}%`
      : `理论模型：节点轻量探测约 ${fmt(poolNetworkMs)}ms；任务产生 3 次页面请求后自动校准`;
    const topology = view.mode === "song"
      ? `${fmt(value.lanes)} 个出口轮转 · SeqNo 协议链 1 在途 · 主机线程上限 ${fmt(hostConcurrency)}`
      : view.platform === "qq"
      ? `${fmt(value.lanes)} 个出口自动分配 · 主机线程上限 ${fmt(hostConcurrency)} · 可调度 ${fmt(Math.min(value.totalWorkers, hostConcurrency))} 个工作线程 · 最多 ${fmt(value.effectiveWorkers)} 个在途`
      : `${fmt(value.lanes)} 个出口 × 每出口最多 ${fmt(value.workersPerLane)} 工作线程 · 实际 ${fmt(value.effectiveWorkers ?? value.totalWorkers)} 工作线程`;
    const pacing = view.platform === "qq" ? ` · 工作线程共享单出口请求节奏 · 检查点在途槽 ${fmt(value.checkpointSlots)}` : "";
    el.estimateContext.textContent = `${scanMode} · ${fmt(value.partitions)} 个独立分页区间 · ${topology} · 每页上限 ${fmt(pageSize)} 条 · ${calibration}${transport}${pacing} · 预期 ${fmt(value.expectedCommentsPerSecond)} 条/秒`;
  } catch (error) { if (request === estimateRequest && requestedView === taskViewKey()) toast(error.message); }
  finally { if (request === estimateRequest) el.estimateButton.disabled = false; }
}

function tableRow(values) { const row = document.createElement("tr"); values.forEach((value) => appendTextCell(row, value)); return row; }
function emptyRow() { const row = document.createElement("tr"); row.className = "empty-row"; const cell = document.createElement("td"); cell.colSpan = 5; cell.textContent = "暂无命中"; row.append(cell); return row; }

async function stopJob() {
  try {
    const targetViewKey = activeTaskViewKey || taskViewKey();
    const view = TASK_VIEWS[targetViewKey];
    const targetMode = activeTaskMode || view.taskMode;
    const job = await api(`${taskBase(targetMode)}/stop`, { method: "POST", body: "{}" });
    targetMode === "parallel" ? renderParallel(job) : targetMode === "source" ? renderSource(job) : renderQQ(job);
    if (targetViewKey !== taskViewKey()) toast(`已停止${view.label}任务`);
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
    neteaseAuthCookiePresent = Boolean(auth.cookiePresent);
    syncAuthPresentation();
    if (el.qrDialog.open) renderAuth(auth);
  } catch { /* Connection state is reflected by the main status poll. */ }
}
function syncAuthPresentation() {
  const showNeteaseAuth = platform === "netease" && neteaseAuthCookiePresent;
  const connectionText = showNeteaseAuth ? "已保存网易云登录" : "本地服务";
  if (el.connection.dataset.label !== connectionText) {
    el.connection.dataset.label = connectionText;
    const dot = document.createElement("span");
    dot.className = "status-dot";
    el.connection.replaceChildren(dot, connectionText);
  }
  el.login.hidden = platform === "qq";
  el.login.querySelector("span").textContent = neteaseAuthCookiePresent ? "更新登录" : "二维码登录";
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
  el.updateReleaseName.textContent = update.releaseName || `乐评寻踪 v${update.latestVersion}`;
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
    el.updateReleaseName.textContent = state.releaseName || `乐评寻踪 v${state.latestVersion}`;
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
    setNativeUpdateAction(activeTaskMode || startSubmissionBusy || qqLookupBusy ? "保存进度并重启" : "重启并安装");
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
      const installState = await window.ncmDesktop.installUpdate();
      if (installState?.phase === "error") {
        throw new Error(installState.error || "安装程序未能启动。");
      }
    } else {
      renderWindowsUpdate(await window.ncmDesktop.checkForUpdates());
    }
  } catch (error) {
    if (nativeUpdateState?.phase === "downloaded") await cancelUpdatePreparation();
    if (nativeUpdateState) renderWindowsUpdate(nativeUpdateState);
    toast(`更新失败：${error.message}`);
  }
}

async function cancelUpdatePreparation() {
  await api("/api/tasks/cancel-update", { method: "POST", body: "{}" }).catch(() => undefined);
}

async function prepareTaskForUpdate() {
  if (startSubmissionBusy || qqLookupBusy) {
    throw new Error("任务或歌曲查询正在启动，请等待启动完成后再安装更新。");
  }
  setNativeUpdateAction("正在保存扫描进度…", true);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await api("/api/tasks/prepare-update", { method: "POST", body: "{}" });
    if (state.active && state.mode === "pool") {
      throw new Error("代理池正在构建、导入或后台复测，请等待代理池操作完成后再安装更新。");
    }
    if (!state.active) {
      activeTaskMode = undefined;
      activeTaskViewKey = undefined;
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
  desktop.onUpdateState((next) => {
    renderWindowsUpdate(next);
    if (next?.phase === "error") void cancelUpdatePreparation();
  });
}

async function restoreResumeTask() {
  try {
    const restored = await api("/api/resume");
    const descriptor = restored.task;
    if (!descriptor) return false;
    const descriptorPlatform = descriptor.platform === "qq" ? "qq" : "netease";
    if (descriptorPlatform === "netease" && !["parallel", "source"].includes(descriptor.mode)) return false;
    if (descriptorPlatform === "qq" && !["song", "likes"].includes(descriptor.mode)) return false;
    const descriptorView = TASK_VIEWS[`${descriptorPlatform}:${descriptor.mode}`];
    if (!descriptorView) return false;
    const form = descriptorView.form;
    const allowed = descriptor.mode === "parallel"
      ? new Set(["uid", "songId", "workersPerProxy", "shards", "pageSize", "requestBudget", "maxPages", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxProxyLanes", "hostConcurrency"])
      : descriptor.mode === "source"
      ? new Set(["uid", "source", "recordScope", "pageSize", "requestBudget", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxCommentPagesPerSong", "maxSongs", "workersPerProxy", "allowDirect", "maxProxyLanes", "hostConcurrency"])
      : descriptor.mode === "song"
      ? new Set(["target", "songId", "pageSize", "requestBudget", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxCommentPagesPerSong", "allowDirect", "maxProxyLanes", "hostConcurrency"])
      : new Set(["target", "pageSize", "likedPageSize", "requestBudget", "minDelayMs", "jitterMs", "forbiddenCooldownMs", "maxCommentPagesPerSong", "maxSongs", "allowDirect", "maxProxyLanes", "hostConcurrency"]);
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
    platform = descriptorPlatform;
    mode = descriptor.mode;
    desiredPlatform = platform;
    selectedModes[platform] = mode;
    applyPlatformPresentation();
    restoreSongSearchSelection(SONG_SEARCHES.netease);
    restoreSongSearchSelection(SONG_SEARCHES.qq);
    $("#parallelFresh").checked = false;
    $("#fresh").checked = false;
    $("#qqSongFresh").checked = false;
    $("#qqLikesFresh").checked = false;
    const source = el.sourceForm.elements.namedItem("source")?.value;
    $("#recordScopeField").hidden = source === "likes";
    const adjustments = Array.isArray(restored.adjustments) ? restored.adjustments : [];
    const messages = [];
    if (adjustments.includes("netease-request-spacing-per-start-v1")) {
      messages.push("旧版网易云节奏已等价换算为同出口真实启动间隔；检查点和扫描进度保持不变");
    }
    if (adjustments.includes("qq-comment-page-size-25")) {
      messages.push("旧版 QQ 评论分页已安全调整为 25；检查点游标保持不变");
    }
    return messages.length > 0 ? `已恢复任务参数：${messages.join("；")}。` : true;
  } catch {
    return false;
  }
}

async function switchMode(value) {
  if (document.body.classList.contains("platform-switching")) {
    configureModeSwitch();
    return;
  }
  if (value === mode || !TASK_VIEWS[`${platform}:${value}`]) return;
  cancelPendingPlatformScrollRestore();
  const ownerPlatform = platform;
  const switchVersion = ++modeSwitchVersion;
  const previousMode = mode;
  const previousForm = currentForm();
  if (["parallel", "song"].includes(previousMode)) cancelSongLookup(SONG_SEARCHES[ownerPlatform]);
  mode = value;
  selectedModes[platform] = mode;
  document.body.dataset.mode = mode;
  syncToolbarContext();
  syncResultExportAvailability();
  resetVisibleResults();
  resetVisibleLogs();
  renderSelectedTaskSnapshot();
  connectResultStream();
  const converged = await slideSwap(
    previousForm,
    currentForm(),
    ["source", "likes"].includes(mode) ? 1 : -1,
    () => switchVersion === modeSwitchVersion && platform === ownerPlatform,
  );
  if (!converged || switchVersion !== modeSwitchVersion || platform !== ownerPlatform) {
    syncModeVisibility();
    return;
  }
  knownMatches = -1;
  void refresh(); void refreshResults();
  if ($('.tab.active')?.dataset.tab === "estimate") void refreshEstimate(false);
  if ($('.tab.active')?.dataset.tab === "logs") void refreshLogs();
}
function syncModeVisibility() {
  const active = currentForm();
  for (const form of [el.parallelForm, el.sourceForm, el.qqSongForm, el.qqLikesForm]) {
    const hidden = form !== active;
    form.hidden = hidden;
    form.setAttribute("aria-hidden", String(hidden));
  }
}

function configureModeSwitch() {
  $$('input[name="neteaseMode"]').forEach((input) => { input.checked = input.value === selectedModes.netease; });
  $$('input[name="qqMode"]').forEach((input) => { input.checked = input.value === selectedModes.qq; });
}

function applyRememberedTaskTab() {
  const tabName = selectedTabs[platform] || "results";
  const tabs = $$('.tab');
  for (const item of tabs) {
    const active = item.dataset.tab === tabName;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  }
  for (const name of ["results", "activity", "logs", "pool", "estimate"]) {
    const panel = panelForTab(name);
    if (panel) {
      const hidden = name !== tabName;
      panel.hidden = hidden;
      panel.setAttribute("aria-hidden", String(hidden));
    }
  }
  setActiveNavigation(tabName);
}

function applyPlatformPresentation({ announce = false } = {}) {
  document.body.dataset.platform = platform;
  document.body.dataset.mode = mode;
  el.platformIdentity.textContent = platform === "qq" ? "QQ MUSIC WORKSPACE" : "NETEASE WORKSPACE";
  syncAuthPresentation();
  for (const item of $$('[data-platform-target]')) {
    const active = item.dataset.platformTarget === platform;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  }
  for (const item of $$('.netease-only')) item.hidden = platform !== "netease";
  for (const item of $$('.qq-only')) item.hidden = platform !== "qq";
  for (const workbench of [el.neteaseWorkbench, el.qqWorkbench]) {
    const active = workbench.dataset.workbench === platform;
    workbench.hidden = !active;
    workbench.inert = !active;
  }
  const activityLabel = platform === "qq" ? "活动歌曲" : "并行歌曲";
  const activityNavigation = $('[data-nav-view="activity"]');
  if (activityNavigation) {
    activityNavigation.ariaLabel = activityLabel;
    activityNavigation.title = activityLabel;
    const label = activityNavigation.querySelector(".navigation-label");
    if (label) label.textContent = activityLabel;
  }
  configureModeSwitch();
  syncModeVisibility();
  applyRememberedTaskTab();
  syncToolbarContext();
  syncResultExportAvailability();
  if (announce) {
    el.platformLiveRegion.textContent = platform === "qq" ? "已进入 QQ 音乐工作台" : "已进入网易云音乐工作台";
  }
}

function capturePlatformScrollState() {
  const nodes = [...new Set([
    document.scrollingElement,
    el.taskSidebar,
    $('#runtimeInspector'),
    el.inspectorBody,
    el.primaryNavigation,
    $('#globalPlatformSwitch'),
    ...$$('.tabs'),
    ...$$('.table-wrap'),
  ].filter(Boolean))];
  const positions = nodes.map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));
  const resultNode = $('#resultsPanel .table-wrap');
  const resultPosition = positions.find((entry) => entry.node === resultNode);
  const pageLeft = scrollX;
  const pageTop = scrollY;
  return {
    resultNode,
    restoreImmediate() {
      for (const entry of positions) {
        entry.node.scrollLeft = entry.left;
        entry.node.scrollTop = entry.top;
      }
      scrollTo(pageLeft, pageTop);
    },
    restoreResult() {
      if (!resultPosition) return;
      resultPosition.node.scrollLeft = resultPosition.left;
      resultPosition.node.scrollTop = resultPosition.top;
    },
  };
}

function cancelPendingPlatformScrollRestore() {
  const pending = pendingPlatformScrollRestore;
  if (!pending) return;
  pendingPlatformScrollRestore = undefined;
  clearTimeout(pending.timer);
  for (const type of pending.cancelEvents) pending.node.removeEventListener(type, pending.cancel);
}

function armPlatformScrollRestore(targetPlatform, targetMode, switchVersion, scrollState) {
  cancelPendingPlatformScrollRestore();
  if (!scrollState?.resultNode || typeof scrollState.restoreResult !== "function") return;
  const pending = {
    targetPlatform,
    targetMode,
    targetViewKey: taskViewKey(),
    switchVersion,
    generationRevision: resultGenerationRevisions[taskViewKey()],
    node: scrollState.resultNode,
    restore: scrollState.restoreResult,
    cancelEvents: ["wheel", "touchstart", "pointerdown", "keydown"],
    timer: undefined,
    cancel: undefined,
  };
  pending.cancel = () => {
    if (pendingPlatformScrollRestore === pending) cancelPendingPlatformScrollRestore();
  };
  pendingPlatformScrollRestore = pending;
  for (const type of pending.cancelEvents) pending.node.addEventListener(type, pending.cancel, { once: true, passive: type !== "keydown" });
  pending.timer = setTimeout(pending.cancel, PLATFORM_SCROLL_RESTORE_TTL_MS);
}

function restorePendingPlatformScroll() {
  const pending = pendingPlatformScrollRestore;
  if (!pending) return false;
  if (pending.switchVersion !== platformSwitchVersion
    || pending.targetPlatform !== platform
    || pending.targetPlatform !== desiredPlatform
    || pending.targetMode !== mode
    || pending.targetViewKey !== taskViewKey()
    || pending.generationRevision !== resultGenerationRevisions[taskViewKey()]) {
    cancelPendingPlatformScrollRestore();
    return false;
  }
  cancelPendingPlatformScrollRestore();
  pending.restore();
  return true;
}

function createPlatformTransition(targetPlatform, commit) {
  const tabs = $$('[data-platform-target]');
  const sourceTab = tabs.find((item) => item.dataset.platformTarget === platform);
  const targetTab = tabs.find((item) => item.dataset.platformTarget === targetPlatform);
  const sourceIndex = Math.max(0, tabs.indexOf(sourceTab));
  const targetIndex = Math.max(0, tabs.indexOf(targetTab));
  const direction = targetIndex >= sourceIndex ? 1 : -1;
  const engine = globalThis.PlatformWaveTransition;
  if (!engine?.create) {
    let committed = false;
    let commitError;
    try { committed = commit() === true; } catch (error) { commitError = error; }
    return { finished: Promise.resolve({ committed, completed: true, renderer: "none", commitError }), cancel() {} };
  }
  try {
    return engine.create({
      sourcePlatform: platform,
      targetPlatform,
      direction,
      commit,
    });
  } catch {
    let committed = false;
    let commitError;
    try { committed = commit() === true; } catch (error) { commitError = error; }
    return { finished: Promise.resolve({ committed, completed: true, renderer: "none", commitError }), cancel() {} };
  }
}

function renderSelectedTaskSnapshot() {
  const viewKey = taskViewKey();
  const cached = latestJobs[viewKey] ?? (platform === "qq"
    ? emptyQQSnapshot(mode)
    : { status: "idle", activeSongs: [], songs: 0, songsProcessed: 0, shards: 0, shardsComplete: 0, pagesProcessed: 0, commentsInspected: 0, matches: 0, requestsTotal: 0, commentsPerSecond: 0 });
  renderedJobSignature = "";
  if (viewKey === "netease:parallel") renderParallel(cached);
  else if (viewKey === "netease:source") renderSource(cached);
  else renderQQ(cached);
}

function refreshSelectedTaskPresentation() {
  knownMatches = -1;
  void refresh();
  void refreshResults();
  if ($('.tab.active')?.dataset.tab === "estimate") void refreshEstimate(false);
  if ($('.tab.active')?.dataset.tab === "logs") void refreshLogs();
}

function commitPlatformSelection(value, switchVersion, options = {}) {
  if (!['netease', 'qq'].includes(value)) return false;
  if (switchVersion !== undefined && (switchVersion !== platformSwitchVersion || desiredPlatform !== value)) return false;
  const previousPlatform = platform;
  const changed = previousPlatform !== value;
  const restoreFocus = Boolean(options.restoreFocus);
  try {
    if (changed) {
      selectedTabs[previousPlatform] = $('.tab.active')?.dataset.tab || "results";
      cancelSongLookup(SONG_SEARCHES[previousPlatform]);
      selectedModes[previousPlatform] = mode;
      platform = value;
      mode = selectedModes[platform];
      modeSwitchVersion += 1;
    }
    applyPlatformPresentation({ announce: changed && options.announce !== false });
    resetVisibleResults();
    resetVisibleLogs();
    renderSelectedTaskSnapshot();
    connectResultStream();
    if (restoreFocus && changed) $(`[data-platform-target="${platform}"]`)?.focus({ preventScroll: true });
    return true;
  } finally {
    options.restoreScroll?.restoreImmediate?.();
    if (changed && options.deferScrollRestore && $('.tab.active')?.dataset.tab === "results") {
      armPlatformScrollRestore(value, mode, switchVersion, options.restoreScroll);
    }
  }
}

async function switchPlatform(value) {
  if (!["netease", "qq"].includes(value)) return;
  desiredPlatform = value;
  const switchVersion = ++platformSwitchVersion;
  modeSwitchVersion += 1;
  platformTransition?.cancel();
  platformTransition = undefined;
  cancelPendingPlatformScrollRestore();
  cancelInterfaceMotions();
  if (value === platform) {
    applyPlatformPresentation();
    renderSelectedTaskSnapshot();
    connectResultStream();
    refreshSelectedTaskPresentation();
    return;
  }
  const restorePlatformFocus = el.taskSidebar.contains(document.activeElement) || document.activeElement === el.login;
  const restoreScroll = capturePlatformScrollState();
  let commitRecovered = false;
  const transition = createPlatformTransition(value, () => {
    const commitOptions = {
      announce: true,
      restoreFocus: restorePlatformFocus,
      restoreScroll,
      deferScrollRestore: true,
    };
    try {
      return commitPlatformSelection(value, switchVersion, commitOptions);
    } catch (error) {
      try {
        const recovered = commitPlatformSelection(value, switchVersion, commitOptions);
        if (recovered) {
          commitRecovered = true;
          return true;
        }
      } catch (recoveryError) {
        throw recoveryError;
      }
      throw error;
    }
  });
  platformTransition = transition;
  const outcome = await transition.finished;
  if (platformTransition === transition) platformTransition = undefined;
  if (switchVersion !== platformSwitchVersion || desiredPlatform !== value) return;
  if (!outcome.completed) return;
  if (!outcome.committed || platform !== value) {
    try {
      if (!commitPlatformSelection(value, switchVersion, {
        announce: platform !== value,
        restoreFocus: restorePlatformFocus,
        restoreScroll,
        deferScrollRestore: true,
      })) return;
      toast("平台动画已安全降级，工作台状态已恢复。");
    } catch {
      toast("平台切换未能完成，请重试。");
      return;
    }
  }
  if (commitRecovered) toast("平台状态已在遮罩内安全收敛。");
  refreshSelectedTaskPresentation();
}

async function switchToView(viewKey) {
  const view = TASK_VIEWS[viewKey];
  if (!view) return;
  selectedModes[view.platform] = view.mode;
  if (view.platform !== platform) await switchPlatform(view.platform);
  else if (view.mode !== mode) await switchMode(view.mode);
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
async function slideSwap(outgoing, incoming, direction = 1, shouldCommit = () => true) {
  if (outgoing === incoming) return true;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && !outgoing.hidden) {
    await playMotion(outgoing, [
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${-18 * direction}px)` },
    ], 170, "cubic-bezier(.4,0,.2,1)");
  }
  if (!shouldCommit()) return false;
  outgoing.hidden = true; outgoing.setAttribute("aria-hidden", "true");
  incoming.hidden = false; incoming.setAttribute("aria-hidden", "false");
  if (!reduced) void playMotion(incoming, [
    { opacity: 0, transform: `translateX(${18 * direction}px)` },
    { opacity: 1, transform: "translateX(0)" },
  ], 240, "cubic-bezier(.2,.8,.2,1)");
  return true;
}

function clearFallbackMotion(element) {
  element.style.removeProperty("opacity");
  element.style.removeProperty("transform");
  element.style.removeProperty("transition");
}

function cancelInterfaceMotions() {
  for (const details of activeDisclosureDetails) {
    disclosureAnimations.get(details)?.cancel();
    disclosureAnimations.delete(details);
    const expanded = details.dataset.expanded === "true";
    details.open = expanded;
    details.querySelector(":scope > summary")?.setAttribute("aria-expanded", String(expanded));
    details.classList.remove("is-animating");
  }
  activeDisclosureDetails.clear();
  for (const animation of interfaceAnimations) animation.cancel();
  interfaceAnimations.clear();
  for (const element of fallbackMotionElements) clearFallbackMotion(element);
  fallbackMotionElements.clear();
}

async function playMotion(element, frames, duration, easing) {
  if (document.body.classList.contains("platform-switching")) return;
  if (typeof element.animate === "function") {
    const animation = element.animate(frames, { duration, easing });
    interfaceAnimations.add(animation);
    await animation.finished.catch(() => {}).finally(() => interfaceAnimations.delete(animation));
    return;
  }
  fallbackMotionElements.add(element);
  try {
    Object.assign(element.style, frames[0]);
    void element.offsetWidth;
    element.style.transition = `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}`;
    Object.assign(element.style, frames[1]);
    await new Promise((resolve) => setTimeout(resolve, duration));
  } finally {
    fallbackMotionElements.delete(element);
    clearFallbackMotion(element);
  }
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
  if (document.body.classList.contains("platform-switching")
    || matchMedia("(prefers-reduced-motion: reduce)").matches
    || typeof content.animate !== "function") {
    details.open = expanded;
    details.classList.remove("is-animating");
    disclosureAnimations.delete(details);
    activeDisclosureDetails.delete(details);
    return;
  }
  const endHeight = expanded ? content.scrollHeight : 0;
  details.classList.add("is-animating");
  const animation = content.animate([
    { height: `${startHeight}px`, opacity: expanded ? 0.35 : 1, transform: expanded ? "translateY(-6px)" : "translateY(0)" },
    { height: `${endHeight}px`, opacity: expanded ? 1 : 0.25, transform: expanded ? "translateY(0)" : "translateY(-6px)" },
  ], { duration: expanded ? 280 : 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
  disclosureAnimations.set(details, animation);
  activeDisclosureDetails.add(details);
  interfaceAnimations.add(animation);
  await animation.finished.catch(() => {});
  interfaceAnimations.delete(animation);
  if (disclosureAnimations.get(details) !== animation) return;
  if (!expanded) details.open = false;
  animation.cancel();
  disclosureAnimations.delete(details);
  activeDisclosureDetails.delete(details);
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
  const disabled = startSubmissionBusy || qqLookupBusy || Boolean(activeTaskMode)
    || poolChangeInFlight || poolStatus === "starting" || poolRefreshing;
  el.parallelStart.disabled = disabled;
  el.sourceStart.disabled = disabled;
  el.qqSongStart.disabled = disabled;
  el.qqLikesStart.disabled = disabled;
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
function qqToolbarTargetLabel(viewKey, rawTarget) {
  const job = latestJobs[viewKey];
  const locallyStarted = localRequestedTargets[viewKey];
  const managerOwnsVisibleTarget = activeTaskViewKey === viewKey
    || (job?.id && locallyStarted?.jobId === String(job.id) && locallyStarted.value === rawTarget);
  if (managerOwnsVisibleTarget && job?.targetLabel) return `QQ ${job.targetLabel}`;
  return rawTarget ? "QQ 目标已填写" : "QQ 目标待填写";
}
function syncToolbarContext() {
  const view = currentView();
  const form = view.form;
  const target = platform === "qq"
    ? (mode === "song" ? el.qqSongTarget : el.qqLikesTarget).value.trim()
    : (mode === "parallel" ? el.parallelUid : el.uid).value.trim();
  const configuredWorkersPerLane = Number(form.elements.workersPerProxy?.value || 1);
  const lanes = selectedTaskLaneCount(configuredWorkersPerLane);
  const hostConcurrency = Math.max(1, Number(el.hostConcurrency.value || 8));
  const workersPerLane = platform === "qq" && mode === "likes"
    ? Math.max(1, Math.ceil(hostConcurrency / lanes))
    : configuredWorkersPerLane;
  const actualWorkers = mode === "song"
    ? 1
    : platform === "qq" ? hostConcurrency : Math.min(lanes * workersPerLane, hostConcurrency);
  const laneMode = Number(el.exitLimit.value || 0) > 0 ? "手动" : "自动";
  el.toolbarUid.textContent = platform === "qq"
    ? qqToolbarTargetLabel(taskViewKey(), target)
    : target ? `UID ${target}` : "UID 待填写";
  el.toolbarMode.textContent = mode === "parallel"
    ? "单曲并行"
    : mode === "source"
    ? `用户来源 · ${sourceName(form.elements.source?.value)}`
    : view.label;
  el.toolbarTopology.textContent = platform === "qq"
    ? mode === "song"
      ? `${poolRunning ? `${laneMode}使用 ${fmt(lanes)}/${fmt(poolLaneCount)}` : "1"} 出口 · 主机上限 ${fmt(hostConcurrency)} · SeqNo 链 1 在途`
      : `${poolRunning ? `${laneMode}使用 ${fmt(lanes)}/${fmt(poolLaneCount)}` : "1"} 出口 · 主机上限 ${fmt(hostConcurrency)} · 可调度 ${fmt(actualWorkers)} 工作线程 · 每出口自动≤${fmt(workersPerLane)}`
    : poolRunning
      ? `${laneMode}使用 ${fmt(lanes)}/${fmt(poolLaneCount)} 出口 · 实际 ${fmt(actualWorkers)} 工作线程${mode === "song" ? " · 单链轮转" : ` · 每出口≤${fmt(workersPerLane)}`}`
      : `1 出口 · 实际 ${fmt(actualWorkers)} 工作线程${mode === "song" ? " · 单链" : ` · 每出口≤${fmt(workersPerLane)}`}`;
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
    const details = currentForm().querySelector("details.advanced");
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
  if (!collapsed && inspectorOverlayQuery.matches && !document.body.classList.contains("inspector-collapsed")) {
    setInspectorCollapsed(true);
  }
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
  if (!collapsed && inspectorOverlayQuery.matches && !document.body.classList.contains("task-panel-collapsed")) {
    setTaskPanelCollapsed(true);
  }
  if (collapsed && el.inspectorBody.contains(document.activeElement)) {
    el.inspectorToggle.focus({ preventScroll: true });
  }
  el.inspectorBody.inert = collapsed;
  el.inspectorBody.setAttribute("aria-hidden", String(collapsed));
  document.body.classList.toggle("inspector-collapsed", collapsed);
  el.inspectorToggle.setAttribute("aria-label", collapsed ? "展开运行详情" : "收起运行详情");
  el.inspectorToggle.title = collapsed ? "展开运行详情" : "收起运行详情";
  el.inspectorToggle.setAttribute("aria-expanded", String(!collapsed));
  $('[data-nav-view="pool"]')?.setAttribute("aria-expanded", String(!collapsed));
}
function syncInspectorForViewport(event = inspectorOverlayQuery) {
  if (event.matches) setInspectorCollapsed(true);
}
function setBusy(value) {
  startSubmissionBusy = value;
  el.toolbarStart.querySelector("span").textContent = value ? "启动中…" : "启动";
  el.parallelStart.querySelector("span").textContent = value ? "正在启动…" : "开始并行扫描";
  el.sourceStart.querySelector("span").textContent = value ? "正在启动…" : "开始扫描";
  el.qqSongStart.querySelector("span").textContent = value ? "正在启动…" : "开始顺序扫描";
  el.qqLikesStart.querySelector("span").textContent = value ? "正在启动…" : "扫描公开喜欢歌曲";
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
    ? ` · 总工作线程上限 ${fmt(configured)} · 自动降载至 ${fmt(effective)}`
    : ` · 总工作线程上限 ${fmt(configured)}`;
}
function topologyCapacityNote(job) {
  return "";
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
  if (restored) toast(typeof restored === "string" ? restored : "已恢复上次任务参数；保持“新建状态”关闭即可从检查点继续。");
  void checkUpdates(false);
}

el.parallelForm.addEventListener("submit", (event) => { event.preventDefault(); void startParallel(); });
el.sourceForm.addEventListener("submit", (event) => { event.preventDefault(); void startSource(false); });
el.qqSongForm.addEventListener("submit", (event) => { event.preventDefault(); void startQQ("song"); });
el.qqLikesForm.addEventListener("submit", (event) => { event.preventDefault(); void startQQ("likes"); });
for (const search of Object.values(SONG_SEARCHES)) setupSongSearch(search);
document.addEventListener("pointerdown", (event) => {
  const target = event.target instanceof Element ? event.target : undefined;
  for (const search of Object.values(SONG_SEARCHES)) {
    if (!target?.closest(`[data-song-search="${search.platform}"]`)) clearSongResults(search);
  }
});
el.dryRun.addEventListener("click", () => void startSource(true)); el.lookup.addEventListener("click", () => void lookupUser());
el.poolToggle.addEventListener("click", () => void togglePool()); el.stop.addEventListener("click", () => void stopJob()); el.refresh.addEventListener("click", () => void refresh());
el.clashConfigSelectAll.addEventListener("click", toggleClashConfigs);
el.clashConfig.addEventListener("change", () => {
  clashConfigSelection = new Set(selectedClashConfigPaths());
  syncClashSelectAllButton();
});
el.toolbarStart.addEventListener("click", () => currentForm().requestSubmit());
el.taskPanelOpen.addEventListener("click", () => {
  if (!document.body.classList.contains("task-panel-collapsed")) setTaskPanelCollapsed(true);
  else void activateNavigation("search");
});
el.taskPanelToggle.addEventListener("click", () => setTaskPanelCollapsed(true));
el.inspectorToggle.addEventListener("click", () => setInspectorCollapsed(!document.body.classList.contains("inspector-collapsed")));
el.exportResults.addEventListener("click", () => void exportCurrentResults());
$$('[data-nav-view]').forEach((item) => item.addEventListener("click", () => void activateNavigation(item.dataset.navView)));
$$('#parallelForm input, #sourceForm input, #qqSongForm input, #qqLikesForm input').forEach((input) => input.addEventListener("input", syncToolbarContext));
el.exitLimit.addEventListener("input", syncToolbarContext);
el.hostConcurrency.addEventListener("input", syncToolbarContext);
el.estimateButton.addEventListener("click", () => void refreshEstimate());
allEstimateInputs().forEach((input) => input.addEventListener("input", () => scheduleEstimateRefresh()));
$$('[data-comments]').forEach((button) => button.addEventListener("click", () => { el.estimateComments.value = button.dataset.comments; void refreshEstimate(); }));
$$('[data-open-uid-help]').forEach((button) => button.addEventListener("click", () => el.uidHelpDialog.showModal()));
$$('[data-open-classic-encrypt-uin]').forEach((button) => button.addEventListener("click", () => openClassicEncryptUinDialog(button)));
$$('[data-help-key]').forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openParameterHelp(button.dataset.helpKey); }));
$("#closeUidHelpButton").addEventListener("click", () => el.uidHelpDialog.close());
$("#gotUidHelpButton").addEventListener("click", () => el.uidHelpDialog.close());
el.classicInput.addEventListener("input", resetClassicDecodeState);
el.classicDecode.addEventListener("click", () => void decodeClassicEncryptUin());
el.classicReveal.addEventListener("click", toggleClassicIdentifierReveal);
el.classicCopy.addEventListener("click", () => void copyClassicIdentifier());
el.classicVerify.addEventListener("click", () => void verifyClassicEncryptUin());
$("#closeClassicEncryptUinButton").addEventListener("click", closeClassicEncryptUinDialog);
$("#doneClassicEncryptUinButton").addEventListener("click", closeClassicEncryptUinDialog);
el.classicDialog.addEventListener("close", () => {
  cancelClassicResolution();
  cancelClassicVerification();
  el.classicInput.value = "";
  resetClassicDecodeState();
});
window.addEventListener("pagehide", () => {
  el.classicInput.value = "";
  resetClassicDecodeState();
});
$("#closeParameterHelpButton").addEventListener("click", () => el.parameterHelpDialog.close());
$("#gotParameterHelpButton").addEventListener("click", () => el.parameterHelpDialog.close());
el.login.addEventListener("click", () => void startAuth()); $("#closeQrButton").addEventListener("click", () => el.qrDialog.close());
$("#closeSettlementButton").addEventListener("click", () => el.settlementDialog.close());
$("#viewSettlementLogsButton").addEventListener("click", async () => { const view = el.settlementDialog.dataset.view; el.settlementDialog.close(); await switchToView(view); if (openTaskTab("logs")) void refreshLogs(); });
$("#viewSettlementResultsButton").addEventListener("click", async () => { const view = el.settlementDialog.dataset.view; el.settlementDialog.close(); await switchToView(view); if (openTaskTab("results")) void refreshResults(); });
el.updateButton.addEventListener("click", () => void checkUpdates(true));
$("#closeUpdateButton").addEventListener("click", () => el.updateDialog.close());
$("#laterUpdateButton").addEventListener("click", () => el.updateDialog.close());
el.updateDownload.addEventListener("click", (event) => void activateUpdate(event));
$$('input[name="neteaseMode"], input[name="qqMode"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) void switchMode(input.value); }));
$$('[data-platform-target]').forEach((item) => {
  item.addEventListener("click", () => void switchPlatform(item.dataset.platformTarget));
  item.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[data-platform-target]');
    const index = tabs.indexOf(item);
    const next = event.key === "Home"
      ? tabs[0]
      : event.key === "End"
      ? tabs.at(-1)
      : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    void switchPlatform(next.dataset.platformTarget);
  });
});
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
configureModeSwitch();
syncModeVisibility();
setTaskPanelCollapsed(document.body.classList.contains("task-panel-collapsed"));
setInspectorCollapsed(document.body.classList.contains("inspector-collapsed"));
syncInspectorForViewport();
syncResultExportAvailability();
inspectorOverlayQuery.addEventListener("change", syncInspectorForViewport);
syncToolbarContext();
void boot().finally(() => {
  scheduleRefreshLoop();
  scheduleAuthRefreshLoop();
});
startRuntimeTimer();

function startRuntimeTimer() {
  clearInterval(runtimeTimerInterval);
  runtimeTimerInterval = setInterval(() => {
    renderRuntimeTimer();
    refreshActiveSongRequestAges();
  }, 1_000);
}

function scheduleRefreshLoop(delay = document.hidden ? 10_000 : 1_500) {
  if (pageLifecycleSuspended) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!document.hidden) await refresh();
    scheduleRefreshLoop();
  }, delay);
}

function scheduleAuthRefreshLoop(delay = el.qrDialog.open ? 1_500 : document.hidden ? 15_000 : 10_000) {
  if (pageLifecycleSuspended) return;
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
  pageLifecycleSuspended = true;
  cancelPendingPlatformScrollRestore();
  platformTransition?.cancel();
  platformTransition = undefined;
  cancelInterfaceMotions();
  cancelClassicVerification();
  for (const search of Object.values(SONG_SEARCHES)) {
    clearTimeout(search.timer);
    search.controller?.abort();
  }
  resultStream?.close();
  clearTimeout(resultRenderTimer);
  clearTimeout(refreshTimer);
  clearTimeout(authRefreshTimer);
  clearInterval(runtimeTimerInterval);
  inspectorOverlayQuery.removeEventListener("change", syncInspectorForViewport);
});
addEventListener("pageshow", (event) => {
  if (!event.persisted || !pageLifecycleSuspended) return;
  pageLifecycleSuspended = false;
  let streamConnected = false;
  if (desiredPlatform !== platform) {
    try {
      streamConnected = commitPlatformSelection(desiredPlatform, platformSwitchVersion, {
        announce: true,
        restoreScroll: capturePlatformScrollState(),
        deferScrollRestore: true,
      });
    } catch {
      desiredPlatform = platform;
      applyPlatformPresentation();
    }
  } else {
    applyPlatformPresentation();
  }
  inspectorOverlayQuery.addEventListener("change", syncInspectorForViewport);
  syncInspectorForViewport();
  startRuntimeTimer();
  scheduleRefreshLoop(0);
  scheduleAuthRefreshLoop(0);
  if (!streamConnected) connectResultStream();
  if (resultsRenderPending) scheduleResultsRender();
});

async function activateTaskTab(tab) {
  const switchVersion = ++tabSwitchVersion;
  selectedTabs[platform] = tab.dataset.tab;
  if (tab.dataset.tab !== "results") cancelPendingPlatformScrollRestore();
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
