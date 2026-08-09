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
  const AMBIENT_SIZE = 148;
  const RING_SIZE = 88;
  const PALETTES = Object.freeze({
    netease: Object.freeze({
      primary: "#c83f49",
      secondary: "#8d7476",
      highlight: "#e7b1a9",
      glow: "rgba(196, 54, 66, 0.18)",
      ring: "rgba(231, 177, 169, 0.72)",
    }),
    qq: Object.freeze({
      primary: "#107b55",
      secondary: "#66736c",
      highlight: "#8fd5b2",
      glow: "rgba(49, 194, 124, 0.16)",
      ring: "rgba(143, 213, 178, 0.70)",
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
    const speeds = new Float32Array(SAMPLE_CAPACITY);
    const normalXs = new Float32Array(SAMPLE_CAPACITY);
    const normalYs = new Float32Array(SAMPLE_CAPACITY);
    const times = new Float64Array(SAMPLE_CAPACITY);
    let activePlatform = platform === "qq" ? "qq" : "netease";
    let activePalette = PALETTES[activePlatform];
    let active = Boolean(enabled);
    let faulted = false;
    let destroyed = false;
    let canvas;
    let context;
    let ambientCanvas;
    let ringCanvas;
    let resizeObserver;
    let frame = 0;
    let head = 0;
    let count = 0;
    let lastMoveAt = -Infinity;
    let lastSampleAt = -Infinity;
    let lastX = 0;
    let lastY = 0;
    let haloX = 0;
    let haloY = 0;
    let haloAngle = 0;
    let haloSpeed = 0;
    let lastFrameAt = -Infinity;
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
      lastFrameAt = -Infinity;
      haloSpeed = 0;
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
      ambientCanvas = undefined;
      ringCanvas = undefined;
      geometryDirty = true;
    }

    function failSurface() {
      faulted = true;
      releaseSurface();
    }

    function buildLightSprites() {
      if (!context) return;
      const nextAmbient = document.createElement("canvas");
      nextAmbient.width = AMBIENT_SIZE;
      nextAmbient.height = AMBIENT_SIZE;
      const ambientContext = nextAmbient.getContext("2d", { alpha: true });
      if (!ambientContext) return;
      const ambientCenter = AMBIENT_SIZE * 0.5;
      const gradient = ambientContext.createRadialGradient(ambientCenter, ambientCenter, 0, ambientCenter, ambientCenter, ambientCenter);
      gradient.addColorStop(0, activePalette.glow);
      gradient.addColorStop(0.34, activePalette.glow);
      gradient.addColorStop(0.68, "rgba(0, 0, 0, 0.025)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ambientContext.fillStyle = gradient;
      ambientContext.fillRect(0, 0, AMBIENT_SIZE, AMBIENT_SIZE);

      const nextRing = document.createElement("canvas");
      nextRing.width = RING_SIZE;
      nextRing.height = RING_SIZE;
      const ringContext = nextRing.getContext("2d", { alpha: true });
      if (!ringContext || typeof ringContext.ellipse !== "function") return;
      const ringCenter = RING_SIZE * 0.5;
      ringContext.lineCap = "round";
      ringContext.strokeStyle = activePalette.ring;
      ringContext.lineWidth = 1.25;
      ringContext.beginPath();
      ringContext.ellipse(ringCenter, ringCenter, 22, 13, 0, -1.05, 2.05);
      ringContext.stroke();
      ringContext.globalAlpha = 0.42;
      ringContext.strokeStyle = activePalette.primary;
      ringContext.lineWidth = 0.75;
      ringContext.beginPath();
      ringContext.ellipse(ringCenter, ringCenter, 28, 17, 0, 2.45, 5.15);
      ringContext.stroke();
      ambientCanvas = nextAmbient;
      ringCanvas = nextRing;
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
          geometryDirty = true;
          if (count > 0 && eligible()) schedule();
        }) : undefined;
        resizeObserver?.observe(host);
        refreshGeometry();
        buildLightSprites();
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

    function updateNormals(now) {
      for (let order = 0; order < count; order += 1) {
        const index = sampleIndex(order);
        if (now - times[index] > SAMPLE_LIFETIME_MS) continue;
        const before = sampleIndex(Math.max(0, order - 1));
        const after = sampleIndex(Math.min(count - 1, order + 1));
        const tangentX = xs[after] - xs[before];
        const tangentY = ys[after] - ys[before];
        const tangentLength = Math.max(0.001, Math.hypot(tangentX, tangentY));
        normalXs[index] = -tangentY / tangentLength;
        normalYs[index] = tangentX / tangentLength;
      }
    }

    function strokeRibbon(now, offset, color, width, opacity) {
      let started = false;
      let previousX = 0;
      let previousY = 0;
      context.beginPath();
      for (let order = 0; order < count; order += 1) {
        const index = sampleIndex(order);
        if (now - times[index] > SAMPLE_LIFETIME_MS) continue;
        const spread = offset * (0.62 + speeds[index] * 0.38);
        const x = xs[index] + normalXs[index] * spread;
        const y = ys[index] + normalYs[index] * spread;
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
        if (geometryDirty) refreshGeometry();
        const idleFor = Math.max(0, now - lastMoveAt);
        if (idleFor >= IDLE_STOP_MS) {
          clearSurface();
          return;
        }
        const fade = idleFor <= HOLD_MS ? 1 : 1 - (idleFor - HOLD_MS) / FADE_MS;
        const frameDelta = Number.isFinite(lastFrameAt) ? Math.min(40, Math.max(0, now - lastFrameAt)) : 16;
        const follow = Math.min(0.46, 0.20 + frameDelta * 0.008);
        haloX += (lastX - haloX) * follow;
        haloY += (lastY - haloY) * follow;
        lastFrameAt = now;
        context.clearRect(0, 0, cssWidth, cssHeight);
        context.globalCompositeOperation = "source-over";
        if (ambientCanvas) {
          context.globalAlpha = (0.14 + haloSpeed * 0.04) * fade;
          context.drawImage(ambientCanvas, haloX - AMBIENT_SIZE * 0.5, haloY - AMBIENT_SIZE * 0.5, AMBIENT_SIZE, AMBIENT_SIZE);
        }
        if (count > 1) {
          updateNormals(now);
          strokeRibbon(now, 0, activePalette.primary, 2.4, 0.16 * fade);
          strokeRibbon(now, 2.15, activePalette.secondary, 0.92, 0.20 * fade);
          strokeRibbon(now, -1.65, activePalette.highlight, 0.58, 0.17 * fade);
        }
        if (ringCanvas && typeof context.save === "function") {
          const ringScale = 0.90 + haloSpeed * 0.16;
          context.save();
          context.translate(haloX, haloY);
          context.rotate(haloAngle);
          context.scale(ringScale, 0.92 + haloSpeed * 0.08);
          context.globalAlpha = 0.34 * fade;
          context.drawImage(ringCanvas, -RING_SIZE * 0.5, -RING_SIZE * 0.5, RING_SIZE, RING_SIZE);
          context.restore();
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
      const dx = count > 0 ? x - lastX : 0;
      const dy = count > 0 ? y - lastY : 0;
      const elapsed = Math.max(8, now - lastSampleAt);
      const distance = Math.hypot(dx, dy);
      const speed = Math.min(1, distance / elapsed * 0.72);
      xs[head] = x;
      ys[head] = y;
      speeds[head] = speed;
      times[head] = now;
      head = (head + 1) % SAMPLE_CAPACITY;
      count = Math.min(SAMPLE_CAPACITY, count + 1);
      lastX = x;
      lastY = y;
      if (count === 1) {
        haloX = x;
        haloY = y;
      }
      if (distance > 0.5) haloAngle = Math.atan2(dy, dx);
      haloSpeed = haloSpeed * 0.56 + speed * 0.44;
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
        try { buildLightSprites(); } catch { failSurface(); }
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
