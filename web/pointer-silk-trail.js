/*!
 * Follow-trail physics adapted from Makio MeshLine's MIT-licensed demo.
 * Copyright (c) 2025 David Ronai. https://github.com/Makio64/makio-meshline
 */
(() => {
  "use strict";

  const NUM_POINTS = 20;
  const NUM_LINES = 4;
  const VERTICES_PER_LINE = NUM_POINTS * 2;
  const FLOATS_PER_VERTEX = 9;
  const HOLD_MS = 72;
  const FADE_MS = 348;
  const IDLE_STOP_MS = HOLD_MS + FADE_MS;
  const POINTER_DELTA_RESET_MS = 50;
  const MAX_DPR = 1.25;
  const MAX_COLOR_PIXELS = 800_000;
  const MAX_LINE_WIDTH_PX = 11;
  const CAMERA_WORLD_HEIGHT_AT_PLANE = 10.411;
  const CONTEXT_OPTIONS = Object.freeze({
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: true,
    powerPreference: "low-power",
  });
  // Keep the four lines as one compact cursor cluster. The reference demo
  // randomizes a wider range, but those extremes bloom during fast circles
  // in a dense productivity UI, so use four close deterministic samples.
  const SPRINGS = new Float32Array([0.057, 0.06, 0.063, 0.066]);
  const FRICTIONS = new Float32Array([0.85, 0.853, 0.856, 0.859]);
  const RADII = new Float32Array([5, 7, 9, 6]);
  const OFFSET_X = new Float32Array([RADII[0], 0, -RADII[2], 0]);
  const OFFSET_Y = new Float32Array([0, RADII[1], 0, -RADII[3]]);
  const PALETTES = Object.freeze({
    netease: Object.freeze([
      new Float32Array([0.843, 0.275, 0.31]),
      new Float32Array([1, 0.451, 0.408]),
      new Float32Array([0.549, 0.169, 0.212]),
      new Float32Array([0.941, 0.627, 0.6]),
    ]),
    qq: Object.freeze([
      new Float32Array([0.192, 0.761, 0.486]),
      new Float32Array([0.533, 0.91, 0.42]),
      new Float32Array([0.063, 0.482, 0.333]),
      new Float32Array([0.459, 0.902, 0.678]),
    ]),
  });

  const VERTEX_SHADER = `#version 300 es
    precision highp float;
    layout(location = 0) in vec2 a_previous;
    layout(location = 1) in vec2 a_current;
    layout(location = 2) in vec2 a_next;
    layout(location = 3) in float a_side;
    layout(location = 4) in float a_progress;
    layout(location = 5) in float a_lineIndex;

    uniform vec2 u_resolution;
    uniform float u_lineWidth;

    out float v_side;
    out float v_progress;
    flat out int v_lineIndex;

    vec2 safeDirection(vec2 value, vec2 fallbackValue) {
      float magnitude = length(value);
      return magnitude > 0.0001 ? value / magnitude : fallbackValue;
    }

    void main() {
      vec2 incoming = safeDirection(a_current - a_previous, vec2(1.0, 0.0));
      vec2 outgoing = safeDirection(a_next - a_current, incoming);
      vec2 tangent = safeDirection(incoming + outgoing, outgoing);
      vec2 normal = vec2(-tangent.y, tangent.x);
      vec2 incomingNormal = vec2(-incoming.y, incoming.x);
      float miter = clamp(1.0 / max(0.55, dot(normal, incomingNormal)), 1.0, 1.45);
      float edge = 0.1;
      float taper = a_progress < edge
        ? mix(0.1, 1.0, a_progress / edge)
        : (a_progress > 1.0 - edge
          ? mix(0.1, 1.0, (1.0 - a_progress) / edge)
          : 1.0);
      vec2 position = a_current + normal * a_side * u_lineWidth * 0.5 * taper * miter;
      vec2 clip = position / u_resolution * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_side = a_side;
      v_progress = a_progress;
      v_lineIndex = int(a_lineIndex + 0.5);
    }
  `;

  const FRAGMENT_SHADER = `#version 300 es
    precision highp float;

    uniform vec3 u_color0;
    uniform vec3 u_color1;
    uniform vec3 u_color2;
    uniform vec3 u_color3;
    uniform float u_opacity;

    in float v_side;
    in float v_progress;
    flat in int v_lineIndex;
    out vec4 outColor;

    void main() {
      vec3 color = v_lineIndex == 0 ? u_color0
        : (v_lineIndex == 1 ? u_color1
        : (v_lineIndex == 2 ? u_color2 : u_color3));
      color += smoothstep(0.5, 1.0, v_progress) * 0.2;
      float edgeAlpha = 1.0 - smoothstep(0.76, 1.0, abs(v_side));
      float alpha = edgeAlpha * u_opacity;
      outColor = vec4(color * alpha, alpha);
    }
  `;

  function mediaListen(query, listener) {
    if (typeof query.addEventListener === "function") query.addEventListener("change", listener);
    else query.addListener?.(listener);
  }

  function mediaUnlisten(query, listener) {
    if (typeof query.removeEventListener === "function") query.removeEventListener("change", listener);
    else query.removeListener?.(listener);
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("pointer trail shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "pointer trail shader compilation failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(gl) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    let fragmentShader;
    let program;
    try {
      fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error("pointer trail program allocation failed");
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "pointer trail program link failed");
      }
      return program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
    }
  }

  function create({ host, platform = "netease", enabled = true } = {}) {
    if (!host || typeof host.addEventListener !== "function") {
      throw new TypeError("PointerSilkTrail requires a host element");
    }

    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
    const suspensions = new Set();
    const pointXs = new Float32Array(NUM_LINES * NUM_POINTS);
    const pointYs = new Float32Array(NUM_LINES * NUM_POINTS);
    const velocityXs = new Float32Array(NUM_LINES);
    const velocityYs = new Float32Array(NUM_LINES);
    const vertexData = new Float32Array(NUM_LINES * VERTICES_PER_LINE * FLOATS_PER_VERTEX);

    let active = Boolean(enabled);
    let activePlatform = platform === "qq" ? "qq" : "netease";
    let activePalette = PALETTES[activePlatform];
    let destroyed = false;
    let faulted = false;
    let canvas = null;
    let gl = null;
    let program = null;
    let vertexArray = null;
    let vertexBuffer = null;
    let uniforms = null;
    let resizeObserver = null;
    let frame = 0;
    let seeded = false;
    let hostLeft = 0;
    let hostTop = 0;
    let cssWidth = 1;
    let cssHeight = 1;
    let targetX = 0;
    let targetY = 0;
    let previousPointerX = 0;
    let previousPointerY = 0;
    let pointerMoveX = 0;
    let pointerMoveY = 0;
    let lastMoveAt = 0;
    let lastFrameAt = 0;
    let mouseSpeed = 0;
    let lineWidthPx = 1;
    let contextLost = false;

    function eligible() {
      return active && !destroyed && !faulted && suspensions.size === 0
        && !reducedMotion.matches && finePointer.matches && !document.hidden;
    }

    function requireUniform(nextGl, nextProgram, name) {
      const location = nextGl.getUniformLocation(nextProgram, name);
      if (location === null) throw new Error(`pointer trail uniform unavailable: ${name}`);
      return location;
    }

    function releaseGpu(nextGl, nextProgram, nextVertexArray, nextVertexBuffer, wasLost) {
      if (!nextGl || wasLost) return;
      try {
        if (nextVertexBuffer) nextGl.deleteBuffer(nextVertexBuffer);
        if (nextVertexArray) nextGl.deleteVertexArray(nextVertexArray);
        if (nextProgram) nextGl.deleteProgram(nextProgram);
        nextGl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        // Best effort during teardown.
      }
    }

    function releaseSurface(wasLost = contextLost) {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (canvas) canvas.removeEventListener("webglcontextlost", onContextLost);
      releaseGpu(gl, program, vertexArray, vertexBuffer, wasLost);
      canvas?.remove();
      canvas = null;
      gl = null;
      program = null;
      vertexArray = null;
      vertexBuffer = null;
      uniforms = null;
      seeded = false;
      mouseSpeed = 0;
      lineWidthPx = 1;
      contextLost = false;
    }

    function failSurface(wasLost = contextLost) {
      faulted = true;
      releaseSurface(wasLost);
    }

    function clearSurface(resetMotion = true) {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (gl) {
        try {
          gl.clear(gl.COLOR_BUFFER_BIT);
        } catch {
          failSurface();
          return;
        }
      }
      if (resetMotion) {
        seeded = false;
        pointerMoveX = 0;
        pointerMoveY = 0;
        mouseSpeed = 0;
      }
    }

    function refreshGeometry() {
      if (!canvas || !gl) return;
      const rect = host.getBoundingClientRect();
      hostLeft = rect.left;
      hostTop = rect.top;
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      const desiredDpr = Math.min(MAX_DPR, Math.max(1, devicePixelRatio || 1));
      const rawPixels = cssWidth * cssHeight * desiredDpr * desiredDpr;
      const pixelScale = rawPixels > MAX_COLOR_PIXELS
        ? Math.sqrt(MAX_COLOR_PIXELS / rawPixels)
        : 1;
      const renderDpr = desiredDpr * pixelScale;
      canvas.width = Math.max(1, Math.floor(cssWidth * renderDpr));
      canvas.height = Math.max(1, Math.floor(cssHeight * renderDpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, cssWidth, cssHeight);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    function setupSurface() {
      if (canvas || !eligible()) return Boolean(canvas);
      let nextCanvas;
      let nextGl;
      let nextProgram;
      let nextVertexArray;
      let nextVertexBuffer;
      try {
        nextCanvas = document.createElement("canvas");
        nextCanvas.className = "pointer-silk-trail-canvas";
        nextCanvas.setAttribute("aria-hidden", "true");
        nextGl = nextCanvas.getContext("webgl2", CONTEXT_OPTIONS);
        if (!nextGl) throw new Error("WebGL2 unavailable for pointer trail");
        nextProgram = createProgram(nextGl);
        nextVertexArray = nextGl.createVertexArray();
        nextVertexBuffer = nextGl.createBuffer();
        if (!nextVertexArray || !nextVertexBuffer) throw new Error("pointer trail geometry allocation failed");

        nextGl.bindVertexArray(nextVertexArray);
        nextGl.bindBuffer(nextGl.ARRAY_BUFFER, nextVertexBuffer);
        nextGl.bufferData(nextGl.ARRAY_BUFFER, vertexData.byteLength, nextGl.DYNAMIC_DRAW);
        const stride = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
        nextGl.enableVertexAttribArray(0);
        nextGl.vertexAttribPointer(0, 2, nextGl.FLOAT, false, stride, 0);
        nextGl.enableVertexAttribArray(1);
        nextGl.vertexAttribPointer(1, 2, nextGl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
        nextGl.enableVertexAttribArray(2);
        nextGl.vertexAttribPointer(2, 2, nextGl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
        nextGl.enableVertexAttribArray(3);
        nextGl.vertexAttribPointer(3, 1, nextGl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT);
        nextGl.enableVertexAttribArray(4);
        nextGl.vertexAttribPointer(4, 1, nextGl.FLOAT, false, stride, 7 * Float32Array.BYTES_PER_ELEMENT);
        nextGl.enableVertexAttribArray(5);
        nextGl.vertexAttribPointer(5, 1, nextGl.FLOAT, false, stride, 8 * Float32Array.BYTES_PER_ELEMENT);

        const nextUniforms = Object.freeze({
          resolution: requireUniform(nextGl, nextProgram, "u_resolution"),
          lineWidth: requireUniform(nextGl, nextProgram, "u_lineWidth"),
          opacity: requireUniform(nextGl, nextProgram, "u_opacity"),
          colors: Object.freeze([
            requireUniform(nextGl, nextProgram, "u_color0"),
            requireUniform(nextGl, nextProgram, "u_color1"),
            requireUniform(nextGl, nextProgram, "u_color2"),
            requireUniform(nextGl, nextProgram, "u_color3"),
          ]),
        });

        nextGl.disable(nextGl.DEPTH_TEST);
        nextGl.enable(nextGl.BLEND);
        nextGl.blendFunc(nextGl.ONE, nextGl.ONE_MINUS_SRC_ALPHA);
        nextGl.clearColor(0, 0, 0, 0);
        nextCanvas.addEventListener("webglcontextlost", onContextLost);
        host.appendChild(nextCanvas);

        canvas = nextCanvas;
        gl = nextGl;
        program = nextProgram;
        vertexArray = nextVertexArray;
        vertexBuffer = nextVertexBuffer;
        uniforms = nextUniforms;
        resizeObserver = new ResizeObserver(refreshGeometry);
        resizeObserver.observe(host);
        refreshGeometry();
        return true;
      } catch {
        try { nextCanvas?.removeEventListener("webglcontextlost", onContextLost); } catch {}
        releaseGpu(nextGl, nextProgram, nextVertexArray, nextVertexBuffer, false);
        try { nextCanvas?.remove(); } catch {}
        faulted = true;
        return false;
      }
    }

    function seedLines() {
      for (let line = 0; line < NUM_LINES; line += 1) {
        const x = targetX + OFFSET_X[line];
        const y = targetY + OFFSET_Y[line];
        velocityXs[line] = 0;
        velocityYs[line] = 0;
        const pointStart = line * NUM_POINTS;
        for (let point = 0; point < NUM_POINTS; point += 1) {
          pointXs[pointStart + point] = x;
          pointYs[pointStart + point] = y;
        }
      }
      seeded = true;
    }

    function updateLinePhysics() {
      if (!seeded) seedLines();
      for (let line = 0; line < NUM_LINES; line += 1) {
        const pointStart = line * NUM_POINTS;
        const headX = pointXs[pointStart];
        const headY = pointYs[pointStart];
        velocityXs[line] = (velocityXs[line] + (targetX + OFFSET_X[line] - headX) * SPRINGS[line]) * FRICTIONS[line];
        velocityYs[line] = (velocityYs[line] + (targetY + OFFSET_Y[line] - headY) * SPRINGS[line]) * FRICTIONS[line];
        pointXs[pointStart] = headX + velocityXs[line];
        pointYs[pointStart] = headY + velocityYs[line];
        for (let point = 1; point < NUM_POINTS; point += 1) {
          const index = pointStart + point;
          pointXs[index] += (pointXs[index - 1] - pointXs[index]) * 0.9;
          pointYs[index] += (pointYs[index - 1] - pointYs[index]) * 0.9;
        }
      }
    }

    function writeVertexData() {
      let cursor = 0;
      for (let line = 0; line < NUM_LINES; line += 1) {
        const pointStart = line * NUM_POINTS;
        for (let point = 0; point < NUM_POINTS; point += 1) {
          const current = pointStart + point;
          const previous = pointStart + Math.max(0, point - 1);
          const next = pointStart + Math.min(NUM_POINTS - 1, point + 1);
          const progress = point / (NUM_POINTS - 1);
          for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
            vertexData[cursor] = pointXs[previous];
            vertexData[cursor + 1] = pointYs[previous];
            vertexData[cursor + 2] = pointXs[current];
            vertexData[cursor + 3] = pointYs[current];
            vertexData[cursor + 4] = pointXs[next];
            vertexData[cursor + 5] = pointYs[next];
            vertexData[cursor + 6] = sideIndex === 0 ? -1 : 1;
            vertexData[cursor + 7] = progress;
            vertexData[cursor + 8] = line;
            cursor += FLOATS_PER_VERTEX;
          }
        }
      }
    }

    function renderFrame(now) {
      frame = 0;
      try {
        if (!eligible() || !gl || !program || !uniforms || !vertexArray || !vertexBuffer) {
          clearSurface();
          return;
        }
        const idleFor = Math.max(0, now - lastMoveAt);
        if (idleFor >= IDLE_STOP_MS) {
          clearSurface();
          return;
        }
        const dt = Math.max(1, Math.min(100, lastFrameAt ? now - lastFrameAt : 16));
        lastFrameAt = now;
        updateLinePhysics();
        writeVertexData();
        const recentMoveX = idleFor <= POINTER_DELTA_RESET_MS ? pointerMoveX : 0;
        const recentMoveY = idleFor <= POINTER_DELTA_RESET_MS ? pointerMoveY : 0;
        const speed = Math.hypot(recentMoveX, recentMoveY) / (dt / 16 || 1) * 0.01;
        mouseSpeed += (Math.min(1, Math.max(0.01, speed)) - mouseSpeed) * 0.15;
        const responsiveWidth = 1.1 + 12.5 * mouseSpeed / (0.38 + mouseSpeed);
        const viewportScale = Math.min(1, cssHeight / (CAMERA_WORLD_HEIGHT_AT_PLANE * 64));
        const targetWidth = Math.min(MAX_LINE_WIDTH_PX, responsiveWidth * viewportScale);
        lineWidthPx += (targetWidth - lineWidthPx) * 0.15;
        const fade = idleFor <= HOLD_MS ? 1 : 1 - (idleFor - HOLD_MS) / FADE_MS;

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.bindVertexArray(vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData);
        gl.uniform1f(uniforms.lineWidth, lineWidthPx);
        gl.uniform1f(uniforms.opacity, Math.max(0, fade) * 0.48);
        for (let line = 0; line < NUM_LINES; line += 1) {
          gl.uniform3fv(uniforms.colors[line], activePalette[line]);
        }
        for (let line = 0; line < NUM_LINES; line += 1) {
          gl.drawArrays(gl.TRIANGLE_STRIP, line * VERTICES_PER_LINE, VERTICES_PER_LINE);
        }
        schedule();
      } catch {
        failSurface();
      }
    }

    function schedule() {
      if (frame) return;
      try {
        frame = requestAnimationFrame(renderFrame);
      } catch {
        failSurface();
      }
    }

    function onPointerMove(event) {
      if (event.pointerType && event.pointerType !== "mouse") return;
      if (!eligible() || !setupSurface()) return;
      const x = event.clientX - hostLeft;
      const y = event.clientY - hostTop;
      if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) return;
      const now = performance.now();
      pointerMoveX = seeded ? x - previousPointerX : 0;
      pointerMoveY = seeded ? y - previousPointerY : 0;
      previousPointerX = x;
      previousPointerY = y;
      targetX = x;
      targetY = y;
      lastMoveAt = now;
      if (!seeded) seedLines();
      schedule();
    }

    function onHostGeometryChange() {
      if (!canvas || !gl) return;
      try {
        refreshGeometry();
      } catch {
        failSurface();
      }
    }

    function onContextLost() {
      contextLost = true;
      failSurface(true);
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
      host.removeEventListener("pointerenter", onHostGeometryChange);
      window.removeEventListener("scroll", onHostGeometryChange, true);
      mediaUnlisten(reducedMotion, onCapabilityChange);
      mediaUnlisten(finePointer, onCapabilityChange);
      suspensions.clear();
    }

    host.addEventListener("pointermove", onPointerMove, { passive: true });
    host.addEventListener("pointerenter", onHostGeometryChange, { passive: true });
    window.addEventListener("scroll", onHostGeometryChange, { passive: true, capture: true });
    mediaListen(reducedMotion, onCapabilityChange);
    mediaListen(finePointer, onCapabilityChange);

    return Object.freeze({ setEnabled, setPlatform, suspend, resume, destroy });
  }

  globalThis.PointerSilkTrail = Object.freeze({ create });
})();
