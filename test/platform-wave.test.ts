import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const waveSource = readFileSync(join(process.cwd(), "web", "platform-wave.js"), "utf8");

test("obsidian silk transition honors reduced motion without requesting WebGL", async () => {
  const runtime = waveRuntime(fakeGl(), { reducedMotion: true });
  load(runtime);
  let commits = 0;

  const outcome = await runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    direction: 1,
    commit: () => { commits += 1; return true; },
  }).finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "none" });
  assert.equal(runtime.contextRequests.length, 0);
  assertClean(runtime);
});

test("obsidian silk transition uses one fullscreen triangle and no particle geometry", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  load(runtime);
  const transition = createTransition(runtime);

  assert.deepEqual(runtime.contextRequests, [{
    name: "webgl2",
    options: {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    },
  }]);
  runtime.runFrame(0);
  assert.deepEqual(gl.drawCalls, [
    { kind: "arrays", mode: gl.TRIANGLES, first: 0, count: 3 },
  ]);
  assert.equal(gl.createdPrograms, 1);
  assert.equal(gl.createdVertexArrays, 1);
  assert.equal(gl.forbiddenCalls.length, 0);
  assert.ok(gl.uniformPairs.some(({ name, x, y }) => name === "u_resolution" && x === 1_200 && y === 800));
  assert.match(gl.shaderSources.join("\n"), /gl_VertexID/);
  assert.doesNotMatch(gl.shaderSources.join("\n"), /gl_InstanceID/);
  assert.match(gl.shaderSources.join("\n"), /float silkPleat/);
  assert.match(gl.shaderSources.join("\n"), /float foldedEdge/);
  assert.match(gl.shaderSources.join("\n"), /float engravedContour/);
  assert.match(gl.shaderSources.join("\n"), /frontLine = 1\.0 - smoothstep\(0\.0, 0\.075/);
  assert.match(waveSource, /gl\.drawArrays\(gl\.TRIANGLES, 0, 3\)/);
  assert.doesNotMatch(waveSource, /drawArraysInstanced|createBuffer|createTexture|createFramebuffer|readPixels/);
  assert.doesNotMatch(gl.shaderSources.join("\n"), /lemniscate|ringParticle|particleGrain|u_pattern/);
  assert.equal(waveSource.includes("Math.random"), false);
  assert.equal(/\.style\.(?:transform|opacity|filter|willChange)\s*=/.test(waveSource), false);

  transition.cancel();
  await transition.finished;
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.deletedVertexArrays.length, 1);
  assertClean(runtime);
});

test("obsidian silk mirrors only its travel direction and keeps deterministic fold shading", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl, { innerWidth: 390, innerHeight: 844 });
  load(runtime);
  const transition = createTransition(runtime, { direction: -1 });
  runtime.runFrame(0);

  assert.ok(gl.uniformScalars.some(({ name, value }) => name === "u_direction" && value === -1));
  assert.ok(gl.uniformPairs.some(({ name, x, y }) => name === "u_resolution" && x === 390 && y === 844));
  assert.deepEqual(gl.drawCalls.at(-1), { kind: "arrays", mode: gl.TRIANGLES, first: 0, count: 3 });
  const shader = gl.shaderSources.join("\n");
  assert.match(shader, /return u_direction > 0\.0 \? uv\.x : 1\.0 - uv\.x/);
  assert.match(shader, /float warp = 0\.115 \* sin/);
  assert.match(shader, /crease = ridge8 \* ridge8 \* ridge2/);
  assert.doesNotMatch(shader, /\bpow\(|\bexp\(/);
  assert.match(shader, /mix\(u_sourceAccent, u_targetAccent, themeMix\)/);
  assert.equal(waveSource.includes("Math.random"), false);
  assert.equal(/\.style\.(?:transform|opacity|filter|willChange)\s*=/.test(waveSource), false);

  transition.cancel();
  await transition.finished;
  assertClean(runtime);
});

test("obsidian silk is fully opaque across the atomic handoff", () => {
  assert.match(waveSource, /const FULLY_COVERED_MS = 244/);
  assert.match(waveSource, /const REVEAL_START_MS = 404/);
  assert.match(waveSource, /elapsedMs >= COVER_AT && elapsedMs <= REVEAL_AT[\s\S]*return 1\.0/);
  assert.match(waveSource, /float front = mix\(-0\.12, 1\.12, progress\)/);
  assert.match(waveSource, /if \(elapsedMs <= COMMIT_AT\)[\s\S]*1\.0 - smoothstep/);
  assert.match(waveSource, /float progress = smoother\(\(elapsedMs - REVEAL_AT\)/);
  assert.match(waveSource, /return smoothstep\(-aa \* 1\.8, aa \* 1\.8, signedFrontDistance\)/);
  assert.match(waveSource, /drawAt\(COMMIT_MS\);\s*invokeCommit\(\)/);
  assert.doesNotMatch(waveSource, /lemniscate|particleCount|u_grid|u_pass/);
});

test("obsidian silk transition commits once at the 326ms fully opaque handoff", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  load(runtime);
  let commits = 0;
  const transition = createTransition(runtime, {
    commit: () => { gl.events.push("commit"); commits += 1; return true; },
  });

  runtime.runFrame(1_000);
  runtime.runFrame(1_325);
  assert.equal(commits, 0);
  runtime.runFrame(1_326);
  assert.equal(commits, 1);
  assert.deepEqual(gl.events.filter((event) => event === "draw" || event === "commit").slice(-2), ["draw", "commit"]);
  runtime.runFrame(1_500);
  runtime.runFrame(1_680);
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "webgl2" });
  assert.ok(gl.uniformScalars.some(({ name, value }) => name === "u_elapsedMs" && value === 326));
  assert.match(gl.shaderSources.join("\n"), /float curtainAlpha\(/);
  assert.match(gl.shaderSources.join("\n"), /vec3 matte = mix\(u_sourceMatte, u_targetMatte, themeMix\)/);
  assert.match(gl.shaderSources.join("\n"), /handoffNeutral/);
  assertClean(runtime);
});

test("obsidian silk transition cancel before commit preserves source and after commit preserves target", async () => {
  {
    const runtime = waveRuntime(fakeGl());
    load(runtime);
    let commits = 0;
    const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
    runtime.runFrame(0);
    runtime.runFrame(325);
    transition.cancel();
    assert.deepEqual(plain(await transition.finished), {
      committed: false,
      completed: false,
      renderer: "webgl2",
    });
    assert.equal(commits, 0);
    assertClean(runtime);
  }

  {
    const runtime = waveRuntime(fakeGl());
    load(runtime);
    let commits = 0;
    const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
    runtime.runFrame(0);
    runtime.runFrame(326);
    transition.cancel();
    assert.deepEqual(plain(await transition.finished), {
      committed: true,
      completed: false,
      renderer: "webgl2",
    });
    assert.equal(commits, 1);
    assertClean(runtime);
  }
});

test("obsidian silk transition preserves commit false and commit errors without hanging", async () => {
  {
    const runtime = waveRuntime(fakeGl());
    load(runtime);
    let commits = 0;
    const transition = createTransition(runtime, { commit: () => { commits += 1; return false; } });
    runtime.runFrame(0);
    runtime.runFrame(326);
    assert.deepEqual(plain(await transition.finished), {
      committed: false,
      completed: true,
      renderer: "webgl2",
    });
    assert.equal(commits, 1);
    assertClean(runtime);
  }

  {
    const runtime = waveRuntime(fakeGl());
    load(runtime);
    const transition = createTransition(runtime, {
      commit: () => { throw new Error("synthetic commit failure"); },
    });
    runtime.runFrame(0);
    runtime.runFrame(680);
    const outcome = await transition.finished;
    assert.equal(outcome.committed, false);
    assert.equal(outcome.completed, true);
    assert.equal(outcome.renderer, "webgl2");
    assert.match(String(outcome.commitError), /synthetic commit failure/);
    assertClean(runtime);
  }
});

test("obsidian silk transition immediately commits and releases every partial setup failure", async (t) => {
  const cases: Array<[string, GlFailure | RuntimeFailure]> = [
    ["getContext throw", { runtime: "getContext" }],
    ["getContext null", { runtime: "nullContext" }],
    ["shader allocation", { gl: "shader" }],
    ["shader compile", { gl: "compile" }],
    ["program allocation", { gl: "program" }],
    ["program link", { gl: "link" }],
    ["VAO allocation", { gl: "vao" }],
    ["required uniform", { gl: "uniform" }],
    ["append", { runtime: "append" }],
    ["initial resize", { gl: "viewport" }],
  ];
  for (const [name, failure] of cases) {
    await t.test(name, async () => {
      const gl = fakeGl("gl" in failure ? failure.gl : undefined);
      const runtime = waveRuntime(gl, "runtime" in failure ? { failRuntime: failure.runtime } : {});
      load(runtime);
      let commits = 0;
      const outcome = await createTransition(runtime, {
        commit: () => { commits += 1; return true; },
      }).finished;
      assert.equal(commits, 1);
      assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "none" });
      assertClean(runtime);
    });
  }
});

test("obsidian silk transition converts draw and resize exceptions into an immediate committed settlement", async (t) => {
  for (const failure of ["draw", "viewport"] as const) {
    await t.test(failure, async () => {
      const gl = fakeGl(failure === "viewport" ? undefined : failure);
      const runtime = waveRuntime(gl);
      load(runtime);
      let commits = 0;
      const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
      if (failure !== "viewport") runtime.runFrame(0);
      else {
        gl.failViewport = true;
        runtime.triggerWindow("resize");
      }
      assert.deepEqual(plain(await transition.finished), {
        committed: true,
        completed: true,
        renderer: "webgl2",
      });
      assert.equal(commits, 1);
      assertClean(runtime);
    });
  }
});

test("obsidian silk transition releases a fully initialized renderer when the first RAF request throws", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl, { failRuntime: "initialRaf" });
  load(runtime);
  let commits = 0;
  const outcome = await createTransition(runtime, {
    commit: () => { commits += 1; return true; },
  }).finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "webgl2" });
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.deletedVertexArrays.length, 1);
  assert.equal(gl.lostContexts, 1);
  assertClean(runtime);
});

test("obsidian silk transition responds to context loss before and after handoff exactly once", async () => {
  for (const afterCommit of [false, true]) {
    const gl = fakeGl();
    const runtime = waveRuntime(gl);
    load(runtime);
    let commits = 0;
    const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
    runtime.runFrame(0);
    if (afterCommit) runtime.runFrame(326);
    runtime.triggerCanvas("webglcontextlost");
    runtime.triggerCanvas("webglcontextlost");
    assert.deepEqual(plain(await transition.finished), {
      committed: true,
      completed: true,
      renderer: "webgl2",
    });
    assert.equal(commits, 1);
    assert.equal(gl.deletedPrograms.length, 0);
    assert.equal(gl.deletedVertexArrays.length, 0);
    assert.equal(gl.lostContexts, 0);
    assertClean(runtime);
  }
});

test("obsidian silk transition settles on dynamic reduced motion, hidden state, and pagehide", async (t) => {
  for (const trigger of ["motion", "hidden"] as const) {
    await t.test(trigger, async () => {
      const runtime = waveRuntime(fakeGl());
      load(runtime);
      let commits = 0;
      const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
      if (trigger === "motion") runtime.triggerMotion(true);
      else {
        runtime.context.document.hidden = true;
        runtime.triggerDocument("visibilitychange");
      }
      assert.equal((await transition.finished).committed, true);
      assert.equal(commits, 1);
      assertClean(runtime);
    });
  }

  await t.test("pagehide before handoff cancels without commit", async () => {
    const runtime = waveRuntime(fakeGl());
    load(runtime);
    let commits = 0;
    const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
    runtime.triggerWindow("pagehide");
    assert.deepEqual(plain(await transition.finished), {
      committed: false,
      completed: false,
      renderer: "webgl2",
    });
    assert.equal(commits, 0);
    assertClean(runtime);
  });

  await t.test("pagehide after handoff preserves committed target", async () => {
    const runtime = waveRuntime(fakeGl());
    load(runtime);
    let commits = 0;
    const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
    runtime.runFrame(0);
    runtime.runFrame(326);
    runtime.triggerWindow("pagehide");
    assert.equal((await transition.finished).committed, true);
    assert.equal(commits, 1);
    assertClean(runtime);
  });
});

test("obsidian silk transition resize preserves its clock, commit count, DPR cap, and pixel budget", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl, {
    innerWidth: 3_840,
    innerHeight: 2_160,
    devicePixelRatio: 3,
  });
  load(runtime);
  let commits = 0;
  const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });

  runtime.runFrame(10_000);
  runtime.context.innerWidth = 1_920;
  runtime.context.innerHeight = 1_080;
  runtime.triggerWindow("resize");
  runtime.runFrame(10_325);
  assert.equal(commits, 0);
  runtime.runFrame(10_326);
  assert.equal(commits, 1);
  runtime.triggerWindow("resize");
  runtime.runFrame(10_680);
  await transition.finished;

  for (const [width, height] of runtime.canvasSizes) {
    assert.ok(width * height <= 1_200_000);
  }
  assert.ok(gl.drawCalls.every((entry) => entry.kind === "arrays" && entry.count === 3));
  assert.ok(runtime.firstCanvasSize.width < Math.round(3_840 * 1.25));
  assert.ok(runtime.firstCanvasSize.height < Math.round(2_160 * 1.25));
  assert.equal(commits, 1);
  assertClean(runtime);
});

test("obsidian silk transition fully releases RAF, listeners, GPU state, canvas, and busy markers", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  load(runtime);
  const transition = createTransition(runtime);
  runtime.runFrame(0);
  runtime.runFrame(680);
  await transition.finished;

  assert.equal(runtime.cancelledFrames.length, 1);
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.deletedVertexArrays.length, 1);
  assert.equal(gl.lostContexts, 1);
  assert.equal(runtime.canvas.width, 1);
  assert.equal(runtime.canvas.height, 1);
  assertClean(runtime);
});

type RuntimeFailure = { runtime: "getContext" | "nullContext" | "append" };
type GlFailure = { gl: "shader" | "compile" | "program" | "link" | "vao" | "uniform" | "viewport" | "draw" };

function createTransition(runtime: ReturnType<typeof waveRuntime>, overrides: Record<string, unknown> = {}) {
  return runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    direction: 1,
    commit: () => true,
    ...overrides,
  });
}

function load(runtime: ReturnType<typeof waveRuntime>) {
  vm.runInNewContext(waveSource, runtime.context);
}

function waveRuntime(gl: ReturnType<typeof fakeGl>, options: {
  reducedMotion?: boolean;
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
  failRuntime?: "getContext" | "nullContext" | "append" | "initialRaf";
} = {}) {
  const bodyClasses = new Set<string>();
  const bodyAttributes = new Map<string, string>();
  const canvasListeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const windowListeners = new Map<string, (...args: any[]) => void>();
  const documentListeners = new Map<string, (...args: any[]) => void>();
  const motionListeners = new Map<string, (...args: any[]) => void>();
  const contextRequests: Array<{ name: string; options: Record<string, unknown> }> = [];
  const canvasSizes: Array<[number, number]> = [];
  const cancelledFrames: number[] = [];
  let canvasWidth = 0;
  let canvasHeight = 0;
  let frame: ((now: number) => void) | undefined;
  let frameId = 0;
  const canvas = {
    className: "",
    removed: true,
    set width(value: number) {
      canvasWidth = value;
    },
    get width() { return canvasWidth; },
    set height(value: number) {
      canvasHeight = value;
      if (canvasWidth > 0) canvasSizes.push([canvasWidth, canvasHeight]);
    },
    get height() { return canvasHeight; },
    setAttribute() {},
    getContext(name: string, contextOptions: Record<string, unknown>) {
      contextRequests.push({ name, options: { ...contextOptions } });
      if (options.failRuntime === "getContext") throw new Error("synthetic getContext failure");
      if (options.failRuntime === "nullContext") return null;
      return gl;
    },
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
      canvasListeners.set(name, listener);
    },
    removeEventListener(name: string) { canvasListeners.delete(name); },
    remove() { this.removed = true; },
  };
  const motion = {
    matches: Boolean(options.reducedMotion),
    addEventListener(name: string, listener: (...args: any[]) => void) { motionListeners.set(name, listener); },
    removeEventListener(name: string) { motionListeners.delete(name); },
  };
  const context = {
    console,
    Promise,
    Float32Array,
    Math,
    Object,
    Error,
    WebGL2RenderingContext: class {},
    innerWidth: options.innerWidth ?? 1_200,
    innerHeight: options.innerHeight ?? 800,
    devicePixelRatio: options.devicePixelRatio ?? 2,
    matchMedia: () => motion,
    requestAnimationFrame(callback: (now: number) => void) {
      if (options.failRuntime === "initialRaf" && frameId === 0) throw new Error("synthetic RAF failure");
      frame = callback;
      frameId += 1;
      return frameId;
    },
    cancelAnimationFrame(id: number) { cancelledFrames.push(id); },
    addEventListener(name: string, listener: (...args: any[]) => void) { windowListeners.set(name, listener); },
    removeEventListener(name: string) { windowListeners.delete(name); },
    document: {
      hidden: false,
      createElement: () => canvas,
      addEventListener(name: string, listener: (...args: any[]) => void) { documentListeners.set(name, listener); },
      removeEventListener(name: string) { documentListeners.delete(name); },
      body: {
        append() {
          if (options.failRuntime === "append") throw new Error("synthetic append failure");
          canvas.removed = false;
        },
        classList: {
          add: (value: string) => bodyClasses.add(value),
          remove: (value: string) => bodyClasses.delete(value),
        },
        setAttribute: (name: string, value: string) => bodyAttributes.set(name, value),
        removeAttribute: (name: string) => bodyAttributes.delete(name),
      },
    },
  } as Record<string, any>;
  context.globalThis = context;
  return {
    context,
    canvas,
    bodyClasses,
    bodyAttributes,
    canvasListeners,
    windowListeners,
    documentListeners,
    motionListeners,
    contextRequests,
    canvasSizes,
    cancelledFrames,
    get firstCanvasSize() {
      const first = canvasSizes.find(([width, height]) => width > 1 && height > 1) ?? [0, 0];
      return { width: first[0], height: first[1] };
    },
    runFrame(now: number) {
      const active = frame;
      assert.ok(active, "expected an active animation frame");
      active(now);
    },
    triggerCanvas(name: string) { canvasListeners.get(name)?.({ preventDefault() {} }); },
    triggerDocument(name: string) { documentListeners.get(name)?.(); },
    triggerWindow(name: string) { windowListeners.get(name)?.({}); },
    triggerMotion(matches: boolean) {
      motion.matches = matches;
      motionListeners.get("change")?.({ matches });
    },
  };
}

function fakeGl(failure?: "shader" | "compile" | "program" | "link" | "vao" | "uniform" | "viewport" | "draw") {
  let programCount = 0;
  let vaoCount = 0;
  let lostContexts = 0;
  let shaderCount = 0;
  const deletedPrograms: object[] = [];
  const deletedVertexArrays: object[] = [];
  const drawCalls: Array<{
    kind: "arrays" | "instanced";
    mode: number;
    first: number;
    count: number;
    instances?: number;
  }> = [];
  const uniformScalars: Array<{ name?: string; value: number }> = [];
  const uniformPairs: Array<{ name?: string; x: number; y: number }> = [];
  const shaderSources: string[] = [];
  const forbiddenCalls: string[] = [];
  const events: string[] = [];
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    COLOR_BUFFER_BIT: 5,
    TRIANGLES: 6,
    DEPTH_BUFFER_BIT: 8,
    BLEND: 9,
    DEPTH_TEST: 10,
    ONE: 11,
    ONE_MINUS_SRC_ALPHA: 12,
    LEQUAL: 13,
    deletedPrograms,
    deletedVertexArrays,
    drawCalls,
    uniformScalars,
    uniformPairs,
    shaderSources,
    forbiddenCalls,
    events,
    failViewport: false,
    get createdPrograms() { return programCount; },
    get createdVertexArrays() { return vaoCount; },
    get lostContexts() { return lostContexts; },
    getExtension(name: string) {
      return name === "WEBGL_lose_context" ? { loseContext() { lostContexts += 1; } } : null;
    },
    createShader() {
      shaderCount += 1;
      return failure === "shader" && shaderCount === 2 ? null : {};
    },
    shaderSource(_shader: object, source: string) { shaderSources.push(source); },
    compileShader() {},
    getShaderParameter: () => failure !== "compile",
    getShaderInfoLog: () => "synthetic shader failure",
    deleteShader() {},
    createProgram() {
      programCount += 1;
      return failure === "program" ? null : {};
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => failure !== "link",
    getProgramInfoLog: () => "synthetic link failure",
    deleteProgram(value: object) { deletedPrograms.push(value); },
    createVertexArray() {
      vaoCount += 1;
      return failure === "vao" ? null : {};
    },
    bindVertexArray() {},
    deleteVertexArray(value: object) { deletedVertexArrays.push(value); },
    getUniformLocation: (_program: object, name: string) => failure === "uniform" && name === "u_elapsedMs" ? null : ({ name }),
    viewport() {
      if (failure === "viewport" || gl.failViewport) throw new Error("synthetic viewport failure");
    },
    uniform1f(location: { name?: string }, value: number) { uniformScalars.push({ name: location?.name, value }); },
    uniform1i(location: { name?: string }, value: number) { uniformScalars.push({ name: location?.name, value }); },
    uniform2f(location: { name?: string }, x: number, y: number) { uniformPairs.push({ name: location?.name, x, y }); },
    uniform3fv() {},
    clearColor() {},
    clearDepth() {},
    clear() {},
    useProgram() {},
    enable() {},
    disable() {},
    blendFunc() {},
    depthFunc() {},
    drawArrays(mode: number, first: number, count: number) {
      events.push("draw");
      drawCalls.push({ kind: "arrays", mode, first, count });
      if (failure === "draw") throw new Error("synthetic draw failure");
    },
    drawArraysInstanced(mode: number, first: number, count: number, instances: number) {
      forbiddenCalls.push("drawArraysInstanced");
      drawCalls.push({ kind: "instanced", mode, first, count, instances });
    },
    createBuffer() { forbiddenCalls.push("createBuffer"); return {}; },
    bindBuffer() { forbiddenCalls.push("bindBuffer"); },
    bufferData() { forbiddenCalls.push("bufferData"); },
    createTexture() { forbiddenCalls.push("createTexture"); return {}; },
    createFramebuffer() { forbiddenCalls.push("createFramebuffer"); return {}; },
    readPixels() { forbiddenCalls.push("readPixels"); },
  };
  return gl;
}

function assertClean(runtime: ReturnType<typeof waveRuntime>) {
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(runtime.bodyAttributes.has("aria-busy"), false);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(runtime.canvasListeners.size, 0);
  assert.equal(runtime.windowListeners.size, 0);
  assert.equal(runtime.documentListeners.size, 0);
  assert.equal(runtime.motionListeners.size, 0);
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
