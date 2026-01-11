#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const ROOT = process.cwd();
const SOURCE_SVG = join(ROOT, "src", "design", "logo.svg");

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function cleanDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function renderPng(svg: string, size: number) {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    // Keep shapes crisp-ish.
    shapeRendering: 2, // 2 = geometricPrecision (resvg enum)
  } as any);
  const png = r.render().asPng();
  return png;
}

function writePng(path: string, buf: Uint8Array) {
  writeFileSync(path, buf);
}

const svg = await Bun.file(SOURCE_SVG).text();

// ---- macOS: icon.iconset ----
const iconsetDir = join(ROOT, "icon.iconset");
cleanDir(iconsetDir);

const macEntries: Array<{ name: string; size: number }> = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

for (const e of macEntries) {
  writePng(join(iconsetDir, e.name), renderPng(svg, e.size));
}

// ---- linux: PNG ----
const linuxDir = join(ROOT, "assets", "icons");
ensureDir(linuxDir);
const linuxPngPath = join(linuxDir, "icon-512.png");
writePng(linuxPngPath, renderPng(svg, 512));

// ---- windows: ICO (+ PNGs for reference) ----
const winPngSizes = [16, 24, 32, 48, 64, 128, 256];
const winPngBuffers: Buffer[] = [];

for (const s of winPngSizes) {
  const p = join(linuxDir, `icon-${s}.png`);
  const buf = Buffer.from(renderPng(svg, s));
  writeFileSync(p, buf);
  winPngBuffers.push(buf);
}

const icoBuf = await pngToIco(winPngBuffers);
writeFileSync(join(linuxDir, "icon.ico"), icoBuf);

console.log("✅ Generated icons:");
console.log(`- macOS iconset: ${iconsetDir}`);
console.log(`- linux png: ${linuxPngPath}`);
console.log(`- windows ico: ${join(linuxDir, "icon.ico")}`);

