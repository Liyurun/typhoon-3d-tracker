#!/usr/bin/env node
/**
 * 轻量语法检查（无第三方依赖）：对项目自有 JS 逐个做 `node --check` 解析，
 * 捕获明显语法错误。排除第三方打包库 cesium/ 与 node_modules/。
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "cesium", ".git", "coverage"]);

function collect(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, out);
    } else if (name.endsWith(".js")) {
      out.push(full);
    }
  }
}

const files = [];
collect(ROOT, files);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    failed++;
    console.error("语法错误: " + path.relative(ROOT, f));
    console.error(String(e.stderr || e.message));
  }
}

if (failed) {
  console.error(`\n语法检查失败：${failed} 个文件有问题。`);
  process.exit(1);
}
console.log(`语法检查通过：${files.length} 个 JS 文件无语法错误。`);
