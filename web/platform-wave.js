(() => {
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
  const DURATION_MS = 680;
  const COVER_START_MS = 90;
  const COMMIT_MS = 326;
  const REVEAL_END_MS = 590;
  const MAX_DPR = 1.25;
  const MAX_COLOR_PIXELS = 1_600_000;
  const COLORS = {
    netease: {
      accent: new Float32Array([0.875, 0.180, 0.216]),
      matte: new Float32Array([0.060, 0.061, 0.066]),
    },
    qq: {
      accent: new Float32Array([0.039, 0.694, 0.588]),
      matte: new Float32Array([0.018, 0.075, 0.072]),
    },
  };
  const NEUTRAL_MATTE = new Float32Array([0.075, 0.078, 0.082]);

  const VERTEX_SOURCE = `#version 300 es
    precision highp float;
    out vec2 v_uv;
    void main() {
      vec2 position = vec2(
        gl_VertexID == 1 ? 3.0 : -1.0,
        gl_VertexID == 2 ? 3.0 : -1.0
      );
      v_uv = position * 0.5 + 0.5;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SOURCE = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    uniform vec2 u_resolution;
    uniform vec2 u_sourceAnchor;
    uniform vec2 u_targetAnchor;
    uniform vec3 u_sourceAccent;
    uniform vec3 u_targetAccent;
    uniform vec3 u_sourceMatte;
    uniform vec3 u_targetMatte;
    uniform vec3 u_neutralMatte;
    uniform float u_direction;
    uniform float u_elapsedMs;
    out vec4 outColor;

    const float ATTACK_END = ${COVER_START_MS}.0;
    const float COVER_END = ${COMMIT_MS}.0;
    const float REVEAL_END = ${REVEAL_END_MS}.0;
    const float RELEASE_END = ${DURATION_MS}.0;

    float easeInOut(float value) {
      value = clamp(value, 0.0, 1.0);
      return value * value * (3.0 - 2.0 * value);
    }

    float lineMask(float distanceToLine, float halfWidth) {
      float aa = max(fwidth(distanceToLine), 0.00045);
      return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(distanceToLine));
    }

    void main() {
      float elapsedMs = u_elapsedMs;
      float aspect = u_resolution.x / max(1.0, u_resolution.y);
      vec2 centered = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);
      float axis = u_direction > 0.0 ? v_uv.x : 1.0 - v_uv.x;
      float crossAxis = centered.y;
      float alpha = 0.0;
      vec3 color = u_neutralMatte;

      if (elapsedMs < ATTACK_END) {
        float attack = easeInOut(elapsedMs / ATTACK_END);
        float sourceAxis = u_direction > 0.0 ? u_sourceAnchor.x : 1.0 - u_sourceAnchor.x;
        float carrierAxis = mix(sourceAxis, -0.018, attack);
        float carrier = lineMask(axis - carrierAxis, 0.0012 + attack * 0.0008);
        float verticalFocus = exp(-abs(v_uv.y - (1.0 - u_sourceAnchor.y)) * 7.0);
        alpha = carrier * mix(0.45, 0.92, attack) * mix(0.58, 1.0, verticalFocus);
        color = mix(u_sourceAccent, u_neutralMatte, attack * 0.38);
      } else if (elapsedMs < COVER_END) {
        float covering = easeInOut((elapsedMs - ATTACK_END) / (COVER_END - ATTACK_END));
        float front = mix(-0.035, 1.055, covering);
        float edgeWave = sin(crossAxis * 25.0 + covering * 2.6) * 0.007
          + sin(crossAxis * 53.0 - covering * 1.9) * 0.003;
        float signedEdge = axis - front - edgeWave;
        float aa = max(fwidth(signedEdge), 0.0007);
        float curtain = 1.0 - smoothstep(-aa, aa, signedEdge);
        float contours = 0.0;
        for (int contourIndex = 0; contourIndex < 5; contourIndex += 1) {
          float offset = 0.018 + float(contourIndex) * 0.023;
          float spectral = front - offset
            + sin(crossAxis * (18.0 + float(contourIndex) * 4.0) + float(contourIndex) * 1.7) * 0.0045;
          contours += lineMask(axis - spectral, 0.00065) * (1.0 - float(contourIndex) * 0.12);
        }
        float handoff = lineMask(signedEdge, 0.00135);
        alpha = clamp(curtain + contours * curtain * 0.20 + handoff * 0.36, 0.0, 1.0);
        vec3 matte = mix(u_sourceMatte, u_neutralMatte, covering);
        color = mix(matte, mix(u_sourceAccent, u_neutralMatte, covering), clamp(contours * 0.23 + handoff * 0.50, 0.0, 1.0));
      } else if (elapsedMs >= COVER_END && elapsedMs <= COVER_END + 0.5) {
        alpha = 1.0;
        color = u_neutralMatte;
      } else if (elapsedMs < REVEAL_END) {
        float revealing = easeInOut((elapsedMs - COVER_END) / (REVEAL_END - COVER_END));
        float front = mix(-0.055, 1.055, revealing);
        float edgeWave = sin(crossAxis * 27.0 - revealing * 2.4) * 0.006
          + sin(crossAxis * 49.0 + revealing * 2.1) * 0.0025;
        float signedEdge = axis - front - edgeWave;
        float aa = max(fwidth(signedEdge), 0.0007);
        float curtain = smoothstep(-aa, aa, signedEdge);
        float contours = 0.0;
        for (int contourIndex = 0; contourIndex < 5; contourIndex += 1) {
          float offset = 0.016 + float(contourIndex) * 0.022;
          float spectral = front + offset
            + sin(crossAxis * (19.0 + float(contourIndex) * 3.5) - float(contourIndex) * 1.5) * 0.004;
          contours += lineMask(axis - spectral, 0.00065) * (1.0 - float(contourIndex) * 0.12);
        }
        float handoff = lineMask(signedEdge, 0.00135);
        alpha = clamp(curtain + contours * curtain * 0.20 + handoff * 0.34, 0.0, 1.0);
        vec3 matte = mix(u_neutralMatte, u_targetMatte, revealing);
        color = mix(matte, mix(u_neutralMatte, u_targetAccent, revealing), clamp(contours * 0.22 + handoff * 0.48, 0.0, 1.0));
      } else {
        float release = easeInOut((elapsedMs - REVEAL_END) / (RELEASE_END - REVEAL_END));
        float targetAxis = u_direction > 0.0 ? u_targetAnchor.x : 1.0 - u_targetAnchor.x;
        float carrierOne = mix(1.018, targetAxis, release);
        float carrierTwo = mix(1.036, targetAxis, release);
        float lineOne = lineMask(axis - carrierOne, 0.00075);
        float lineTwo = lineMask(axis - carrierTwo, 0.00055);
        float verticalFocus = exp(-abs(v_uv.y - (1.0 - u_targetAnchor.y)) * mix(2.8, 10.0, release));
        alpha = (lineOne * 0.82 + lineTwo * 0.62) * (1.0 - release * 0.90) * mix(0.55, 1.0, verticalFocus);
        color = u_targetAccent;
      }

      alpha = clamp(alpha, 0.0, 1.0);
      outColor = vec4(color * alpha, alpha);
    }
  `;

  function safely(operation) {
    try { operation(); } catch { /* Best-effort renderer teardown. */ }
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL shader allocation failed");
    try {
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compilation failed");
      }
      return shader;
    } catch (error) {
      safely(() => gl.deleteShader(shader));
      throw error;
    }
  }

  function createProgram(gl) {
    const activeProgram = gl.createProgram();
    if (!activeProgram) throw new Error("WebGL program allocation failed");
    let vertexShader;
    let fragmentShader;
    try {
      vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
      fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
      gl.attachShader(activeProgram, vertexShader);
      gl.attachShader(activeProgram, fragmentShader);
      gl.linkProgram(activeProgram);
      if (!gl.getProgramParameter(activeProgram, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(activeProgram) || "WebGL program link failed");
      }
      return activeProgram;
    } catch (error) {
      safely(() => gl.deleteProgram(activeProgram));
      throw error;
    } finally {
      if (vertexShader) safely(() => gl.deleteShader(vertexShader));
      if (fragmentShader) safely(() => gl.deleteShader(fragmentShader));
    }
  }

  function immediate(commit) {
    let committed = false;
    let commitError;
    try { committed = commit() === true; } catch (error) { commitError = error; }
    return {
      finished: Promise.resolve({ committed, completed: true, renderer: "none", commitError }),
      cancel() {},
    };
  }

  function location(gl, activeProgram, name) {
    return gl.getUniformLocation(activeProgram, name);
  }

  function boundedAnchor(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
  }

  function create(options) {
    const commit = typeof options?.commit === "function" ? options.commit : () => true;
    let motion;
    try {
      motion = matchMedia(REDUCED_MOTION);
      if (motion.matches || document.hidden || typeof WebGL2RenderingContext === "undefined") {
        return immediate(commit);
      }
    } catch {
      return immediate(commit);
    }

    const canvas = document.createElement("canvas");
    canvas.className = "platform-transition-canvas platform-wave-canvas";
    canvas.setAttribute("aria-hidden", "true");
    let gl;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        premultipliedAlpha: true,
        powerPreference: "low-power",
      });
    } catch {
      safely(() => canvas.remove());
      return immediate(commit);
    }
    if (!gl) {
      safely(() => canvas.remove());
      return immediate(commit);
    }

    const sourceTheme = COLORS[options?.sourcePlatform] || COLORS.netease;
    const targetTheme = COLORS[options?.targetPlatform] || COLORS.qq;
    const direction = Number(options?.direction) < 0 ? -1 : 1;
    const sourceAnchorX = boundedAnchor(options?.sourceAnchor?.x, 0.25);
    const sourceAnchorY = boundedAnchor(options?.sourceAnchor?.y, 0.04);
    const targetAnchorX = boundedAnchor(options?.targetAnchor?.x, 0.75);
    const targetAnchorY = boundedAnchor(options?.targetAnchor?.y, 0.04);
    let activeProgram;
    let vertexArray;
    let elapsedLocation;
    let resolutionLocation;
    let frame;
    let startedAt;
    let settled = false;
    let committed = false;
    let commitAttempted = false;
    let commitError;
    let contextLost = false;
    let resolveFinished;
    let state = "idle";
    const finished = new Promise((resolve) => { resolveFinished = resolve; });

    function releaseContext() {
      if (contextLost) return;
      safely(() => gl.getExtension?.("WEBGL_lose_context")?.loseContext());
    }

    function releaseSetup() {
      if (!contextLost) {
        if (vertexArray) safely(() => gl.deleteVertexArray(vertexArray));
        if (activeProgram) safely(() => gl.deleteProgram(activeProgram));
      }
      releaseContext();
      safely(() => { canvas.width = 1; canvas.height = 1; });
      safely(() => canvas.remove());
    }

    function resize() {
      const cssWidth = Math.max(1, Number(innerWidth) || 1);
      const cssHeight = Math.max(1, Number(innerHeight) || 1);
      const dpr = Math.min(MAX_DPR, Math.max(1, Number(devicePixelRatio) || 1));
      const rawWidth = Math.max(1, Math.round(cssWidth * dpr));
      const rawHeight = Math.max(1, Math.round(cssHeight * dpr));
      const rawPixels = rawWidth * rawHeight;
      const scale = rawPixels > MAX_COLOR_PIXELS ? Math.sqrt(MAX_COLOR_PIXELS / rawPixels) : 1;
      const pixelWidth = Math.max(1, Math.floor(rawWidth * scale));
      const pixelHeight = Math.max(1, Math.floor(rawHeight * scale));
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      if (resolutionLocation !== null) gl.uniform2f(resolutionLocation, pixelWidth, pixelHeight);
    }

    try {
      state = "preparing";
      activeProgram = createProgram(gl);
      vertexArray = gl.createVertexArray();
      if (!vertexArray) throw new Error("WebGL vertex array allocation failed");
      gl.useProgram(activeProgram);
      gl.bindVertexArray(vertexArray);
      elapsedLocation = location(gl, activeProgram, "u_elapsedMs");
      resolutionLocation = location(gl, activeProgram, "u_resolution");
      const directionLocation = location(gl, activeProgram, "u_direction");
      const sourceAnchorLocation = location(gl, activeProgram, "u_sourceAnchor");
      const targetAnchorLocation = location(gl, activeProgram, "u_targetAnchor");
      const sourceAccentLocation = location(gl, activeProgram, "u_sourceAccent");
      const targetAccentLocation = location(gl, activeProgram, "u_targetAccent");
      const sourceMatteLocation = location(gl, activeProgram, "u_sourceMatte");
      const targetMatteLocation = location(gl, activeProgram, "u_targetMatte");
      const neutralMatteLocation = location(gl, activeProgram, "u_neutralMatte");
      if (directionLocation !== null) gl.uniform1f(directionLocation, direction);
      if (sourceAnchorLocation !== null) gl.uniform2f(sourceAnchorLocation, sourceAnchorX, sourceAnchorY);
      if (targetAnchorLocation !== null) gl.uniform2f(targetAnchorLocation, targetAnchorX, targetAnchorY);
      if (sourceAccentLocation !== null) gl.uniform3fv(sourceAccentLocation, sourceTheme.accent);
      if (targetAccentLocation !== null) gl.uniform3fv(targetAccentLocation, targetTheme.accent);
      if (sourceMatteLocation !== null) gl.uniform3fv(sourceMatteLocation, sourceTheme.matte);
      if (targetMatteLocation !== null) gl.uniform3fv(targetMatteLocation, targetTheme.matte);
      if (neutralMatteLocation !== null) gl.uniform3fv(neutralMatteLocation, NEUTRAL_MATTE);
      resize();
      canvas.addEventListener("webglcontextlost", onContextLost);
      document.addEventListener("visibilitychange", onVisibility);
      motion.addEventListener("change", onMotionPreference);
      addEventListener("resize", onResize);
      addEventListener("pagehide", onPageHide);
      document.body.append(canvas);
      document.body.classList.add("platform-switching");
      document.body.setAttribute("aria-busy", "true");
      state = "covering";
    } catch {
      safely(() => canvas.removeEventListener("webglcontextlost", onContextLost));
      safely(() => document.removeEventListener("visibilitychange", onVisibility));
      safely(() => motion.removeEventListener("change", onMotionPreference));
      safely(() => removeEventListener("resize", onResize));
      safely(() => removeEventListener("pagehide", onPageHide));
      safely(() => document.body.classList.remove("platform-switching"));
      safely(() => document.body.removeAttribute("aria-busy"));
      releaseSetup();
      return immediate(commit);
    }

    function cleanup() {
      if (frame !== undefined) safely(() => cancelAnimationFrame(frame));
      safely(() => canvas.removeEventListener("webglcontextlost", onContextLost));
      safely(() => document.removeEventListener("visibilitychange", onVisibility));
      safely(() => motion.removeEventListener("change", onMotionPreference));
      safely(() => removeEventListener("resize", onResize));
      safely(() => removeEventListener("pagehide", onPageHide));
      safely(() => document.body.classList.remove("platform-switching"));
      safely(() => document.body.removeAttribute("aria-busy"));
      releaseSetup();
    }

    function invokeCommit() {
      if (commitAttempted) return;
      commitAttempted = true;
      state = "covered/commit";
      try {
        committed = commit() === true;
      } catch (error) {
        commitError = error;
        committed = false;
      }
      state = "revealing";
    }

    function settle(completed) {
      if (settled) return;
      settled = true;
      if (completed && !commitAttempted) invokeCommit();
      state = "settled";
      try {
        cleanup();
      } finally {
        resolveFinished({ committed, completed, renderer: "webgl2", commitError });
      }
    }

    function drawAt(elapsedMs) {
      if (elapsedLocation !== null) gl.uniform1f(elapsedLocation, elapsedMs);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function drawFrame(now) {
      if (settled) return;
      if (startedAt === undefined) startedAt = now;
      const elapsedMs = Math.min(DURATION_MS, Math.max(0, now - startedAt));
      try {
        if (!commitAttempted && elapsedMs >= COMMIT_MS) {
          drawAt(COMMIT_MS);
          invokeCommit();
          if (!committed) {
            settle(true);
            return;
          }
          if (elapsedMs >= DURATION_MS) {
            settle(true);
            return;
          }
        } else {
          drawAt(elapsedMs);
          if (elapsedMs >= DURATION_MS) {
            settle(true);
            return;
          }
        }
        frame = requestAnimationFrame(drawFrame);
      } catch {
        settle(true);
      }
    }

    function onResize() {
      if (settled) return;
      try { resize(); } catch { settle(true); }
    }

    function onVisibility() {
      if (document.hidden) settle(true);
    }

    function onMotionPreference(event) {
      if (event.matches) settle(true);
    }

    function onContextLost(event) {
      event.preventDefault();
      if (settled) return;
      contextLost = true;
      settle(true);
    }

    function onPageHide() {
      settle(false);
    }

    try {
      frame = requestAnimationFrame(drawFrame);
    } catch {
      settle(true);
    }
    return {
      finished,
      cancel() { settle(false); },
    };
  }

  globalThis.PlatformWaveTransition = Object.freeze({ create });
})();
