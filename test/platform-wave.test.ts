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
  const gl = fakeGl({ failProgramAt: 2 });
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
  runtime.frame?.(1_000);
  const outcome = await transition.finished;

  assert.equal(outcome.committed, false);
  assert.equal(outcome.completed, true);
  assert.equal(outcome.renderer, "webgl2");
  assert.match(String(outcome.commitError), /synthetic commit failure/);
  assert.equal(runtime.bodyClasses.has("platform-switching"), false);
  assert.equal(runtime.bodyAttributes.has("aria-busy"), false);
  assert.equal(runtime.canvas.removed, true);
  assert.equal(gl.deletedPrograms.length, 2);
  assert.equal(gl.deletedBuffers.length, 2);
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

function waveRuntime(gl: ReturnType<typeof fakeGl>, options: { reducedMotion?: boolean } = {}) {
  const bodyClasses = new Set<string>();
  const bodyAttributes = new Map<string, string>();
  const canvasListeners = new Map<string, (event: { preventDefault(): void }) => void>();
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
  const motion = { matches: Boolean(options.reducedMotion), addEventListener() {}, removeEventListener() {} };
  const context = {
    console,
    Promise,
    Float32Array,
    Math,
    Object,
    Error,
    WebGL2RenderingContext: class {},
    HTMLElement: class {},
    innerWidth: 1_200,
    innerHeight: 800,
    devicePixelRatio: 2,
    performance: { now: () => 0 },
    matchMedia: () => motion,
    requestAnimationFrame(callback: (now: number) => void) { frame = callback; return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    document: {
      hidden: false,
      createElement: () => canvas,
      addEventListener() {},
      removeEventListener() {},
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
    get frame() { return frame; },
    triggerCanvas(name: string) { canvasListeners.get(name)?.({ preventDefault() {} }); },
  };
}

function fakeGl(options: { failProgramAt?: number; failDrawAt?: number } = {}) {
  let programCount = 0;
  let drawCount = 0;
  let lostContexts = 0;
  const deletedPrograms: object[] = [];
  const deletedBuffers: object[] = [];
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
    createBuffer: () => ({}),
    deleteBuffer(value: object) { deletedBuffers.push(value); },
    bindBuffer() {},
    bufferData() {},
    getUniformLocation: () => ({}),
    viewport() {},
    uniform1f() {},
    uniform3fv() {},
    clearColor() {},
    clear() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    drawArrays() {
      drawCount += 1;
      if (options.failDrawAt === drawCount) throw new Error("synthetic draw failure");
    },
  };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
