import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const trailSource = readFileSync(join(process.cwd(), "web", "pointer-silk-trail.js"), "utf8");

type Listener = (...args: any[]) => void;

function runtime(options: { reduced?: boolean; fine?: boolean; width?: number; height?: number; dpr?: number; rafThrows?: boolean; drawThrows?: boolean; contextNull?: boolean } = {}) {
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, (time: number) => void>();
  const hostListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  const media = new Map<string, { matches: boolean; listeners: Set<Listener> }>();
  const canvases: any[] = [];
  const mainDraws: Array<{ kind: string; value?: unknown }> = [];
  let mainContextAttempts = 0;
  const host = {
    children: [] as any[],
    getBoundingClientRect() {
      return { left: 40, top: 60, width: options.width ?? 1_200, height: options.height ?? 800 };
    },
    appendChild(node: any) { this.children.push(node); node.parent = this; },
    addEventListener(type: string, listener: Listener) {
      if (!hostListeners.has(type)) hostListeners.set(type, new Set());
      hostListeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: Listener) { hostListeners.get(type)?.delete(listener); },
    dispatch(type: string, event: Record<string, unknown>) {
      for (const listener of [...(hostListeners.get(type) ?? [])]) listener(event);
    },
  };

  function contextFor(main: boolean) {
    return {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      lineCap: "butt",
      lineJoin: "miter",
      setTransform() {},
      clearRect() { if (main) mainDraws.push({ kind: "clear" }); },
      beginPath() {},
      moveTo() {},
      quadraticCurveTo() {},
      lineTo() {},
      stroke() { if (main) mainDraws.push({ kind: "stroke", value: this.strokeStyle }); },
      drawImage() {
        if (options.drawThrows && main) throw new Error("synthetic draw failure");
        if (main) mainDraws.push({ kind: "glow" });
      },
      createRadialGradient() { return { addColorStop() {} }; },
      fillRect() {},
    };
  }

  const document = {
    hidden: false,
    createElement(tag: string) {
      assert.equal(tag, "canvas");
      const main = canvases.length === 0 || canvases.at(-1)?.attached;
      const canvas: any = {
        width: 0,
        height: 0,
        className: "",
        attached: false,
        removed: false,
        attributes: new Map<string, string>(),
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        getContext(_name: string, contextOptions?: { desynchronized?: boolean }) {
          if (contextOptions?.desynchronized) {
            mainContextAttempts += 1;
            if (options.contextNull) return null;
          }
          return contextFor(Boolean(contextOptions?.desynchronized));
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
      constructor(callback: Listener) { this.callback = callback; }
      observe() {}
      disconnect() {}
    },
    Float32Array,
    Float64Array,
    Math,
    Number,
    Object,
    Set,
    String,
    TypeError,
  };
  context.globalThis = context;
  vm.runInNewContext(trailSource, context);
  return {
    context,
    host,
    canvases,
    mainDraws,
    frames,
    get mainContextAttempts() { return mainContextAttempts; },
    listenerCount() {
      return [...hostListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
        + [...windowListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
        + [...media.values()].reduce((sum, entry) => sum + entry.listeners.size, 0);
    },
    setNow(value: number) { now = value; },
    runFrame(value: number) {
      now = value;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(value);
    },
    changeMedia(queryPart: string, matches: boolean) {
      const entry = [...media.entries()].find(([query]) => query.includes(queryPart))?.[1];
      assert.ok(entry);
      entry.matches = matches;
      for (const listener of [...entry.listeners]) listener({ matches });
    },
  };
}

test("pointer silk trail is lazy, bounded, and stops rendering after 420ms idle", () => {
  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, platform: "netease", enabled: true });
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);

  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  app.setNow(16);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 210, clientY: 230 });
  assert.equal(app.host.children.length, 1);
  assert.equal(app.host.children[0].className, "pointer-silk-trail-canvas");
  assert.equal(app.host.children[0].attributes.get("aria-hidden"), "true");
  assert.equal(app.frames.size, 1);

  app.runFrame(16);
  assert.ok(app.mainDraws.some((draw) => draw.kind === "stroke"));
  assert.equal(app.frames.size, 1);
  app.runFrame(437);
  assert.equal(app.frames.size, 0);
  const drawsAtIdle = app.mainDraws.length;
  app.runFrame(900);
  assert.equal(app.mainDraws.length, drawsAtIdle);
  trail.destroy();
  assert.equal(app.host.children.length, 0);
  assert.equal(app.listenerCount(), 0);
});

test("pointer silk trail honors reduced motion and coarse pointers without allocating a canvas", () => {
  for (const options of [{ reduced: true }, { fine: false }]) {
    const app = runtime(options);
    app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
    app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
    assert.equal(app.host.children.length, 0);
    assert.equal(app.frames.size, 0);
    const allocations = app.canvases.length;
    app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 200, clientY: 230 });
    assert.equal(app.canvases.length, allocations, "a persistent RAF failure must latch until explicitly re-enabled");
  }
  const app = runtime();
  app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "touch", clientX: 180, clientY: 210 });
  app.host.dispatch("pointermove", { pointerType: "pen", clientX: 180, clientY: 210 });
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);
});

test("pointer silk trail suspends by reason, switches palette, and resumes only on new movement", () => {
  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, platform: "netease", enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  app.setNow(16);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 220, clientY: 250 });
  app.runFrame(16);
  assert.ok(app.mainDraws.some((draw) => draw.value === "#c83f49"));

  trail.suspend("dialog");
  trail.suspend("platform:3");
  assert.equal(app.frames.size, 0);
  trail.setPlatform("qq");
  trail.resume("dialog");
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 240, clientY: 260 });
  assert.equal(app.frames.size, 0, "one remaining suspension must keep rendering stopped");
  trail.resume("platform:3");
  assert.equal(app.frames.size, 0, "resume never restarts stale motion");
  app.setNow(40);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 250, clientY: 280 });
  app.setNow(56);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 280, clientY: 300 });
  app.runFrame(56);
  assert.ok(app.mainDraws.some((draw) => draw.value === "#107b55"));
});

test("pointer silk trail releases its surface when disabled or capabilities become unavailable", () => {
  const app = runtime();
  const trail = app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  assert.equal(app.host.children.length, 1);
  trail.setEnabled(false);
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);

  trail.setEnabled(true);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 190, clientY: 220 });
  assert.equal(app.host.children.length, 1);
  app.changeMedia("reduced", true);
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);
});

test("pointer silk trail caps DPR and color-buffer pixels", () => {
  const app = runtime({ width: 3_840, height: 2_160, dpr: 2 });
  app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  const canvas = app.host.children[0];
  assert.ok(canvas.width * canvas.height <= 800_000);
  assert.ok(canvas.width / 3_840 <= 1.25);
});

test("pointer silk trail releases resources when RAF or drawing fails", () => {
  {
    const app = runtime({ rafThrows: true });
    app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
    app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
    assert.equal(app.host.children.length, 0);
    assert.equal(app.frames.size, 0);
  }
  {
    const app = runtime({ drawThrows: true });
    app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
    app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
    app.runFrame(0);
    assert.equal(app.host.children.length, 0);
    assert.equal(app.frames.size, 0);
  }
});

test("pointer silk trail latches a missing 2D context until explicitly re-enabled", () => {
  const app = runtime({ contextNull: true });
  const trail = app.context.PointerSilkTrail.create({ host: app.host, enabled: true });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 180, clientY: 210 });
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 200, clientY: 230 });
  assert.equal(app.mainContextAttempts, 1);
  assert.equal(app.host.children.length, 0);
  assert.equal(app.frames.size, 0);

  trail.setEnabled(false);
  trail.setEnabled(true);
  app.host.dispatch("pointermove", { pointerType: "mouse", clientX: 220, clientY: 250 });
  assert.equal(app.mainContextAttempts, 2, "off then on permits one deliberate capability retry");
  trail.destroy();
  assert.equal(app.listenerCount(), 0);
});

test("pointer silk renderer contains no random, storage, DOM capture, or interaction hooks", () => {
  assert.match(trailSource, /new Float32Array\(SAMPLE_CAPACITY\)/);
  assert.match(trailSource, /new Float64Array\(SAMPLE_CAPACITY\)/);
  assert.match(trailSource, /const IDLE_STOP_MS = HOLD_MS \+ FADE_MS/);
  assert.match(trailSource, /MAX_COLOR_PIXELS = 800_000/);
  assert.match(trailSource, /pointerType !== "mouse"/);
  assert.doesNotMatch(trailSource, /Math\.random|localStorage|sessionStorage|readPixels|drawWindow|html2canvas/);
  assert.doesNotMatch(trailSource, /preventDefault|stopPropagation|setPointerCapture/);
});
