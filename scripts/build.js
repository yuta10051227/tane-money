const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");

const root = path.join(__dirname, "..");
const jsxPath = path.join(root, "okozukai-v9.jsx");
const htmlPath = path.join(root, "index.html");
const appJsPath = path.join(root, "app.js");

const jsx = fs.readFileSync(jsxPath, "utf8");
const code = jsx
  .replace(
    'import React, { useState, useEffect, useCallback } from "react";',
    ""
  )
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
  "<script>\nconst { useState, useEffect, useCallback } = React;\n\n";
const END = "\nfunction FamilySetup({";
const si = html.indexOf(START);
const ei = html.indexOf(END);
if (si === -1 || ei === -1) {
  console.error("index.html: could not find script injection markers");
  process.exit(1);
}
const newHtml = html.slice(0, si + START.length) + js + html.slice(ei);
fs.writeFileSync(htmlPath, newHtml);
console.log("index.html updated:", newHtml.length, "bytes");
