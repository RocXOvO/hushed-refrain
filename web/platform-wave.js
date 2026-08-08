(() => {
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
  const DURATION_MS = 760;
  const COMMIT_POINT = 0.46;
  const GRID_SPACING_CSS_PX = 30;
  const GRID_COLUMNS_MIN = 19;
  const GRID_COLUMNS_MAX = 58;
  const GRID_ROWS_MIN = 14;
  const GRID_ROWS_MAX = 36;
  const COLORS = {
    netease: [0.827, 0.227, 0.255],
    qq: [0.027, 0.549, 0.671],
  };

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "WebGL shader compilation failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function program(gl, vertexSource, fragmentSource) {
    const value = gl.createProgram();
    if (!value) throw new Error("WebGL program allocation failed");
    let vertex;
    let fragment;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
      fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
      gl.attachShader(value, vertex);
      gl.attachShader(value, fragment);
      gl.linkProgram(value);
      if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(value) || "WebGL program link failed");
      }
      return value;
    } catch (error) {
      gl.deleteProgram(value);
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }

  function immediate(commit) {
    let commitError;
    try { commit(); } catch (error) { commitError = error; }
    return {
      finished: Promise.resolve({ committed: !commitError, completed: true, renderer: "none", commitError }),
      cancel() {},
    };
  }

  function uniformLocations(gl, activeProgram) {
    return {
      progress: gl.getUniformLocation(activeProgram, "u_progress"),
      envelope: gl.getUniformLocation(activeProgram, "u_envelope"),
      sourceColor: gl.getUniformLocation(activeProgram, "u_sourceColor"),
      targetColor: gl.getUniformLocation(activeProgram, "u_targetColor"),
      dpr: gl.getUniformLocation(activeProgram, "u_dpr"),
    };
  }

  function safely(operation) {
    try { operation(); } catch { /* Best-effort renderer teardown. */ }
  }

  function create(options) {
    const commit = typeof options?.commit === "function" ? options.commit : () => {};
    const motion = matchMedia(REDUCED_MOTION);
    if (motion.matches || document.hidden || typeof WebGL2RenderingContext === "undefined") return immediate(commit);

    const canvas = document.createElement("canvas");
    canvas.className = "platform-transition-canvas platform-wave-canvas";
    canvas.setAttribute("aria-hidden", "true");
    let gl;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        powerPreference: "low-power",
        premultipliedAlpha: true,
      });
    } catch {
      canvas.remove();
      return immediate(commit);
    }
    if (!gl) return immediate(commit);

    const sourceColor = COLORS[options?.sourcePlatform] || COLORS.netease;
    const targetColor = COLORS[options?.targetPlatform] || COLORS.qq;
    const gridColumns = Math.min(
      GRID_COLUMNS_MAX,
      Math.max(GRID_COLUMNS_MIN, Math.ceil(innerWidth / GRID_SPACING_CSS_PX) + 1),
    );
    const gridRows = Math.min(
      GRID_ROWS_MAX,
      Math.max(GRID_ROWS_MIN, Math.ceil(innerHeight / GRID_SPACING_CSS_PX) + 1),
    );
    const pointCount = gridColumns * gridRows;
    const dpr = Math.min(1.25, Math.max(1, devicePixelRatio || 1));
    let width = 1;
    let height = 1;
    let frame;
    let committed = false;
    let commitAttempted = false;
    let commitError;
    let settled = false;
    let contextLost = false;
    let resolveFinished;
    let startedAt;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });

    function releaseContext() {
      if (contextLost) return;
      safely(() => gl.getExtension?.("WEBGL_lose_context")?.loseContext());
    }

    let matrixProgram;
    let matrixBuffer;
    let matrixUniforms;
    try {
      matrixProgram = program(gl, `#version 300 es
      precision highp float;
      layout(location=0) in vec2 a_grid;
      uniform float u_progress;
      uniform float u_dpr;
      out float v_colorMix;
      out float v_alpha;
      out float v_lift;
      void main() {
        vec2 direction = normalize(vec2(1.0, 1.0));
        float eased = u_progress * u_progress * (3.0 - 2.0 * u_progress);
        float front = mix(-1.58, 1.58, eased);
        float distanceToCrest = dot(a_grid, direction) - front;
        float crest = exp(-pow(distanceToCrest / 0.16, 2.0));
        float wakeMask = step(0.0, -distanceToCrest);
        float wake = wakeMask * exp(distanceToCrest * 5.2) * sin(distanceToCrest * 31.0);
        float lift = crest * 0.285 + wake * 0.060;
        vec2 bendDirection = normalize(vec2(a_grid.x * 0.18 - 0.28, 1.0));
        vec2 position = a_grid + bendDirection * lift;
        gl_Position = vec4(position, 0.0, 1.0);
        gl_PointSize = (5.2 + crest * 8.6 + abs(wake) * 2.2) * u_dpr;
        v_colorMix = smoothstep(-0.11, 0.11, front - dot(a_grid, direction));
        v_alpha = 0.74 + crest * 0.26 + abs(wake) * 0.18;
        v_lift = crest;
      }
    `, `#version 300 es
      precision highp float;
      uniform vec3 u_sourceColor;
      uniform vec3 u_targetColor;
      uniform float u_envelope;
      in float v_colorMix;
      in float v_alpha;
      in float v_lift;
      out vec4 outColor;
      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        float radius = length(point);
        if (radius > 1.0) discard;
        float core = 1.0 - smoothstep(0.16, 0.55, radius);
        float halo = 1.0 - smoothstep(0.30, 1.0, radius);
        float alpha = (core + halo * 0.38) * v_alpha * u_envelope;
        vec3 color = mix(u_sourceColor, u_targetColor, v_colorMix);
        color *= 1.0 + v_lift * 0.38;
        outColor = vec4(color * alpha, alpha);
      }
    `);

      const matrixPoints = new Float32Array(pointCount * 2);
      let pointIndex = 0;
      for (let row = 0; row < gridRows; row += 1) {
        for (let column = 0; column < gridColumns; column += 1) {
          matrixPoints[pointIndex] = column / Math.max(1, gridColumns - 1) * 2.08 - 1.04;
          matrixPoints[pointIndex + 1] = row / Math.max(1, gridRows - 1) * 2.08 - 1.04;
          pointIndex += 2;
        }
      }
      matrixBuffer = gl.createBuffer();
      if (!matrixBuffer) throw new Error("WebGL buffer allocation failed");
      gl.bindBuffer(gl.ARRAY_BUFFER, matrixBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, matrixPoints, gl.STATIC_DRAW);
      matrixUniforms = uniformLocations(gl, matrixProgram);
    } catch {
      if (matrixBuffer) safely(() => gl.deleteBuffer(matrixBuffer));
      if (matrixProgram) safely(() => gl.deleteProgram(matrixProgram));
      releaseContext();
      safely(() => { canvas.width = 1; canvas.height = 1; });
      safely(() => canvas.remove());
      return immediate(commit);
    }

    function resize() {
      width = Math.max(1, innerWidth);
      height = Math.max(1, innerHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function cleanup() {
      if (frame !== undefined) safely(() => cancelAnimationFrame(frame));
      safely(() => document.removeEventListener("visibilitychange", onVisibility));
      safely(() => motion.removeEventListener("change", onMotionPreference));
      safely(() => removeEventListener("resize", onResize));
      safely(() => canvas.removeEventListener("webglcontextlost", onContextLost));
      safely(() => document.body.classList.remove("platform-switching"));
      safely(() => document.body.removeAttribute("aria-busy"));
      if (!contextLost) {
        safely(() => gl.deleteBuffer(matrixBuffer));
        safely(() => gl.deleteProgram(matrixProgram));
      }
      releaseContext();
      safely(() => { canvas.width = 1; canvas.height = 1; });
      safely(() => canvas.remove());
    }

    function invokeCommit() {
      if (commitAttempted) return;
      commitAttempted = true;
      try {
        commit();
        committed = true;
      } catch (error) {
        commitError = error;
      }
    }

    function settle(complete) {
      if (settled) return;
      settled = true;
      if (complete) invokeCommit();
      try {
        cleanup();
      } catch {
        // A torn-down context may reject individual disposal calls. The
        // transition promise must still settle and release application state.
      } finally {
        resolveFinished({ committed, completed: complete, renderer: "webgl2", commitError });
      }
    }

    function onVisibility() {
      if (document.hidden) settle(true);
    }
    function onMotionPreference(event) {
      if (event.matches) settle(true);
    }
    function onResize() {
      resize();
    }
    function onContextLost(event) {
      event.preventDefault();
      contextLost = true;
      settle(true);
    }

    function uniforms(locations, progress, envelope) {
      if (locations.progress !== null) gl.uniform1f(locations.progress, progress);
      if (locations.envelope !== null) gl.uniform1f(locations.envelope, envelope);
      if (locations.sourceColor !== null) gl.uniform3fv(locations.sourceColor, sourceColor);
      if (locations.targetColor !== null) gl.uniform3fv(locations.targetColor, targetColor);
    }

    function drawFrame(now) {
      if (settled) return;
      if (startedAt === undefined) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / DURATION_MS);
      const envelope = Math.sin(Math.PI * progress);
      if (!commitAttempted && progress >= COMMIT_POINT) invokeCommit();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(matrixProgram);
      uniforms(matrixUniforms, progress, envelope);
      if (matrixUniforms.dpr !== null) gl.uniform1f(matrixUniforms.dpr, dpr);
      gl.bindBuffer(gl.ARRAY_BUFFER, matrixBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, pointCount);

      if (progress >= 1) settle(true);
      else frame = requestAnimationFrame(draw);
    }

    function draw(now) {
      try {
        drawFrame(now);
      } catch {
        settle(true);
      }
    }

    try {
      document.body.append(canvas);
      document.body.classList.add("platform-switching");
      document.body.setAttribute("aria-busy", "true");
      resize();
      addEventListener("resize", onResize, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      motion.addEventListener("change", onMotionPreference);
      canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
      frame = requestAnimationFrame(draw);
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
