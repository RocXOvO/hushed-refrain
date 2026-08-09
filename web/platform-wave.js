(() => {
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
  const DURATION_MS = 680;
  const COMMIT_MS = 326;
  const FULLY_COVERED_MS = 244;
  const REVEAL_START_MS = 404;
  const MAX_DPR = 1.25;
  const MAX_COLOR_PIXELS = 1_200_000;
  const COLORS = {
    netease: {
      accent: new Float32Array([0.965, 0.210, 0.265]),
      sheen: new Float32Array([1.000, 0.735, 0.700]),
      matte: new Float32Array([0.035, 0.022, 0.028]),
    },
    qq: {
      accent: new Float32Array([0.192, 0.761, 0.486]),
      sheen: new Float32Array([0.663, 0.898, 0.773]),
      matte: new Float32Array([0.094, 0.133, 0.114]),
    },
  };
  const NEUTRAL_VOID = new Float32Array([0.010, 0.014, 0.021]);

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
    uniform vec2 u_resolution;
    uniform vec3 u_sourceAccent;
    uniform vec3 u_targetAccent;
    uniform vec3 u_sourceSheen;
    uniform vec3 u_targetSheen;
    uniform vec3 u_sourceMatte;
    uniform vec3 u_targetMatte;
    uniform vec3 u_neutralVoid;
    uniform float u_direction;
    uniform float u_elapsedMs;
    in vec2 v_uv;
    out vec4 outColor;

    const float PI = 3.14159265359;
    const float TAU = 6.28318530718;
    const float COMMIT_AT = ${COMMIT_MS}.0;
    const float COVER_AT = ${FULLY_COVERED_MS}.0;
    const float REVEAL_AT = ${REVEAL_START_MS}.0;
    const float END_AT = ${DURATION_MS}.0;

    float saturate(float value) {
      return clamp(value, 0.0, 1.0);
    }

    float easeInOut(float value) {
      value = saturate(value);
      return value * value * (3.0 - 2.0 * value);
    }

    float smoother(float value) {
      value = saturate(value);
      return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
    }

    float directionalAxis(vec2 uv) {
      return u_direction > 0.0 ? uv.x : 1.0 - uv.x;
    }

    float foldedEdge(vec2 uv, float elapsedMs) {
      float drift = elapsedMs * 0.00115 * u_direction;
      return 0.026 * sin(uv.y * TAU * 1.35 + drift)
        + 0.010 * sin(uv.y * TAU * 3.10 - drift * 0.72)
        + 0.006 * sin((uv.x + uv.y) * TAU * 2.0);
    }

    float curtainAlpha(vec2 uv, float elapsedMs, out float signedFrontDistance) {
      float axis = directionalAxis(uv);
      float edgeOffset = foldedEdge(uv, elapsedMs);
      if (elapsedMs >= COVER_AT && elapsedMs <= REVEAL_AT) {
        signedFrontDistance = -1.0;
        return 1.0;
      }
      if (elapsedMs <= COMMIT_AT) {
        float progress = smoother(elapsedMs / COVER_AT);
        float front = mix(-0.12, 1.12, progress);
        signedFrontDistance = axis + edgeOffset - front;
        float aa = max(fwidth(signedFrontDistance), 0.0045);
        return 1.0 - smoothstep(-aa * 1.8, aa * 1.8, signedFrontDistance);
      }
      float progress = smoother((elapsedMs - REVEAL_AT) / (END_AT - REVEAL_AT));
      float front = mix(-0.12, 1.12, progress);
      signedFrontDistance = axis - edgeOffset - front;
      float aa = max(fwidth(signedFrontDistance), 0.0045);
      return smoothstep(-aa * 1.8, aa * 1.8, signedFrontDistance);
    }

    float silkPleat(vec2 uv, float elapsedMs, out float crease, out float glint) {
      float aspect = u_resolution.x / max(1.0, u_resolution.y);
      vec2 p = uv - 0.5;
      p.x *= aspect;
      float travel = elapsedMs * 0.00055 * u_direction;
      float warp = 0.115 * sin(p.y * 3.7 + travel * 1.6)
        + 0.035 * sin(p.y * 8.4 - travel * 0.9);
      float phase = (p.x + warp) * 5.25 + p.y * 0.44 - travel;
      float broad = sin(phase * PI);
      float detail = 0.22 * sin((phase * 2.0 - p.y * 0.8) * PI);
      float profile = broad * 0.82 + detail;
      float ridge = abs(cos(phase * PI));
      float ridge2 = ridge * ridge;
      float ridge4 = ridge2 * ridge2;
      float ridge8 = ridge4 * ridge4;
      crease = ridge8 * ridge8 * ridge2;
      float grazing = 0.5 + 0.5 * cos(phase * PI + 0.78);
      float grazing2 = grazing * grazing;
      float grazing4 = grazing2 * grazing2;
      float grazing8 = grazing4 * grazing4;
      glint = grazing8 * grazing * (0.32 + 0.68 * crease);
      return profile;
    }

    float engravedContour(vec2 uv, float pleat) {
      float axis = directionalAxis(uv);
      float lineField = sin((axis * 5.0 + uv.y * 1.8 + pleat * 0.16) * TAU);
      float lineWidth = max(fwidth(lineField), 0.012);
      return 1.0 - smoothstep(lineWidth, lineWidth * 3.1, abs(lineField));
    }

    void main() {
      float elapsedMs = clamp(u_elapsedMs, 0.0, END_AT);
      float signedFrontDistance = 0.0;
      float alpha = curtainAlpha(v_uv, elapsedMs, signedFrontDistance);
      if (alpha <= 0.0005) discard;

      float themeMix = easeInOut((elapsedMs - 238.0) / 176.0);
      float handoffNeutral = 1.0 - smoothstep(0.0, 118.0, abs(elapsedMs - COMMIT_AT));
      vec3 accent = mix(u_sourceAccent, u_targetAccent, themeMix);
      vec3 sheen = mix(u_sourceSheen, u_targetSheen, themeMix);
      vec3 matte = mix(u_sourceMatte, u_targetMatte, themeMix);

      float crease = 0.0;
      float glint = 0.0;
      float pleat = silkPleat(v_uv, elapsedMs, crease, glint);
      float contour = engravedContour(v_uv, pleat);
      float vignette = 1.0 - smoothstep(0.24, 0.96, length((v_uv - 0.5) * vec2(u_resolution.x / max(1.0, u_resolution.y), 1.0)));
      float frontLine = 1.0 - smoothstep(0.0, 0.075, abs(signedFrontDistance));
      float foilLine = 1.0 - smoothstep(0.0, 0.036, abs(signedFrontDistance + 0.020 * u_direction));

      vec3 color = mix(u_neutralVoid, matte, 0.56 + vignette * 0.18);
      color = mix(color, u_neutralVoid, handoffNeutral * 0.44);
      color *= 0.84 + pleat * 0.055 + vignette * 0.08;
      color += sheen * glint * (0.075 + vignette * 0.055);
      color += accent * contour * (0.010 + 0.016 * (1.0 - handoffNeutral));
      color += mix(accent, sheen, 0.72) * frontLine * (0.20 + 0.15 * (1.0 - handoffNeutral));
      color += sheen * foilLine * 0.12;

      float staticGrain = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy * 0.5), vec2(0.06711056, 0.00583715))));
      color += (staticGrain - 0.5) * 0.0045;
      outColor = vec4(max(color, vec3(0.0)) * alpha, alpha);
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

  function requiredLocation(gl, activeProgram, name) {
    const uniformLocation = gl.getUniformLocation(activeProgram, name);
    if (uniformLocation === null) throw new Error(`WebGL uniform ${name} is unavailable`);
    return uniformLocation;
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
    canvas.className = "platform-transition-canvas platform-silk-fold-canvas";
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
    let activeProgram;
    let vertexArray;
    let elapsedLocation;
    let resolutionLocation;
    let frame;
    let retirementFrame;
    let startedAt;
    let settled = false;
    let retiring = false;
    let visualDetached = false;
    let committed = false;
    let commitAttempted = false;
    let commitError;
    let contextLost = false;
    let lastElapsedMs = 0;
    let resolveFinished;
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
    }

    function resize() {
      const cssWidth = Math.max(1, Number(innerWidth) || 1);
      const cssHeight = Math.max(1, Number(innerHeight) || 1);
      const dpr = Math.min(MAX_DPR, Math.max(1, Number(devicePixelRatio) || 1));
      const rawWidth = Math.max(1, Math.round(cssWidth * dpr));
      const rawHeight = Math.max(1, Math.round(cssHeight * dpr));
      const rawPixels = rawWidth * rawHeight;
      const scale = rawPixels > MAX_COLOR_PIXELS ? Math.sqrt(MAX_COLOR_PIXELS / rawPixels) : 1;
      canvas.width = Math.max(1, Math.floor(rawWidth * scale));
      canvas.height = Math.max(1, Math.floor(rawHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolutionLocation, cssWidth, cssHeight);
    }

    try {
      activeProgram = createProgram(gl);
      vertexArray = gl.createVertexArray();
      if (!vertexArray) throw new Error("WebGL vertex array allocation failed");
      gl.useProgram(activeProgram);
      gl.bindVertexArray(vertexArray);
      elapsedLocation = requiredLocation(gl, activeProgram, "u_elapsedMs");
      resolutionLocation = requiredLocation(gl, activeProgram, "u_resolution");
      gl.uniform1f(requiredLocation(gl, activeProgram, "u_direction"), direction);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_sourceAccent"), sourceTheme.accent);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_targetAccent"), targetTheme.accent);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_sourceSheen"), sourceTheme.sheen);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_targetSheen"), targetTheme.sheen);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_sourceMatte"), sourceTheme.matte);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_targetMatte"), targetTheme.matte);
      gl.uniform3fv(requiredLocation(gl, activeProgram, "u_neutralVoid"), NEUTRAL_VOID);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      resize();
      canvas.addEventListener("webglcontextlost", onContextLost);
      document.addEventListener("visibilitychange", onVisibility);
      motion.addEventListener("change", onMotionPreference);
      addEventListener("resize", onResize);
      addEventListener("pagehide", onPageHide);
      document.body.append(canvas);
      document.body.classList.add("platform-switching");
      document.body.setAttribute("aria-busy", "true");
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

    function removeRuntimeListeners() {
      safely(() => canvas.removeEventListener("webglcontextlost", onContextLost));
      safely(() => document.removeEventListener("visibilitychange", onVisibility));
      safely(() => motion.removeEventListener("change", onMotionPreference));
      safely(() => removeEventListener("resize", onResize));
      safely(() => removeEventListener("pagehide", onPageHide));
    }

    function detachVisual() {
      if (visualDetached) return;
      visualDetached = true;
      if (frame !== undefined) safely(() => cancelAnimationFrame(frame));
      frame = undefined;
      safely(() => motion.removeEventListener("change", onMotionPreference));
      safely(() => removeEventListener("resize", onResize));
      safely(() => canvas.remove());
      safely(() => document.body.classList.remove("platform-switching"));
      safely(() => document.body.removeAttribute("aria-busy"));
    }

    function cleanup() {
      if (frame !== undefined) safely(() => cancelAnimationFrame(frame));
      if (retirementFrame !== undefined) safely(() => cancelAnimationFrame(retirementFrame));
      frame = undefined;
      retirementFrame = undefined;
      removeRuntimeListeners();
      detachVisual();
      releaseSetup();
    }

    function invokeCommit() {
      if (commitAttempted) return;
      commitAttempted = true;
      try {
        committed = commit() === true;
      } catch (error) {
        commitError = error;
        committed = false;
      }
    }

    function settle(completed) {
      if (settled) return;
      settled = true;
      if (completed && !commitAttempted) invokeCommit();
      try {
        cleanup();
      } finally {
        resolveFinished({ committed, completed, renderer: "webgl2", commitError });
      }
    }

    function completeRetirement() {
      if (settled) return;
      settled = true;
      if (retirementFrame !== undefined) safely(() => cancelAnimationFrame(retirementFrame));
      retirementFrame = undefined;
      removeRuntimeListeners();
      releaseSetup();
      resolveFinished({ committed, completed: true, renderer: "webgl2", commitError });
    }

    function retireAfterCompositorHandoff() {
      if (settled || retiring) return;
      retiring = true;
      detachVisual();
      try {
        retirementFrame = requestAnimationFrame(completeRetirement);
      } catch {
        completeRetirement();
      }
    }

    function drawAt(elapsedMs) {
      lastElapsedMs = elapsedMs;
      gl.uniform1f(elapsedLocation, elapsedMs);
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
            retireAfterCompositorHandoff();
            return;
          }
        } else {
          drawAt(elapsedMs);
          if (elapsedMs >= DURATION_MS) {
            retireAfterCompositorHandoff();
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
      try {
        resize();
        if (startedAt !== undefined) drawAt(lastElapsedMs);
      } catch { settle(true); }
    }

    function onVisibility() {
      if (!document.hidden) return;
      if (retiring) completeRetirement();
      else settle(true);
    }

    function onMotionPreference(event) {
      if (event.matches) settle(true);
    }

    function onContextLost(event) {
      safely(() => event.preventDefault());
      if (settled) return;
      contextLost = true;
      if (retiring) completeRetirement();
      else settle(true);
    }

    function onPageHide() {
      if (retiring) completeRetirement();
      else settle(false);
    }

    try {
      frame = requestAnimationFrame(drawFrame);
    } catch {
      settle(true);
    }
    return {
      finished,
      cancel() { if (!retiring) settle(false); },
    };
  }

  globalThis.PlatformWaveTransition = Object.freeze({ create });
})();
