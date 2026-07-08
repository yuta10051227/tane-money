// iOS 26 Liquid Glass 風アプリアイコン生成。芽(タネマネー)モチーフ + グラデ + 光沢 + 奥行き。
// full-bleed(角丸なし)でiOS側のマスクに任せる。sharpでPNG各サイズを書き出す。
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ROOT = path.join(__dirname, "..");

// full-bleed 正方形アート（512基準）。iOSがsquircleにマスクする。
const artInner = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0e6b41"/>
      <stop offset="0.55" stop-color="#1f9257"/>
      <stop offset="1" stop-color="#34C77B"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0.12" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.42"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/>
      <stop offset="0.42" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="leaf" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#c8f07a"/>
      <stop offset="1" stop-color="#79c53d"/>
    </linearGradient>
    <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#82cf46"/>
      <stop offset="1" stop-color="#4ea62f"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="7" stdDeviation="10" flood-color="#06331d" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <ellipse cx="256" cy="60" rx="330" ry="210" fill="url(#sheen)"/>
  <circle cx="256" cy="286" r="176" fill="#ffffff" opacity="0.07"/>
  <g filter="url(#soft)">
    <path d="M256 396 C 246 330, 246 300, 258 250" stroke="url(#stem)" stroke-width="26" fill="none" stroke-linecap="round"/>
    <path d="M258 268 C 214 258, 150 258, 118 196 C 176 176, 238 210, 258 268 Z" fill="url(#leaf)"/>
    <path d="M256 262 C 300 236, 330 162, 396 148 C 404 216, 342 262, 256 262 Z" fill="url(#leaf)"/>
  </g>
  <path d="M246 256 C 206 238, 170 226, 140 200" stroke="#f3f8d6" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.85"/>
  <path d="M270 250 C 312 224, 348 188, 380 164" stroke="#f3f8d6" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.85"/>
  <rect width="512" height="512" fill="url(#gloss)"/>
`;
const svgFull = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${artInner}</svg>`;
// favicon用: 角丸付き
const svgRounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><clipPath id="r"><rect width="512" height="512" rx="114"/></clipPath></defs><g clip-path="url(#r)">${artInner}</g></svg>`;

async function main(){
  const buf = Buffer.from(svgFull);
  const jobs = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-512-maskable.png", 512],
    ["apple-touch-icon.png", 180],
  ];
  for(const [name, size] of jobs){
    await sharp(buf).resize(size, size).png().toFile(path.join(ROOT, name));
    console.log("wrote", name, size);
  }
  fs.writeFileSync(path.join(ROOT, "icon.svg"), svgRounded);
  console.log("wrote icon.svg");
}
main().catch(e=>{console.error(e);process.exit(1);});
