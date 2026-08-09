(() => {
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
  const FINE_POINTER = "(pointer: fine)";
  const SAMPLE_CAPACITY = 28;
  const SAMPLE_LIFETIME_MS = 260;
  const HOLD_MS = 72;
  const FADE_MS = 348;
  const IDLE_STOP_MS = HOLD_MS + FADE_MS;
  const MAX_DPR = 1.25;
  const MAX_COLOR_PIXELS = 800_000;
  const GLOW_SIZE = 112;
  const PALETTES = Object.freeze({
    netease: Object.freeze({
      primary: "#c83f49",
      secondary: "#8d7476",
      highlight: "#e7b1a9",
      glow: "rgba(196, 54, 66, 0.22)",
    }),
    qq: Object.freeze({
      primary: "#107b55",
      secondary: "#66736c",
      highlight: "#8fd5b2",
      glow: "rgba(49, 194, 124, 0.20)",
    }),
  });

  function safely(operation) {
    try { operation(); } catch { /* Best-effort visual teardown. */ }
  }

  function mediaListen(query, listener) {
    if (typeof query.addEventListener === "function") query.addEventListener("change", listener);
    else query.addListener?.(listener);
  }

  function mediaUnlisten(query, listener) {
    if (typeof query.removeEventListener === "function") query.removeEventListener("change", listener);
    else query.removeListener?.(listener);
  }

  function create({ host, platform = "netease", enabled = true } = {}) {
    if (!host || typeof host.addEventListener !== "function") throw new TypeError("PointerSilkTrail requires a host element");

    const reducedMotion = matchMedia(REDUCED_MOTION);
    const finePointer = matchMedia(FINE_POINTER);
    const suspensions = new Set();
    const xs = new Float32Array(SAMPLE_CAPACITY);
    const ys = new Float32Array(SAMPLE_CAPACITY);
    const times = new Float64Array(SAMPLE_CAPACITY);
    let activePlatform = platform === "qq" ? "qq" : "netease";
    let activePalette = PALETTES[activePlatform];
    let active = Boolean(enabled);
    let faulted = false;
    let destroyed = false;
    let canvas;
    let context;
    let glowCanvas;
    let resizeObserver;
    let frame = 0;
    let head = 0;
    let count = 0;
    let lastMoveAt = -Infinity;
    let lastSampleAt = -Infinity;
    let lastX = 0;
    let lastY = 0;
    let hostLeft = 0;
    let hostTop = 0;
    let cssWidth = 1;
    let cssHeight = 1;
    let renderScale = 1;
    let geometryDirty = true;

    function eligible() {
      return active
        && !destroyed
        && !faulted
        && suspensions.size === 0
        && !document.hidden
        && !reducedMotion.matches
        && finePointer.matches;
    }

    function stopFrame() {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    }

    function clearSamples() {
      head = 0;
      count = 0;
      lastMoveAt = -Infinity;
      lastSampleAt = -Infinity;
    }

    function clearSurface() {
      stopFrame();
      clearSamples();
      if (context) safely(() => context.clearRect(0, 0, cssWidth, cssHeight));
    }

    function releaseSurface() {
      clearSurface();
      safely(() => resizeObserver?.disconnect());
      resizeObserver = undefined;
      safely(() => canvas?.remove());
      canvas = undefined;
      context = undefined;
      glowCanvas = undefined;
      geometryDirty = true;
    }

    function failSurface() {
      faulted = true;
      releaseSurface();
    }

    function buildGlow() {
      if (!context) return;
      const nextGlow = document.createElement("canvas");
      nextGlow.width = GLOW_SIZE;
      nextGlow.height = GLOW_SIZE;
      const glowContext = nextGlow.getContext("2d", { alpha: true });
      if (!glowContext) return;
      const center = GLOW_SIZE * 0.5;
      const gradient = glowContext.createRadialGradient(center, center, 0, center, center, center);
      gradient.addColorStop(0, activePalette.glow);
      gradient.addColorStop(0.42, activePalette.glow);
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      glowContext.fillStyle = gradient;
      glowContext.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
      glowCanvas = nextGlow;
    }

    function refreshGeometry() {
      if (!canvas || !context) return;
      const rect = host.getBoundingClientRect();
      hostLeft = rect.left;
      hostTop = rect.top;
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      const dpr = Math.min(MAX_DPR, Math.max(1, Number(devicePixelRatio) || 1));
      const rawPixels = cssWidth * cssHeight * dpr * dpr;
      const budgetScale = rawPixels > MAX_COLOR_PIXELS ? Math.sqrt(MAX_COLOR_PIXELS / rawPixels) : 1;
      renderScale = dpr * budgetScale;
      canvas.width = Math.max(1, Math.floor(cssWidth * renderScale));
      canvas.height = Math.max(1, Math.floor(cssHeight * renderScale));
      context.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      context.lineCap = "round";
      context.lineJoin = "round";
      geometryDirty = false;
    }

    function ensureSurface() {
      if (canvas) return true;
      const nextCanvas = document.createElement("canvas");
      try {
        nextCanvas.className = "pointer-silk-trail-canvas";
        nextCanvas.setAttribute("aria-hidden", "true");
        const nextContext = nextCanvas.getContext("2d", { alpha: true, desynchronized: true });
        if (!nextContext) {
          safely(() => nextCanvas.remove());
          failSurface();
          return false;
        }
        canvas = nextCanvas;
        context = nextContext;
        host.appendChild(canvas);
        resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
          try { refreshGeometry(); } catch { failSurface(); }
        }) : undefined;
        resizeObserver?.observe(host);
        refreshGeometry();
        buildGlow();
        return true;
      } catch {
        safely(() => nextCanvas.remove());
        failSurface();
        return false;
      }
    }

    function sampleIndex(order) {
      return (head - count + order + SAMPLE_CAPACITY) % SAMPLE_CAPACITY;
    }

    function strokeRibbon(now, offset, color, width, opacity) {
      let started = false;
      let previousX = 0;
      let previousY = 0;
      context.beginPath();
      for (let order = 0; order < count; order += 1) {
        const index = sampleIndex(order);
        if (now - times[index] > SAMPLE_LIFETIME_MS) continue;
        const wave = Math.sin(order * 0.78 + offset * 0.31) * offset;
        const x = xs[index] + wave;
        const y = ys[index] + Math.cos(order * 0.62 + offset) * offset * 0.46;
        if (!started) {
          context.moveTo(x, y);
          started = true;
        } else {
          context.quadraticCurveTo(previousX, previousY, (previousX + x) * 0.5, (previousY + y) * 0.5);
        }
        previousX = x;
        previousY = y;
      }
      if (!started) return;
      context.lineTo(previousX, previousY);
      context.strokeStyle = color;
      context.lineWidth = width;
      context.globalAlpha = opacity;
      context.stroke();
    }

    function draw(now) {
      frame = 0;
      try {
        if (!eligible() || !context || count < 1) {
          clearSurface();
          return;
        }
        const idleFor = Math.max(0, now - lastMoveAt);
        if (idleFor >= IDLE_STOP_MS) {
          clearSurface();
          return;
        }
        const fade = idleFor <= HOLD_MS ? 1 : 1 - (idleFor - HOLD_MS) / FADE_MS;
        context.clearRect(0, 0, cssWidth, cssHeight);
        context.globalCompositeOperation = "source-over";
        if (glowCanvas) {
          context.globalAlpha = 0.20 * fade;
          context.drawImage(glowCanvas, lastX - GLOW_SIZE * 0.5, lastY - GLOW_SIZE * 0.5, GLOW_SIZE, GLOW_SIZE);
        }
        if (count > 1) {
          strokeRibbon(now, 0, activePalette.primary, 1.55, 0.28 * fade);
          strokeRibbon(now, 2.4, activePalette.secondary, 0.95, 0.18 * fade);
          strokeRibbon(now, -2.1, activePalette.highlight, 0.62, 0.13 * fade);
        }
        context.globalAlpha = 1;
        schedule();
      } catch {
        failSurface();
      }
    }

    function schedule() {
      if (frame) return;
      try { frame = requestAnimationFrame(draw); }
      catch { failSurface(); }
    }

    function pushPoint(x, y, now) {
      if (count > 0) {
        const dx = x - lastX;
        const dy = y - lastY;
        if (dx * dx + dy * dy < 4 && now - lastSampleAt < 18) {
          lastMoveAt = now;
          schedule();
          return;
        }
      }
      xs[head] = x;
      ys[head] = y;
      times[head] = now;
      head = (head + 1) % SAMPLE_CAPACITY;
      count = Math.min(SAMPLE_CAPACITY, count + 1);
      lastX = x;
      lastY = y;
      lastSampleAt = now;
      lastMoveAt = now;
      schedule();
    }

    function onPointerMove(event) {
      if (event.pointerType && event.pointerType !== "mouse") return;
      if (!eligible()) return;
      try {
        if (!ensureSurface()) return;
        if (geometryDirty) refreshGeometry();
        const x = event.clientX - hostLeft;
        const y = event.clientY - hostTop;
        if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) return;
        pushPoint(x, y, performance.now());
      } catch {
        failSurface();
      }
    }

    function markGeometryDirty() {
      geometryDirty = true;
    }

    function onCapabilityChange() {
      if (!eligible()) releaseSurface();
    }

    function setEnabled(value) {
      const next = Boolean(value);
      if (next && !active) faulted = false;
      active = next;
      if (!active) releaseSurface();
    }

    function setPlatform(value) {
      const next = value === "qq" ? "qq" : "netease";
      if (next === activePlatform) return;
      activePlatform = next;
      activePalette = PALETTES[next];
      clearSurface();
      if (context) {
        try { buildGlow(); } catch { failSurface(); }
      }
    }

    function suspend(reason = "manual") {
      suspensions.add(String(reason));
      clearSurface();
    }

    function resume(reason = "manual") {
      suspensions.delete(String(reason));
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      releaseSurface();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerenter", markGeometryDirty);
      window.removeEventListener("scroll", markGeometryDirty, true);
      mediaUnlisten(reducedMotion, onCapabilityChange);
      mediaUnlisten(finePointer, onCapabilityChange);
      suspensions.clear();
    }

    host.addEventListener("pointermove", onPointerMove, { passive: true });
    host.addEventListener("pointerenter", markGeometryDirty, { passive: true });
    window.addEventListener("scroll", markGeometryDirty, { passive: true, capture: true });
    mediaListen(reducedMotion, onCapabilityChange);
    mediaListen(finePointer, onCapabilityChange);

    return Object.freeze({ setEnabled, setPlatform, suspend, resume, destroy });
  }

  globalThis.PointerSilkTrail = Object.freeze({ create });
})();
