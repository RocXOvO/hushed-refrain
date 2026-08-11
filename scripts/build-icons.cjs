const { Resvg } = require("@resvg/resvg-js");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const svg = readFileSync(join(root, "build/icon.svg"));

function renderPng(size) {
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
    logLevel: "off",
  });
  const rendered = renderer.render();
  if (rendered.width !== size || rendered.height !== size) {
    throw new Error(`Expected ${size}x${size} icon, received ${rendered.width}x${rendered.height}.`);
  }
  return rendered.asPng();
}

function createIco(entries) {
  const headerSize = 6 + entries.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = headerSize;
  entries.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(({ png }) => png)]);
}

function createIcns(pngBySize) {
  const definitions = [
    ["ic10", 1024],
    ["ic09", 512],
    ["ic14", 512],
    ["ic08", 256],
    ["ic13", 256],
    ["ic07", 128],
    ["ic12", 64],
    ["ic11", 32],
  ];
  const chunks = definitions.map(([type, size]) => {
    const png = pngBySize.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

const icoSizes = [256, 128, 64, 48, 32, 24, 18, 16];
const allSizes = [...new Set([1024, 512, ...icoSizes])];
const pngBySize = new Map(allSizes.map((size) => [size, renderPng(size)]));
const outputs = new Map([
  ["build/icon.png", pngBySize.get(1024)],
  ["web/app-icon.png", pngBySize.get(1024)],
  ["build/icon.ico", createIco(icoSizes.map((size) => ({ size, png: pngBySize.get(size) })))],
  ["build/icon.icns", createIcns(pngBySize)],
]);

const checkOnly = process.argv.includes("--check");
for (const [relativePath, content] of outputs) {
  const outputPath = join(root, relativePath);
  if (checkOnly) {
    const existing = readFileSync(outputPath);
    if (!existing.equals(content)) throw new Error(`${relativePath} is stale; run npm run icons:build.`);
  } else {
    writeFileSync(outputPath, content);
  }
}

console.log(checkOnly ? "ICON_ASSETS_CURRENT" : "ICON_ASSETS_WRITTEN");
