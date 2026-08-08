(() => {
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
  const DURATION_MS = 760;
  const COMMIT_POINT = 0.46;
  const CREST_SEGMENTS = 72;
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
    const layers = [...(options?.motionLayers || [])].filter((item) => item instanceof HTMLElement);
    const particleCount = innerWidth <= 820 ? 36 : 68;
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
    const startedAt = performance.now();
    const finished = new Promise((resolve) => { resolveFinished = resolve; });

    function releaseContext() {
      if (contextLost) return;
      safely(() => gl.getExtension?.("WEBGL_lose_context")?.loseContext());
    }

    let crestProgram;
    let particleProgram;
    let crestBuffer;
    let particleBuffer;
    let crestUniforms;
    let particleUniforms;
    try {
      crestProgram = program(gl, `#version 300 es
      precision highp float;
      layout(location=0) in vec2 a_crest;
      uniform float u_progress;
      out float v_edge;
      void main() {
        vec2 direction = normalize(vec2(1.0, 1.0));
        vec2 normal = normalize(vec2(-1.0, 1.0));
        float eased = 1.0 - pow(1.0 - u_progress, 3.0);
        vec2 center = mix(vec2(-1.32, -1.32), vec2(1.32, 1.32), eased);
        float s = a_crest.x;
        float wave = sin((s * 2.1 + u_progress * 2.8) * 3.1415926) * 0.065;
        float width = mix(0.018, 0.07, 1.0 - abs(a_crest.y));
        vec2 position = center + normal * s * 1.45 + direction * (wave + a_crest.y * width);
        gl_Position = vec4(position, 0.0, 1.0);
        v_edge = 1.0 - abs(a_crest.y);
      }
    `, `#version 300 es
      precision highp float;
      uniform vec3 u_sourceColor;
      uniform vec3 u_targetColor;
      uniform float u_envelope;
      in float v_edge;
      out vec4 outColor;
      void main() {
        vec3 color = mix(u_sourceColor, u_targetColor, 0.72);
        float alpha = pow(max(v_edge, 0.0), 1.8) * u_envelope * 0.34;
        outColor = vec4(color * alpha, alpha);
      }
    `);
      particleProgram = program(gl, `#version 300 es
      precision highp float;
      layout(location=0) in vec4 a_particle;
      uniform float u_progress;
      uniform float u_dpr;
      out float v_alpha;
      void main() {
        vec2 direction = normalize(vec2(1.0, 1.0));
        vec2 normal = normalize(vec2(-1.0, 1.0));
        float eased = 1.0 - pow(1.0 - u_progress, 3.0);
        vec2 center = mix(vec2(-1.32, -1.32), vec2(1.32, 1.32), eased);
        float s = a_particle.x;
        float crest = sin((s * 2.1 + u_progress * 2.8) * 3.1415926) * 0.065;
        float shimmer = sin((a_particle.y + u_progress * 6.0) * 6.2831853) * 0.012;
        vec2 position = center + normal * (s * 1.45 + shimmer) + direction * (crest + (a_particle.y - 0.5) * 0.055);
        gl_Position = vec4(position, 0.0, 1.0);
        gl_PointSize = a_particle.z * u_dpr;
        v_alpha = a_particle.w;
      }
    `, `#version 300 es
      precision highp float;
      uniform vec3 u_targetColor;
      uniform float u_envelope;
      in float v_alpha;
      out vec4 outColor;
      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        float distanceFromCenter = dot(point, point);
        if (distanceFromCenter > 1.0) discard;
        float glow = smoothstep(1.0, 0.05, distanceFromCenter);
        float alpha = glow * v_alpha * u_envelope;
        outColor = vec4(u_targetColor * alpha, alpha);
      }
    `);

      const crestVertices = new Float32Array((CREST_SEGMENTS + 1) * 4);
      for (let index = 0; index <= CREST_SEGMENTS; index += 1) {
        const s = index / CREST_SEGMENTS * 2 - 1;
        crestVertices[index * 4] = s;
        crestVertices[index * 4 + 1] = -1;
        crestVertices[index * 4 + 2] = s;
        crestVertices[index * 4 + 3] = 1;
      }
      const particles = new Float32Array(particleCount * 4);
      for (let index = 0; index < particleCount; index += 1) {
        particles[index * 4] = index / Math.max(1, particleCount - 1) * 2 - 1 + (Math.random() - 0.5) * 0.045;
        particles[index * 4 + 1] = Math.random();
        particles[index * 4 + 2] = 2.4 + Math.random() * 5.4;
        particles[index * 4 + 3] = 0.36 + Math.random() * 0.62;
      }
      crestBuffer = gl.createBuffer();
      particleBuffer = gl.createBuffer();
      if (!crestBuffer || !particleBuffer) throw new Error("WebGL buffer allocation failed");
      gl.bindBuffer(gl.ARRAY_BUFFER, crestBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, crestVertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, particles, gl.STATIC_DRAW);
      crestUniforms = uniformLocations(gl, crestProgram);
      particleUniforms = uniformLocations(gl, particleProgram);
    } catch {
      if (crestBuffer) safely(() => gl.deleteBuffer(crestBuffer));
      if (particleBuffer) safely(() => gl.deleteBuffer(particleBuffer));
      if (crestProgram) safely(() => gl.deleteProgram(crestProgram));
      if (particleProgram) safely(() => gl.deleteProgram(particleProgram));
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
      layers.forEach((layer) => {
        safely(() => layer.style.removeProperty("transform"));
        safely(() => layer.style.removeProperty("will-change"));
      });
      safely(() => document.body.classList.remove("platform-switching"));
      safely(() => document.body.removeAttribute("aria-busy"));
      if (!contextLost) {
        safely(() => gl.deleteBuffer(crestBuffer));
        safely(() => gl.deleteBuffer(particleBuffer));
        safely(() => gl.deleteProgram(crestProgram));
        safely(() => gl.deleteProgram(particleProgram));
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
      const progress = Math.min(1, (now - startedAt) / DURATION_MS);
      const envelope = Math.sin(Math.PI * progress);
      if (!commitAttempted && progress >= COMMIT_POINT) invokeCommit();
      const lift = Math.sin(Math.PI * progress) * -8 + Math.sin(Math.PI * progress * 2) * 2.5;
      const tilt = Math.sin(Math.PI * progress * 2) * 0.16;
      layers.forEach((layer) => {
        layer.style.transform = `translate3d(0, ${lift.toFixed(2)}px, 0) rotate(${tilt.toFixed(3)}deg)`;
      });

      gl.clearColor(targetColor[0] * envelope * 0.035, targetColor[1] * envelope * 0.035, targetColor[2] * envelope * 0.035, envelope * 0.055);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(crestProgram);
      uniforms(crestUniforms, progress, envelope);
      gl.bindBuffer(gl.ARRAY_BUFFER, crestBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, (CREST_SEGMENTS + 1) * 2);

      gl.useProgram(particleProgram);
      uniforms(particleUniforms, progress, envelope);
      if (particleUniforms.dpr !== null) gl.uniform1f(particleUniforms.dpr, dpr);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, particleCount);

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
      layers.forEach((layer) => { layer.style.willChange = "transform"; });
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
