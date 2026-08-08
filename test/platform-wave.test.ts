import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const waveSource = readFileSync(join(process.cwd(), "web", "platform-wave.js"), "utf8");

test("modular block transition honors reduced motion without requesting WebGL", async () => {
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

test("modular block transition uses the frozen WebGL2 context and one fullscreen triangle", async () => {
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
  assert.deepEqual(gl.drawCalls, [{ mode: gl.TRIANGLES, first: 0, count: 3 }]);
  assert.equal(gl.createdPrograms, 1);
  assert.equal(gl.createdVertexArrays, 1);
  assert.equal(gl.forbiddenCalls.length, 0);
  assert.ok(gl.uniformPairs.some(({ name, x, y }) => name === "u_resolution" && x === 1_200 && y === 800));
  assert.match(gl.shaderSources.join("\n"), /gl_VertexID/);
  assert.match(gl.shaderSources.join("\n"), /fwidth/);
  assert.match(gl.shaderSources.join("\n"), /blockGrid/);
  assert.match(gl.shaderSources.join("\n"), /floor\(blockSpace\)/);
  assert.match(gl.shaderSources.join("\n"), /fract\(blockSpace\) - 0\.5/);
  assert.match(gl.shaderSources.join("\n"), /blockFace/);
  assert.doesNotMatch(gl.shaderSources.join("\n"), /curtain|contourIndex/);
  assert.equal(waveSource.includes("Math.random"), false);
  assert.equal(/\.style\.(?:transform|opacity|filter|willChange)\s*=/.test(waveSource), false);

  transition.cancel();
  await transition.finished;
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.deletedVertexArrays.length, 1);
  assertClean(runtime);
});

test("modular block transition supports a reversible diagonal wave and an aspect-correct ripple", async () => {
  const diagonalGl = fakeGl();
  const diagonalRuntime = waveRuntime(diagonalGl);
  load(diagonalRuntime);
  const diagonal = createTransition(diagonalRuntime, { direction: -1 });
  diagonalRuntime.runFrame(0);
  assert.ok(diagonalGl.uniformScalars.some(({ name, value }) => name === "u_pattern" && value === 0));
  assert.ok(diagonalGl.uniformScalars.some(({ name, value }) => name === "u_direction" && value === -1));
  diagonal.cancel();
  await diagonal.finished;
  assertClean(diagonalRuntime);

  const rippleGl = fakeGl();
  const rippleRuntime = waveRuntime(rippleGl, { innerWidth: 390, innerHeight: 844 });
  load(rippleRuntime);
  const ripple = createTransition(rippleRuntime, { pattern: "ripple" });
  rippleRuntime.runFrame(0);
  assert.ok(rippleGl.uniformScalars.some(({ name, value }) => name === "u_pattern" && value === 1));
  const shader = rippleGl.shaderSources.join("\n");
  assert.match(shader, /\(center\.x \+ center\.y\) \* 0\.5/);
  assert.match(shader, /radialPoint = \(center - 0\.5\) \* vec2\(aspect, 1\.0\)/);
  assert.match(shader, /length\(radialPoint\) \/ radialMaximum/);
  assert.match(shader, /mix\(diagonal \+ diagonalWave, radius \+ rippleWave, step\(0\.5, u_pattern\)\)/);
  ripple.cancel();
  await ripple.finished;
  assertClean(rippleRuntime);

  const invalidGl = fakeGl();
  const invalidRuntime = waveRuntime(invalidGl);
  load(invalidRuntime);
  const invalid = createTransition(invalidRuntime, { pattern: "future-pattern" });
  invalidRuntime.runFrame(0);
  assert.ok(invalidGl.uniformScalars.some(({ name, value }) => name === "u_pattern" && value === 0));
  invalid.cancel();
  await invalid.finished;
  assertClean(invalidRuntime);
});

test("modular block geometry stays continuous at the 90ms and 590ms modulation points", () => {
  const easeInOut = (value: number) => {
    const bounded = Math.min(1, Math.max(0, value));
    return bounded * bounded * (3 - 2 * bounded);
  };
  const coverHalfSize = (elapsedMs: number, order: number) => {
    const covering = easeInOut(elapsedMs / 326);
    const local = Math.min(1, Math.max(0, (covering - order * 0.78) / 0.22));
    const scale = easeInOut(local);
    const joining = easeInOut((covering - 0.82) / 0.18);
    const gap = 0.070 * (1 - joining);
    return Math.max(0, (0.5 - gap) * scale);
  };
  const coverPulse = (elapsedMs: number, order: number) => {
    const covering = easeInOut(elapsedMs / 326);
    const local = Math.min(1, Math.max(0, (covering - order * 0.78) / 0.22));
    const joining = easeInOut((covering - 0.82) / 0.18);
    const attack = easeInOut(elapsedMs / 90);
    return Math.sin(local * Math.PI) * attack * (1 - joining * 0.45);
  };
  const revealHalfSize = (elapsedMs: number, order: number) => {
    const revealing = easeInOut((elapsedMs - 326) / (680 - 326));
    const local = Math.min(1, Math.max(0, (revealing - order * 0.78) / 0.22));
    const remaining = 1 - easeInOut(local);
    const tailFade = 1 - easeInOut((elapsedMs - 590) / (680 - 590));
    return 0.5 * remaining * (0.82 + 0.18 * tailFade);
  };
  const revealPulse = (elapsedMs: number, order: number) => {
    const revealing = easeInOut((elapsedMs - 326) / (680 - 326));
    const local = Math.min(1, Math.max(0, (revealing - order * 0.78) / 0.22));
    const tailFade = 1 - easeInOut((elapsedMs - 590) / (680 - 590));
    return Math.sin(local * Math.PI) * tailFade;
  };

  assert.ok(Math.abs(coverHalfSize(89.999, 0.18) - coverHalfSize(90.001, 0.18)) < 0.0001);
  assert.ok(Math.abs(coverPulse(89.999, 0.18) - coverPulse(90.001, 0.18)) < 0.0001);
  assert.ok(Math.abs(revealHalfSize(589.999, 0.82) - revealHalfSize(590.001, 0.82)) < 0.0001);
  assert.ok(Math.abs(revealPulse(589.999, 0.82) - revealPulse(590.001, 0.82)) < 0.0001);
  assert.equal(coverHalfSize(326, 1), 0.5, "the last block must close the viewport at commit");
  assert.equal(revealHalfSize(326, 0), 0.5, "reveal must inherit the fully covered geometry");
  assert.equal(revealHalfSize(680, 1), 0, "the final tail must be fully removed");
  assert.match(waveSource, /float covering = easeInOut\(elapsedMs \/ COVER_END\)/);
  assert.match(waveSource, /float attack = easeInOut\(clamp\(elapsedMs \/ ATTACK_END/);
  assert.match(waveSource, /float pulse = sin\(localProgress \* 3\.14159265\) \* attack \* \(1\.0 - joining \* 0\.45\)/);
  assert.match(waveSource, /float revealing = easeInOut\(\(elapsedMs - COVER_END\) \/ \(RELEASE_END - COVER_END\)\)/);
  assert.match(waveSource, /float pulse = sin\(localProgress \* 3\.14159265\) \* tailFade/);
  assert.doesNotMatch(waveSource, /else if \(elapsedMs < REVEAL_END\)/);
});

test("modular block transition commits once at the 326ms fully opaque handoff", async () => {
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
  assert.match(gl.shaderSources.join("\n"), /elapsedMs\s*>=\s*COVER_END/);
  assert.match(gl.shaderSources.join("\n"), /alpha\s*=\s*1\.0/);
  assert.match(gl.shaderSources.join("\n"), /sourceTarget = mix\(u_sourceMatte, u_targetMatte/);
  assert.match(gl.shaderSources.join("\n"), /commitAccent = mix\(u_sourceAccent, u_targetAccent/);
  assertClean(runtime);
});

test("modular block transition cancel before commit preserves source and after commit preserves target", async () => {
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

test("modular block transition preserves commit false and commit errors without hanging", async () => {
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

test("modular block transition immediately commits and releases every partial setup failure", async (t) => {
  const cases: Array<[string, GlFailure | RuntimeFailure]> = [
    ["getContext throw", { runtime: "getContext" }],
    ["getContext null", { runtime: "nullContext" }],
    ["shader allocation", { gl: "shader" }],
    ["shader compile", { gl: "compile" }],
    ["program allocation", { gl: "program" }],
    ["program link", { gl: "link" }],
    ["VAO allocation", { gl: "vao" }],
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

test("modular block transition converts draw and resize exceptions into an immediate committed settlement", async (t) => {
  for (const failure of ["draw", "viewport"] as const) {
    await t.test(failure, async () => {
      const gl = fakeGl(failure === "draw" ? "draw" : undefined);
      const runtime = waveRuntime(gl);
      load(runtime);
      let commits = 0;
      const transition = createTransition(runtime, { commit: () => { commits += 1; return true; } });
      if (failure === "draw") runtime.runFrame(0);
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

test("modular block transition releases a fully initialized renderer when the first RAF request throws", async () => {
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

test("modular block transition responds to context loss before and after handoff exactly once", async () => {
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

test("modular block transition settles on dynamic reduced motion, hidden state, and pagehide", async (t) => {
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

test("modular block transition resize preserves its clock, commit count, DPR cap, and pixel budget", async () => {
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
    assert.ok(width * height <= 1_600_000);
  }
  assert.ok(runtime.firstCanvasSize.width < Math.round(3_840 * 1.25));
  assert.ok(runtime.firstCanvasSize.height < Math.round(2_160 * 1.25));
  assert.equal(commits, 1);
  assertClean(runtime);
});

test("modular block transition fully releases RAF, listeners, GPU state, canvas, and busy markers", async () => {
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
type GlFailure = { gl: "shader" | "compile" | "program" | "link" | "vao" | "viewport" };

function createTransition(runtime: ReturnType<typeof waveRuntime>, overrides: Record<string, unknown> = {}) {
  return runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    direction: 1,
    sourceAnchor: { x: 0.25, y: 0.04 },
    targetAnchor: { x: 0.75, y: 0.04 },
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

function fakeGl(failure?: "shader" | "compile" | "program" | "link" | "vao" | "viewport" | "draw") {
  let programCount = 0;
  let vaoCount = 0;
  let lostContexts = 0;
  let shaderCount = 0;
  const deletedPrograms: object[] = [];
  const deletedVertexArrays: object[] = [];
  const drawCalls: Array<{ mode: number; first: number; count: number }> = [];
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
    getUniformLocation: (_program: object, name: string) => ({ name }),
    viewport() {
      if (failure === "viewport" || gl.failViewport) throw new Error("synthetic viewport failure");
    },
    uniform1f(location: { name?: string }, value: number) { uniformScalars.push({ name: location?.name, value }); },
    uniform2f(location: { name?: string }, x: number, y: number) { uniformPairs.push({ name: location?.name, x, y }); },
    uniform3fv() {},
    clearColor() {},
    clear() {},
    useProgram() {},
    drawArrays(mode: number, first: number, count: number) {
      events.push("draw");
      drawCalls.push({ mode, first, count });
      if (failure === "draw") throw new Error("synthetic draw failure");
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
