const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const jsxPath = path.join(root, "okozukai-v9.jsx");
const htmlPath = path.join(root, "index.html");
const appJsPath = path.join(root, "app.js");

// コミットハッシュを取得（git未初期化でも fallback）
let commitHash = "local";
try {
  commitHash = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
} catch(e) {}

const jsx = fs.readFileSync(jsxPath, "utf8");
const code = jsx
  // import React, { ...任意のhook... } from "react"; を頑健に除去
  // （hookを足してもビルドが壊れないよう、行ごと正規表現で削除）
  .replace(/^\s*import\s+React\s*,?\s*(\{[^}]*\})?\s*from\s+["']react["'];?\s*$/m, "")
  .replace("export default function App()", "function App()");

const result = babel.transformSync(code, {
  presets: ["@babel/preset-react"],
  filename: "app.jsx",
});
fs.writeFileSync(appJsPath, result.code);
console.log("Compiled:", result.code.length, "chars");

const js = fs.readFileSync(appJsPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const START =
  "<script>\nconst { useState, useEffect, useCallback, useRef } = React;\n\n";
const END = "\nfunction FamilySetup({";
const si = html.indexOf(START);
const ei = html.indexOf(END);
if (si === -1 || ei === -1) {
  console.error("index.html: could not find script injection markers");
  process.exit(1);
}
const newHtml = html.slice(0, si + START.length) + js + html.slice(ei);

// コミットハッシュをmetaタグとして埋め込む
const metaTag = `<meta name="tane-version" content="${commitHash}">`;
const withVersion = newHtml.replace(
  /<meta name="tane-version"[^>]*>/,
  metaTag
).replace(
  /(<\/head>)/,
  (match, p) => newHtml.includes('name="tane-version"') ? match : `${metaTag}\n${match}`
);

fs.writeFileSync(htmlPath, withVersion.includes('name="tane-version"') ? withVersion : newHtml);
console.log("index.html updated:", (withVersion || newHtml).length, "bytes");
console.log("Version:", commitHash);
