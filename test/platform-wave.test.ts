import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const waveSource = readFileSync(join(process.cwd(), "web", "platform-wave.js"), "utf8");

test("platform wave honors reduced motion without allocating WebGL resources", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl, { reducedMotion: true });
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;

  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { commits += 1; },
  });
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "none" });
  assert.equal(gl.createdPrograms, 0);
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
});

test("platform wave falls back to an immediate commit and releases partial WebGL setup", async () => {
  const gl = fakeGl({ failBufferAt: 1 });
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;

  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { commits += 1; },
  });
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), {
    committed: true,
    completed: true,
    renderer: "none",
  });
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.lostContexts, 1);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
});

test("platform wave cleans up and settles when the animated commit throws", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);

  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { throw new Error("synthetic commit failure"); },
  });
  assert.equal(runtime.bodyClasses.has("platform-switching"), true);
  assert.ok(runtime.frame);
  runtime.frame?.(0);
  runtime.frame?.(1_000);
  const outcome = await transition.finished;

  assert.equal(outcome.committed, false);
  assert.equal(outcome.completed, true);
  assert.equal(outcome.renderer, "webgl2");
  assert.match(String(outcome.commitError), /synthetic commit failure/);
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(runtime.bodyAttributes.has("aria-busy"), false);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.deletedBuffers.length, 1);
  assert.equal(gl.lostContexts, 1);
});

test("platform wave cancellation before commit settles without changing platform", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { commits += 1; },
  });

  transition.cancel();
  const outcome = await transition.finished;

  assert.equal(commits, 0);
  assert.deepEqual(plain(outcome), { committed: false, completed: false, renderer: "webgl2" });
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(gl.lostContexts, 1);
});

test("platform wave cancellation after commit preserves the committed platform and releases GPU state", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { commits += 1; },
  });

  runtime.frame?.(0);
  runtime.frame?.(400);
  transition.cancel();
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: false, renderer: "webgl2" });
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(gl.lostContexts, 1);
});

test("platform wave settles and commits after a runtime draw failure", async () => {
  const gl = fakeGl({ failDrawAt: 1 });
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { commits += 1; },
  });

  runtime.frame?.(10);
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "webgl2" });
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(gl.lostContexts, 1);
});

test("platform wave renders a deterministic full-viewport point matrix without moving the GUI", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl, { innerWidth: 1_200, innerHeight: 800 });
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const motionLayer = { style: { transform: "stable", willChange: "auto" } };
  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [motionLayer],
    commit: () => { commits += 1; },
  });

  assert.equal(gl.uploads.length, 1);
  const points = gl.uploads[0];
  assert.ok(points instanceof Float32Array);
  assert.equal(points.length, 41 * 28 * 2);
  assert.equal(points.length % 2, 0);
  assert.equal(points[1], points[3]);
  assert.notEqual(points[0], points[2]);
  assert.equal(points[0], points[41 * 2]);
  assert.notEqual(points[1], points[41 * 2 + 1]);
  assert.equal(waveSource.includes("Math.random"), false);
  assert.equal(waveSource.includes("style.transform"), false);
  assert.deepEqual(motionLayer.style, { transform: "stable", willChange: "auto" });

  runtime.frame?.(2_000);
  assert.equal(gl.drawCalls.length, 1);
  assert.deepEqual(gl.drawCalls[0], { mode: gl.POINTS, first: 0, count: 41 * 28 });
  const firstProgress = gl.uniformScalars.find((entry) => entry.name === "u_progress");
  assert.equal(firstProgress?.value, 0);

  runtime.frame?.(2_380);
  assert.equal(commits, 1);
  transition.cancel();
  await transition.finished;
  assert.equal(gl.deletedPrograms.length, 1);
  assert.equal(gl.deletedBuffers.length, 1);
});

test("platform wave keeps a bounded but visible matrix on a narrow tall viewport", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl, { innerWidth: 390, innerHeight: 844 });
  vm.runInNewContext(waveSource, runtime.context);
  const transition = runtime.context.PlatformWaveTransition.create({ commit() {} });

  const points = gl.uploads[0];
  assert.equal(points.length, 19 * 30 * 2);
  assert.ok(points.length / 2 >= 500);
  assert.ok(points.length / 2 <= 58 * 36);
  transition.cancel();
  await transition.finished;
});

test("platform wave immediately settles when reduced motion becomes active", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const transition = runtime.context.PlatformWaveTransition.create({ commit: () => { commits += 1; } });

  runtime.triggerMotion(true);
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "webgl2" });
  assert.equal(runtime.windowListeners.size, 0);
  assert.equal(runtime.documentListeners.size, 0);
  assert.equal(runtime.motionListeners.size, 0);
  assert.equal(runtime.canvas.removed, true);
});

test("platform wave immediately settles when the document becomes hidden", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const transition = runtime.context.PlatformWaveTransition.create({ commit: () => { commits += 1; } });

  runtime.context.document.hidden = true;
  runtime.triggerDocument("visibilitychange");
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "webgl2" });
  assert.equal(runtime.windowListeners.size, 0);
  assert.equal(runtime.documentListeners.size, 0);
  assert.equal(runtime.canvas.removed, true);
});

test("platform wave context loss commits once and clears DOM state", async () => {
  const gl = fakeGl();
  const runtime = waveRuntime(gl);
  vm.runInNewContext(waveSource, runtime.context);
  let commits = 0;
  const transition = runtime.context.PlatformWaveTransition.create({
    sourcePlatform: "netease",
    targetPlatform: "qq",
    motionLayers: [],
    commit: () => { commits += 1; },
  });

  runtime.triggerCanvas("webglcontextlost");
  const outcome = await transition.finished;

  assert.equal(commits, 1);
  assert.deepEqual(plain(outcome), { committed: true, completed: true, renderer: "webgl2" });
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(gl.lostContexts, 0);
});

function waveRuntime(gl: ReturnType<typeof fakeGl>, options: {
  reducedMotion?: boolean;
  innerWidth?: number;
  innerHeight?: number;
} = {}) {
  const bodyClasses = new Set<string>();
  const bodyAttributes = new Map<string, string>();
  const canvasListeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const windowListeners = new Map<string, (...args: any[]) => void>();
  const documentListeners = new Map<string, (...args: any[]) => void>();
  const motionListeners = new Map<string, (...args: any[]) => void>();
  const canvas = {
    className: "",
    width: 0,
    height: 0,
    removed: false,
    setAttribute() {},
    getContext: () => gl,
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) { canvasListeners.set(name, listener); },
    removeEventListener(name: string) { canvasListeners.delete(name); },
    remove() { this.removed = true; },
  };
  let frame: ((now: number) => void) | undefined;
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
    HTMLElement: class {},
    innerWidth: options.innerWidth ?? 1_200,
    innerHeight: options.innerHeight ?? 800,
    devicePixelRatio: 2,
    performance: { now: () => 0 },
    matchMedia: () => motion,
    requestAnimationFrame(callback: (now: number) => void) { frame = callback; return 1; },
    cancelAnimationFrame() {},
    addEventListener(name: string, listener: (...args: any[]) => void) { windowListeners.set(name, listener); },
    removeEventListener(name: string) { windowListeners.delete(name); },
    document: {
      hidden: false,
      createElement: () => canvas,
      addEventListener(name: string, listener: (...args: any[]) => void) { documentListeners.set(name, listener); },
      removeEventListener(name: string) { documentListeners.delete(name); },
      body: {
        append() { canvas.removed = false; },
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
    windowListeners,
    documentListeners,
    motionListeners,
    get frame() { return frame; },
    triggerCanvas(name: string) { canvasListeners.get(name)?.({ preventDefault() {} }); },
    triggerDocument(name: string) { documentListeners.get(name)?.(); },
    triggerMotion(matches: boolean) { motion.matches = matches; motionListeners.get("change")?.({ matches }); },
  };
}

function fakeGl(options: { failProgramAt?: number; failBufferAt?: number; failDrawAt?: number } = {}) {
  let programCount = 0;
  let bufferCount = 0;
  let drawCount = 0;
  let lostContexts = 0;
  const deletedPrograms: object[] = [];
  const deletedBuffers: object[] = [];
  const uploads: Float32Array[] = [];
  const drawCalls: Array<{ mode: number; first: number; count: number }> = [];
  const uniformScalars: Array<{ name?: string; value: number }> = [];
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    COLOR_BUFFER_BIT: 7,
    BLEND: 8,
    ONE: 9,
    ONE_MINUS_SRC_ALPHA: 10,
    TRIANGLE_STRIP: 11,
    POINTS: 12,
    FLOAT: 13,
    deletedPrograms,
    deletedBuffers,
    uploads,
    drawCalls,
    uniformScalars,
    get createdPrograms() { return programCount; },
    get lostContexts() { return lostContexts; },
    getExtension(name: string) {
      return name === "WEBGL_lose_context" ? { loseContext() { lostContexts += 1; } } : null;
    },
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader() {},
    createProgram() {
      programCount += 1;
      return options.failProgramAt === programCount ? null : {};
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram(value: object) { deletedPrograms.push(value); },
    createBuffer() {
      bufferCount += 1;
      return options.failBufferAt === bufferCount ? null : {};
    },
    deleteBuffer(value: object) { deletedBuffers.push(value); },
    bindBuffer() {},
    bufferData(_target: number, value: Float32Array) { uploads.push(new Float32Array(value)); },
    getUniformLocation: (_program: object, name: string) => ({ name }),
    viewport() {},
    uniform1f(location: { name?: string }, value: number) { uniformScalars.push({ name: location?.name, value }); },
    uniform3fv() {},
    clearColor() {},
    clear() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    drawArrays(mode: number, first: number, count: number) {
      drawCount += 1;
      drawCalls.push({ mode, first, count });
      if (options.failDrawAt === drawCount) throw new Error("synthetic draw failure");
    },
  };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
