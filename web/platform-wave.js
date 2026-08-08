(() => {
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
  const DURATION_MS = 680;
  const COMMIT_MS = 326;
  const MAX_DPR = 1.25;
  const MAX_COLOR_PIXELS = 1_600_000;
  const MIN_GRID_COLUMNS = 28;
  const MAX_GRID_COLUMNS = 80;
  const MIN_GRID_ROWS = 24;
  const MAX_GRID_ROWS = 56;
  const GRID_PITCH_CSS_PX = 18;
  const RING_SEGMENTS = 240;
  const RING_LAYERS = 6;
  const RING_PARTICLES = RING_SEGMENTS * RING_LAYERS;
  const MAX_PARTICLES = MAX_GRID_COLUMNS * MAX_GRID_ROWS + RING_PARTICLES;
  const COLORS = {
    netease: {
      accent: new Float32Array([0.965, 0.210, 0.265]),
      glow: new Float32Array([1.000, 0.690, 0.620]),
      matte: new Float32Array([0.034, 0.020, 0.029]),
    },
    qq: {
      accent: new Float32Array([0.055, 0.865, 0.730]),
      glow: new Float32Array([0.690, 0.950, 1.000]),
      matte: new Float32Array([0.014, 0.036, 0.046]),
    },
  };
  const NEUTRAL_VOID = new Float32Array([0.010, 0.014, 0.022]);

  const VERTEX_SOURCE = `#version 300 es
    precision highp float;
    uniform vec2 u_resolution;
    uniform vec2 u_grid;
    uniform float u_direction;
    uniform float u_elapsedMs;
    uniform int u_pass;
    flat out int v_pass;
    out vec2 v_uv;
    out vec2 v_particleUv;
    out float v_height;
    out float v_ridge;
    out float v_depth;
    out float v_presence;
    out float v_themeMix;

    const float COVER_END = ${COMMIT_MS}.0;
    const float RELEASE_END = ${DURATION_MS}.0;
    const float RING_SEGMENTS = ${RING_SEGMENTS}.0;

    float easeInOut(float value) {
      value = clamp(value, 0.0, 1.0);
      return value * value * (3.0 - 2.0 * value);
    }

    float particleGrain(vec2 cell) {
      return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float lemniscateDistance(vec2 point) {
      vec2 p = vec2(point.x / 1.55, point.y / 1.05);
      float radiusSquared = dot(p, p);
      float aSquared = 1.15;
      float field = radiusSquared * radiusSquared - aSquared * (p.x * p.x - p.y * p.y);
      vec2 gradient = vec2(
        4.0 * p.x * radiusSquared - 2.0 * aSquared * p.x,
        4.0 * p.y * radiusSquared + 2.0 * aSquared * p.y
      );
      return abs(field) / max(length(gradient), 0.16);
    }

    vec2 particleCorner(int vertexId) {
      if (vertexId == 0) return vec2(-0.5, -0.5);
      if (vertexId == 1) return vec2( 0.5, -0.5);
      if (vertexId == 2) return vec2( 0.5,  0.5);
      if (vertexId == 3) return vec2(-0.5, -0.5);
      if (vertexId == 4) return vec2( 0.5,  0.5);
      return vec2(-0.5, 0.5);
    }

    void backgroundVertex() {
      vec2 position = vec2(
        gl_VertexID == 1 ? 3.0 : -1.0,
        gl_VertexID == 2 ? 3.0 : -1.0
      );
      v_uv = position * 0.5 + 0.5;
      v_particleUv = vec2(0.0);
      v_height = 0.0;
      v_ridge = 0.0;
      v_depth = 1.0;
      v_presence = 1.0;
      v_themeMix = easeInOut((u_elapsedMs - (COVER_END - 90.0)) / 180.0);
      gl_Position = vec4(position, 0.9999, 1.0);
    }

    void particleVertex() {
      float instance = float(gl_InstanceID);
      float floorCount = u_grid.x * u_grid.y;
      bool ringParticle = instance >= floorCount;
      float floorInstance = min(instance, floorCount - 1.0);
      float column = mod(floorInstance, u_grid.x);
      float row = floor(floorInstance / u_grid.x);
      vec2 cell = (vec2(column, row) + 0.5) / u_grid;
      vec2 plane = vec2((cell.x - 0.5) * 5.30, (cell.y - 0.5) * 3.30);
      float ringPhase = 0.0;
      float grain = particleGrain(vec2(column, row));
      if (ringParticle) {
        float ringInstance = instance - floorCount;
        float segment = mod(ringInstance, RING_SEGMENTS);
        float layer = floor(ringInstance / RING_SEGMENTS);
        ringPhase = (segment + 0.5 * mod(layer, 2.0)) / RING_SEGMENTS * 6.28318530718;
        vec2 curve = vec2(1.98 * sin(ringPhase), 1.60 * sin(ringPhase) * cos(ringPhase));
        vec2 tangent = vec2(1.98 * cos(ringPhase), 1.60 * cos(2.0 * ringPhase));
        vec2 normal = normalize(vec2(-tangent.y, tangent.x));
        grain = particleGrain(vec2(segment, layer + 91.0));
        float bandOffset = (layer - 2.5) * 0.060 + (grain - 0.5) * 0.028;
        plane = curve + normal * bandOffset;
        cell = plane / vec2(5.30, 3.30) + 0.5;
      }
      float ridgeDistance = lemniscateDistance(plane);
      float ridge = ringParticle ? 1.0 : exp(-ridgeDistance * ridgeDistance * 20.0);
      float halo = exp(-ridgeDistance * ridgeDistance * 4.5);
      float loopPhase = ringParticle ? ringPhase : atan(plane.y / 1.05, plane.x / 1.55);
      float waveCount = ringParticle ? 3.0 : 7.0;
      float grainPhase = ringParticle ? grain * 0.72 : grain * 1.8;
      float traveling = 0.5 + 0.5 * sin(loopPhase * waveCount - u_elapsedMs * 0.012 * u_direction + grainPhase);
      float rolling = 0.5 + 0.5 * sin(plane.x * 3.2 + plane.y * 4.6 - u_elapsedMs * 0.009 * u_direction);
      float height = 0.012 + grain * 0.026 + halo * 0.050 + ridge * (0.10 + 0.34 * pow(traveling, 2.15));
      if (ringParticle) height = 0.18 + grain * 0.040 + 0.58 * (0.40 + 0.60 * pow(traveling, 1.8));
      height += rolling * (0.014 + halo * 0.036);

      float covering = easeInOut(u_elapsedMs / COVER_END);
      float revealing = easeInOut((u_elapsedMs - COVER_END) / (RELEASE_END - COVER_END));
      float order = u_direction > 0.0
        ? cell.x * 0.68 + (1.0 - cell.y) * 0.32
        : (1.0 - cell.x) * 0.68 + cell.y * 0.32;
      float presence = u_elapsedMs <= COVER_END
        ? smoothstep(order * 0.68, order * 0.68 + 0.18, covering)
        : 1.0 - smoothstep(order * 0.72, order * 0.72 + 0.24, revealing);
      height *= mix(0.18, 1.0, easeInOut(presence));

      float aspect = u_resolution.x / max(1.0, u_resolution.y);
      float sceneScaleX = min(1.0, aspect / 1.35);
      vec3 world = vec3(plane.x * sceneScaleX, height, plane.y - 0.06);
      vec3 camera = vec3(0.0, 3.34, 3.66);
      vec3 target = vec3(0.0, 0.08, -0.12);
      vec3 forward = normalize(target - camera);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);
      vec3 relative = world - camera;
      vec3 view = vec3(dot(relative, right), dot(relative, up), dot(relative, forward));
      view.z = max(view.z, 0.12);

      const float nearPlane = 0.08;
      const float farPlane = 8.0;
      const float focalLength = 1.70;
      vec4 clip = vec4(
        view.x * focalLength / aspect,
        view.y * focalLength,
        ((farPlane + nearPlane) / (farPlane - nearPlane)) * view.z
          - (2.0 * farPlane * nearPlane) / (farPlane - nearPlane),
        view.z
      );

      vec2 corner = particleCorner(gl_VertexID);
      float perspective = clamp(3.7 / view.z, 0.66, 1.72);
      float particleWidth = mix(1.45, ringParticle ? 4.8 : 3.9, ridge) * perspective;
      float particleHeight = (2.2 + height * 31.0 + ridge * 6.0 + halo * 2.0) * perspective;
      vec2 ndcOffset = vec2(
        corner.x * particleWidth * 2.0 / u_resolution.x,
        corner.y * particleHeight * 2.0 / u_resolution.y
      );
      clip.xy += ndcOffset * clip.w;

      v_uv = cell;
      v_particleUv = corner + 0.5;
      v_height = clamp(height / 1.08, 0.0, 1.0);
      v_ridge = ridge;
      v_depth = clamp((view.z - 1.15) / 4.1, 0.0, 1.0);
      v_presence = presence;
      v_themeMix = easeInOut((u_elapsedMs - (COVER_END - 90.0)) / 180.0);
      gl_Position = clip;
    }

    void main() {
      v_pass = u_pass;
      if (u_pass == 0) backgroundVertex();
      else particleVertex();
    }
  `;

  const FRAGMENT_SOURCE = `#version 300 es
    precision highp float;
    uniform vec2 u_resolution;
    uniform vec3 u_sourceAccent;
    uniform vec3 u_targetAccent;
    uniform vec3 u_sourceGlow;
    uniform vec3 u_targetGlow;
    uniform vec3 u_sourceMatte;
    uniform vec3 u_targetMatte;
    uniform vec3 u_neutralVoid;
    uniform float u_elapsedMs;
    flat in int v_pass;
    in vec2 v_uv;
    in vec2 v_particleUv;
    in float v_height;
    in float v_ridge;
    in float v_depth;
    in float v_presence;
    in float v_themeMix;
    out vec4 outColor;

    const float COVER_END = ${COMMIT_MS}.0;
    const float RELEASE_END = ${DURATION_MS}.0;

    float easeInOut(float value) {
      value = clamp(value, 0.0, 1.0);
      return value * value * (3.0 - 2.0 * value);
    }

    float backdropAlpha() {
      if (u_elapsedMs <= COVER_END) return easeInOut(u_elapsedMs / 205.0);
      return 1.0 - easeInOut((u_elapsedMs - 420.0) / (RELEASE_END - 420.0));
    }

    void backgroundFragment() {
      vec2 centered = v_uv - 0.5;
      float aspect = u_resolution.x / max(1.0, u_resolution.y);
      centered.x *= aspect;
      float vignette = 1.0 - smoothstep(0.22, 0.92, length(centered));
      float horizon = exp(-abs(v_uv.y - 0.48) * 6.4);
      float grain = 0.5 + 0.5 * sin(v_uv.x * 51.0 + v_uv.y * 37.0 + u_elapsedMs * 0.006);
      vec3 matte = mix(u_sourceMatte, u_targetMatte, v_themeMix);
      vec3 accent = mix(u_sourceAccent, u_targetAccent, v_themeMix);
      vec3 color = mix(u_neutralVoid, matte, 0.34 + vignette * 0.22);
      color += accent * (horizon * 0.028 + grain * 0.004) * vignette;
      float alpha = backdropAlpha();
      outColor = vec4(color * alpha, alpha);
    }

    void particleFragment() {
      vec2 centered = v_particleUv - 0.5;
      vec2 rounded = abs(centered) - vec2(0.34, 0.42);
      float distanceToBar = length(max(rounded, 0.0)) + min(max(rounded.x, rounded.y), 0.0) - 0.09;
      float antialias = max(fwidth(distanceToBar), 0.018);
      float mask = 1.0 - smoothstep(-antialias, antialias, distanceToBar);
      float topLight = smoothstep(0.18, 0.92, v_particleUv.y);
      float edgeLight = 1.0 - smoothstep(0.04, 0.22, min(v_particleUv.x, 1.0 - v_particleUv.x));
      vec3 accent = mix(u_sourceAccent, u_targetAccent, v_themeMix);
      vec3 glow = mix(u_sourceGlow, u_targetGlow, v_themeMix);
      vec3 base = mix(vec3(0.040, 0.064, 0.082), accent, 0.18 + v_ridge * 0.58);
      float luminous = clamp(v_ridge * 0.76 + v_height * 0.44 + topLight * 0.24 + edgeLight * 0.10, 0.0, 1.0);
      vec3 color = mix(base, glow, luminous * 0.88);
      color *= mix(0.38, 1.12, 1.0 - v_depth);
      float sceneAlpha = u_elapsedMs <= COVER_END
        ? smoothstep(0.0, 0.16, u_elapsedMs / COVER_END)
        : 1.0 - smoothstep(0.76, 1.0, (u_elapsedMs - COVER_END) / (RELEASE_END - COVER_END));
      float alpha = mask * v_presence * sceneAlpha * mix(0.72, 1.0, v_ridge);
      if (alpha <= 0.001) discard;
      outColor = vec4(color * alpha, alpha);
    }

    void main() {
      if (v_pass == 0) backgroundFragment();
      else particleFragment();
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
    canvas.className = "platform-transition-canvas platform-particle-wave-canvas";
    canvas.setAttribute("aria-hidden", "true");
    let gl;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: true,
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
    let gridLocation;
    let passLocation;
    let particleCount = 0;
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
      const columns = Math.min(MAX_GRID_COLUMNS, Math.max(MIN_GRID_COLUMNS, Math.round(cssWidth / GRID_PITCH_CSS_PX)));
      const rows = Math.min(MAX_GRID_ROWS, Math.max(MIN_GRID_ROWS, Math.round(cssHeight / GRID_PITCH_CSS_PX)));
      particleCount = Math.min(MAX_PARTICLES, columns * rows + RING_PARTICLES);
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      if (resolutionLocation !== null) gl.uniform2f(resolutionLocation, cssWidth, cssHeight);
      if (gridLocation !== null) gl.uniform2f(gridLocation, columns, rows);
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
      gridLocation = location(gl, activeProgram, "u_grid");
      passLocation = location(gl, activeProgram, "u_pass");
      const directionLocation = location(gl, activeProgram, "u_direction");
      const sourceAccentLocation = location(gl, activeProgram, "u_sourceAccent");
      const targetAccentLocation = location(gl, activeProgram, "u_targetAccent");
      const sourceGlowLocation = location(gl, activeProgram, "u_sourceGlow");
      const targetGlowLocation = location(gl, activeProgram, "u_targetGlow");
      const sourceMatteLocation = location(gl, activeProgram, "u_sourceMatte");
      const targetMatteLocation = location(gl, activeProgram, "u_targetMatte");
      const neutralVoidLocation = location(gl, activeProgram, "u_neutralVoid");
      if (directionLocation !== null) gl.uniform1f(directionLocation, direction);
      if (sourceAccentLocation !== null) gl.uniform3fv(sourceAccentLocation, sourceTheme.accent);
      if (targetAccentLocation !== null) gl.uniform3fv(targetAccentLocation, targetTheme.accent);
      if (sourceGlowLocation !== null) gl.uniform3fv(sourceGlowLocation, sourceTheme.glow);
      if (targetGlowLocation !== null) gl.uniform3fv(targetGlowLocation, targetTheme.glow);
      if (sourceMatteLocation !== null) gl.uniform3fv(sourceMatteLocation, sourceTheme.matte);
      if (targetMatteLocation !== null) gl.uniform3fv(targetMatteLocation, targetTheme.matte);
      if (neutralVoidLocation !== null) gl.uniform3fv(neutralVoidLocation, NEUTRAL_VOID);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.LEQUAL);
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
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (passLocation !== null) gl.uniform1i(passLocation, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (passLocation !== null) gl.uniform1i(passLocation, 1);
      gl.enable(gl.DEPTH_TEST);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, particleCount);
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
