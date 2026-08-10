import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const trailSource = readFileSync(join(process.cwd(), "web", "pointer-silk-trail.js"), "utf8");

type Listener = (...args: any[]) => void;
type Failure = "shader" | "compile" | "program" | "link" | "vao" | "buffer" | "uniform" | "viewport" | "upload" | "draw";

function fakeGl(failure?: Failure) {
  let shaderCount = 0;
  let createdPrograms = 0;
  let createdVertexArrays = 0;
  let createdBuffers = 0;
  let lostContexts = 0;
  const drawCalls: Array<{ mode: number; first: number; count: number }> = [];
  const colorUniforms: Array<{ name?: string; value: number[] }> = [];
  const scalarUniforms: Array<{ name?: string; value: number }> = [];
  const pairUniforms: Array<{ name?: string; x: number; y: number }> = [];
  const shaderSources: string[] = [];
  const deletedPrograms: object[] = [];
  const deletedVertexArrays: object[] = [];
  const deletedBuffers: object[] = [];
  const uploadSnapshots: number[][] = [];
  let uploads = 0;
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    DYNAMIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLE_STRIP: 8,
    COLOR_BUFFER_BIT: 9,
    DEPTH_TEST: 10,
    BLEND: 11,
    ONE: 12,
    ONE_MINUS_SRC_ALPHA: 13,
    drawCalls,
    colorUniforms,
    scalarUniforms,
    pairUniforms,
    shaderSources,
    deletedPrograms,
    deletedVertexArrays,
    deletedBuffers,
    uploadSnapshots,
    get createdPrograms() { return createdPrograms; },
    get createdVertexArrays() { return createdVertexArrays; },
    get createdBuffers() { return createdBuffers; },
    get lostContexts() { return lostContexts; },
    get uploads() { return uploads; },
    getExtension(name: string) {
      return name === "WEBGL_lose_context" ? { loseContext() { lostContexts += 1; } } : null;
    },
    createShader() {
      shaderCount += 1;
      return failure === "shader" && shaderCount === 2 ? null : {};
    },
    shaderSource(_shader: object, source: string) { shaderSources.push(source); },
    compileShader() {},
    getShaderParameter() { return failure !== "compile"; },
    getShaderInfoLog() { return "synthetic shader failure"; },
    deleteShader() {},
    createProgram() {
      createdPrograms += 1;
      return failure === "program" ? null : {};
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return failure !== "link"; },
    getProgramInfoLog() { return "synthetic link failure"; },
    deleteProgram(value: object) { deletedPrograms.push(value); },
    createVertexArray() {
      createdVertexArrays += 1;
      return failure === "vao" ? null : {};
    },
    bindVertexArray() {},
    deleteVertexArray(value: object) { deletedVertexArrays.push(value); },
    createBuffer() {
      createdBuffers += 1;
      return failure === "buffer" ? null : {};
    },
    bindBuffer() {},
    bufferData() {},
    bufferSubData(_target: number, _offset: number, data: Float32Array) {
      if (failure === "upload") throw new Error("synthetic upload failure");
      uploads += 1;
      uploadSnapshots.push(Array.from(data));
    },
    deleteBuffer(value: object) { deletedBuffers.push(value); },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getUniformLocation(_program: object, name: string) {
      return failure === "uniform" && name === "u_opacity" ? null : { name };
    },
    viewport() {
      if (failure === "viewport") throw new Error("synthetic viewport failure");
    },
    useProgram() {},
    uniform1f(location: { name?: string }, value: number) {
      scalarUniforms.push({ name: location?.name, value });
    },
    uniform2f(location: { name?: string }, x: number, y: number) {
      pairUniforms.push({ name: location?.name, x, y });
    },
    uniform3fv(location: { name?: string }, value: Float32Array) {
      colorUniforms.push({ name: location?.name, value: Array.from(value) });
    },
    disable() {},
    enable() {},
    blendFunc() {},
    clearColor() {},
    clear() {},
    drawArrays(mode: number, first: number, count: number) {
      if (failure === "draw") throw new Error("synthetic draw failure");
      drawCalls.push({ mode, first, count });
    },
  };
  return gl;
}

function runtime(options: {
  reduced?: boolean;
  fine?: boolean;
  width?: number;
  height?: number;
  dpr?: number;
  contextNull?: boolean;
  contextThrows?: boolean;
  rafThrows?: boolean;
  failure?: Failure;
} = {}) {
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, (time: number) => void>();
  const hostListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  const media = new Map<string, { matches: boolean; listeners: Set<Listener> }>();
  const resizeObservers = new Set<{ callback: Listener; disconnected: boolean }>();
  const canvases: any[] = [];
  const contextRequests: Array<{ name: string; options: Record<string, unknown> }> = [];
  let contextAttempts = 0;
  const gl = fakeGl(options.failure);

  const host = {
    children: [] as any[],
    getBoundingClientRect() {
      return { left: 40, top: 60, width: options.width ?? 1_200, height: options.height ?? 800 };
    },
    appendChild(node: any) { this.children.push(node); node.parent = this; node.removed = false; },
    addEventListener(type: string, listener: Listener) {
      if (!hostListeners.has(type)) hostListeners.set(type, new Set());
      hostListeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: Listener) { hostListeners.get(type)?.delete(listener); },
    dispatch(type: string, event: Record<string, unknown>) {
      for (const listener of [...(hostListeners.get(type) ?? [])]) listener(event);
    },
  };

  const document = {
    hidden: false,
    createElement(tag: string) {
      assert.equal(tag, "canvas");
      const canvasListeners = new Map<string, Set<Listener>>();
      const canvas: any = {
        width: 0,
        height: 0,
        className: "",
        removed: true,
        attributes: new Map<string, string>(),
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        getContext(name: string, contextOptions: Record<string, unknown>) {
          contextAttempts += 1;
          contextRequests.push({ name, options: { ...contextOptions } });
          if (options.contextThrows) throw new Error("synthetic context failure");
          if (options.contextNull) return null;
          return gl;
        },
        addEventListener(type: string, listener: Listener) {
          if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
          canvasListeners.get(type)?.add(listener);
        },
        removeEventListener(type: string, listener: Listener) { canvasListeners.get(type)?.delete(listener); },
        dispatch(type: string) {
          for (const listener of [...(canvasListeners.get(type) ?? [])]) listener({});
        },
        remove() {
          this.removed = true;
          if (this.parent) this.parent.children = this.parent.children.filter((item: any) => item !== this);
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };

  const windowObject = {
    addEventListener(type: string, listener: Listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: Listener) { windowListeners.get(type)?.delete(listener); },
    dispatch(type: string) {
      for (const listener of [...(windowListeners.get(type) ?? [])]) listener({});
    },
  };

  const context: Record<string, any> = {
    document,
    window: windowObject,
    devicePixelRatio: options.dpr ?? 1,
    performance: { now: () => now },
    requestAnimationFrame(callback: (time: number) => void) {
      if (options.rafThrows) throw new Error("synthetic RAF failure");
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    matchMedia(query: string) {
      if (!media.has(query)) media.set(query, {
        matches: query.includes("reduced") ? Boolean(options.reduced) : options.fine !== false,
        listeners: new Set(),
      });
      const state = media.get(query)!;
      return {
        get matches() { return state.matches; },
        addEventListener(_type: string, listener: Listener) { state.listeners.add(listener); },
        removeEventListener(_type: string, listener: Listener) { state.listeners.delete(listener); },
      };
    },
    ResizeObserver: class {
      callback: Listener;
      disconnected = false;
      constructor(callback: Listener) {
        this.callback = callback;
        resizeObservers.add(this);
      }
      observe() {}
      disconnect() { this.disconnected = true; resizeObservers.delete(this); }
    },
    Float32Array,
    Math,
    Number,
    Object,
    Set,
    String,
    TypeError,
    Error,
  };
  context.globalThis = context;
  vm.runInNewContext(trailSource, context);
  return {
    context,
    host,
    canvases,
    gl,
    frames,
    contextRequests,
    get contextAttempts() { return contextAttempts; },
    listenerCount() {
      return [...hostListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
        + [...windowListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
        + [...media.values()].reduce((sum, entry) => sum + entry.listeners.size, 0)
        + resizeObservers.size;
    },
    setNow(value: number) { now = value; },
    runFrame(value: number) {
      now = value;
      const pending = [...frames.values()];
      frames.clear();
      assert.ok(pending.length > 0, "expected an active animation frame");
      for (const callback of pending) callback(value);
    },
    changeMedia(queryPart: string, matches: boolean) {
      const entry = [...media.entries()].find(([query]) => query.includes(queryPart))?.[1];
      assert.ok(entry);
      entry.matches = matches;
      for (const listener of [...entry.listeners]) listener({ matches });
    },
    triggerResize() {
      for (const observer of [...resizeObservers]) observer.callback([]);
    },
  };
}

test("pointer MeshLine trail lazily creates four WebGL2 strips and stops after 420ms idle", () => {
  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, platform: "netease", enabled: true });
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);

  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  assert.equal(app.host.children.length, 1);
  assert.equal(app.host.children[0].className, "pointer-silk-trail-canvas");
  assert.equal(app.host.children[0].attributes.get("aria-hidden"), "true");
  assert.equal(app.frames.size, 1);
  app.runFrame(16);

  assert.deepEqual(app.gl.drawCalls, [
    { mode: app.gl.TRIANGLE_STRIP, first: 0, count: 40 },
    { mode: app.gl.TRIANGLE_STRIP, first: 40, count: 40 },
    { mode: app.gl.TRIANGLE_STRIP, first: 80, count: 40 },
    { mode: app.gl.TRIANGLE_STRIP, first: 120, count: 40 },
  ]);
  assert.equal(app.gl.uploads, 1);
  assert.equal(app.frames.size, 1);
  app.runFrame(421);
  assert.equal(app.frames.size, 0);
  trail.destroy();
  assert.equal(app.host.children.length, 0);
  assert.equal(app.gl.lostContexts, 1);
  assert.equal(app.listenerCount(), 0);
});

test("pointer MeshLine trail uses the low-power bounded WebGL2 pipeline", () => {
  const app = runtime({ width: 3_840, height: 2_160, dpr: 2 });
  app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  const canvas = app.host.children[0];
  assert.deepEqual(app.contextRequests, [{
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
  assert.ok(canvas.width * canvas.height <= 800_000);
  assert.ok(canvas.width / 3_840 <= 1.25);
  assert.equal(app.gl.createdPrograms, 1);
  assert.equal(app.gl.createdVertexArrays, 1);
  assert.equal(app.gl.createdBuffers, 1);
  assert.match(app.gl.shaderSources.join("\n"), /layout\(location = 0\) in vec2 a_previous/);
  assert.match(app.gl.shaderSources.join("\n"), /miter = clamp/);
});

test("pointer MeshLine trail projects reference world width and offsets into a bounded CSS footprint", () => {
  const app = runtime({ width: 1_280, height: 720, dpr: 2 });
  app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  app.runFrame(16);
  for (let step = 1; step <= 10; step += 1) {
    const now = 16 + step * 16;
    app.setNow(now);
    app.host.dispatch("pointermove", {
      pointerType: "mouse",
      clientX: 180 + step * 48,
      clientY: 210 + (step % 2 === 0 ? 28 : -28),
    });
    app.runFrame(now);
  }
  const widths = app.gl.scalarUniforms
    .filter((entry) => entry.name === "u_lineWidth")
    .map((entry) => entry.value);
  const opacities = app.gl.scalarUniforms
    .filter((entry) => entry.name === "u_opacity")
    .map((entry) => entry.value);
  assert.ok(Math.max(...widths) >= 16, "sustained movement should no longer stay near the old 11px cap");
  assert.ok(Math.max(...widths) <= 22);
  assert.ok(Math.abs(Math.max(...opacities) - 0.76) < 0.0001);
});

test("pointer MeshLine trail propagates motion from tail to head across previous frames", () => {
  const app = runtime({ width: 1_280, height: 720 });
  app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 300 });
  app.runFrame(16);
  for (let step = 1; step <= 30; step += 1) {
    const now = 16 + step * 16;
    app.setNow(now);
    app.host.dispatch("pointermove", {
      pointerType: "mouse",
      clientX: 180 + step * 12,
      clientY: 300,
    });
    app.runFrame(now);
  }
  const vertices = app.gl.uploadSnapshots.at(-1)!;
  const headX = vertices[2];
  const headY = vertices[3];
  const tailBase = (19 * 2) * 9;
  const tailX = vertices[tailBase + 2];
  const tailY = vertices[tailBase + 3];
  assert.ok(Math.hypot(headX - tailX, headY - tailY) >= 120,
    "tail should preserve multi-frame propagation instead of collapsing in one frame");
});

test("pointer MeshLine trail keeps sustained fast circles inside a bounded envelope", () => {
  const centerX = 600;
  const centerY = 360;
  const radius = 100;
  for (const radiansPerFrame of [0.18, 0.2, 0.215, 0.265]) {
    const app = runtime({ width: 1_280, height: 720 });
    app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
    let largestTrailRadius = 0;
    for (let step = 0; step < 240; step += 1) {
      const now = 16 + step * 16;
      const angle = step * radiansPerFrame;
      app.setNow(now);
      app.host.dispatch("pointermove", {
        pointerType: "mouse",
        clientX: 40 + centerX + radius * Math.cos(angle),
        clientY: 60 + centerY + radius * Math.sin(angle),
      });
      app.runFrame(now);
      if (step < 120) continue;
      const vertices = app.gl.uploadSnapshots.at(-1)!;
      for (let line = 0; line < 4; line += 1) {
        const lineBase = line * 40 * 9;
        for (let point = 0; point < 20; point += 1) {
          const pointBase = lineBase + point * 2 * 9;
          largestTrailRadius = Math.max(largestTrailRadius,
            Math.hypot(vertices[pointBase + 2] - centerX, vertices[pointBase + 3] - centerY));
        }
      }
    }
    assert.ok(largestTrailRadius <= 160,
      `100px pointer circles at ${radiansPerFrame}rad/frame must stay inside 160px, got ${largestTrailRadius.toFixed(1)}px`);
  }
});

test("pointer MeshLine trail follows reduced-motion, fine-pointer, and pointer-type guards", () => {
  for (const options of [{ reduced: true }, { fine: false }]) {
    const app = runtime(options);
    app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
    app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
    assert.equal(app.host.children.length, 0);
    assert.equal(app.frames.size, 0);
  }
  const app = runtime();
  app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "touch", clientX: 180, clientY: 210 });
  app.host.dispatch("pointermove", { pointerType: "pen", clientX: 180, clientY: 210 });
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);
});

test("pointer MeshLine trail keeps suspension reasons isolated and switches all four colors", () => {
  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, platform: "netease", enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  app.runFrame(16);
  assert.ok(app.gl.colorUniforms.some((entry) => entry.name === "u_color0" && Math.abs(entry.value[0] - 0.843) < 0.001));

  trail.suspend("dialog");
  trail.suspend("platform:3");
  assert.equal(app.frames.size, 0);
  trail.setPlatform("qq");
  trail.resume("dialog");
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 240, clientY: 260 });
  assert.equal(app.frames.size, 0);
  trail.resume("platform:3");
  assert.equal(app.frames.size, 0, "resume never restarts stale movement");
  app.setNow(40);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 250, clientY: 280 });
  app.runFrame(56);
  assert.ok(app.gl.colorUniforms.some((entry) => entry.name === "u_color0" && Math.abs(entry.value[0] - 0.192) < 0.001));
});

test("pointer MeshLine trail releases GPU resources when disabled or capabilities change", () => {
  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  trail.setEnabled(false);
  assert.equal(app.host.children.length, 0);
  assert.equal(app.gl.deletedBuffers.length, 1);
  assert.equal(app.gl.deletedVertexArrays.length, 1);
  assert.equal(app.gl.deletedPrograms.length, 1);
  assert.equal(app.gl.lostContexts, 1);

  trail.setEnabled(true);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 190, clientY: 220 });
  assert.equal(app.host.children.length, 1);
  app.changeMedia("reduced", true);
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);
});

test("pointer MeshLine trail latches setup and frame faults until deliberately re-enabled", async (t) => {
  for (const failure of ["shader", "compile", "program", "link", "vao", "buffer", "uniform", "viewport"] as const) {
    await t.test(failure, () => {
      const app = runtime({ failure });
      const trail = app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
      app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
      app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 200, clientY: 230 });
      assert.equal(app.contextAttempts, 1);
      assert.equal(app.host.children.length, 0);
      trail.setEnabled(false);
      trail.setEnabled(true);
      app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 220, clientY: 250 });
      assert.equal(app.contextAttempts, 2);
    });
  }
  for (const failure of ["upload", "draw"] as const) {
    await t.test(failure, () => {
      const app = runtime({ failure });
      app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
      app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
      app.runFrame(16);
      assert.equal(app.host.children.length, 0);
      assert.equal(app.frames.size, 0);
    });
  }
});

test("pointer MeshLine trail latches a missing context and isolates context loss", () => {
  const unavailable = runtime({ contextNull: true });
  const unavailableTrail = unavailable.context.PointerSilkTrail.create({ host: unavailable.host, enabled: true });
  unavailable.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  unavailable.host.dispatch("pointermove", { pointerType: "mouse", clientX: 200, clientY: 230 });
  assert.equal(unavailable.contextAttempts, 1);
  unavailableTrail.setEnabled(false);
  unavailableTrail.setEnabled(true);
  unavailable.host.dispatch("pointermove", { pointerType: "mouse", clientX: 220, clientY: 250 });
  assert.equal(unavailable.contextAttempts, 2);

  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  app.host.children[0].dispatch("webglcontextlost");
  assert.equal(app.host.children.length, 0);
  assert.equal(app.gl.deletedPrograms.length, 0);
  assert.equal(app.gl.lostContexts, 0);
  trail.destroy();
  assert.equal(app.listenerCount(), 0);
});

test("pointer MeshLine source preserves Makio follow dynamics without random or business capture", () => {
  assert.match(trailSource, /NUM_POINTS = 20/);
  assert.match(trailSource, /NUM_LINES = 4/);
  assert.match(trailSource, /SPRINGS = new Float32Array/);
  assert.match(trailSource, /FRICTIONS = new Float32Array/);
  assert.match(trailSource, /for \(let point = NUM_POINTS - 1; point >= 1; point -= 1\)/);
  assert.match(trailSource, /pointXs\[index\] \+= \(pointXs\[index - 1\] - pointXs\[index\]\) \* 0\.9/);
  assert.match(trailSource, /mouseSpeed \+= .* \* 0\.15/);
  assert.match(trailSource, /gl\.drawArrays\(gl\.TRIANGLE_STRIP/);
  assert.match(trailSource, /IDLE_STOP_MS = HOLD_MS \+ FADE_MS/);
  assert.match(trailSource, /MAX_COLOR_PIXELS = 800_000/);
  assert.match(trailSource, /MAX_LINE_WIDTH_PX = 22/);
  assert.match(trailSource, /MAX_OFFSET_RADIUS_PX = 26/);
  assert.match(trailSource, /MAX_HEAD_LAG_PX = 32/);
  assert.match(trailSource, /MATERIAL_OPACITY = 0\.76/);
  assert.match(trailSource, /projectedWidthPx = referenceWorldWidth \* cssHeight \/ CAMERA_WORLD_HEIGHT_AT_PLANE/);
  assert.match(trailSource, /SPRINGS = new Float32Array\(\[0\.041, 0\.054, 0\.068, 0\.079\]\)/);
  assert.match(trailSource, /FRICTIONS = new Float32Array\(\[0\.898, 0\.867, 0\.834, 0\.802\]\)/);
  assert.match(trailSource, /OFFSET_WORLD_RADII = new Float32Array\(\[0\.11, 0\.18, 0\.27, 0\.23\]\)/);
  assert.match(trailSource, /Copyright \(c\) 2025 David Ronai/);
  assert.doesNotMatch(trailSource, /Math\.random|localStorage|sessionStorage|readPixels|drawWindow|html2canvas|createRadialGradient|drawImage|shadowBlur|CanvasRenderingContext2D/);
  assert.doesNotMatch(trailSource, /stopPropagation|setPointerCapture/);
});
