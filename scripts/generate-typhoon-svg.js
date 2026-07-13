#!/usr/bin/env node
/**
 * 生成动态台风路径图（SVG），供 README 引用。
 * 数据来源：中央气象台台风网 typhoon.nmc.cn（免 key）。
 * 由 GitHub Action 定时运行并提交，实现 README 中的“准实时”台风路径。
 */
const fs = require("fs");
const path = require("path");

const API = "https://typhoon.nmc.cn/weatherservice/typhoon/jsons";

// 强度分级配色（与网站前端保持一致）
const GRADE = {
  TD:      { cn: "热带低压",   color: "#3DB2FF" },
  TS:      { cn: "热带风暴",   color: "#00D084" },
  STS:     { cn: "强热带风暴", color: "#FFD500" },
  TY:      { cn: "台风",       color: "#FF8C00" },
  STY:     { cn: "强台风",     color: "#FF3B30" },
  SuperTY: { cn: "超强台风",   color: "#C724B1" },
};
const gradeInfo = (g) => GRADE[g] || { cn: g || "未知", color: "#8aa0c8" };

// 国家/地区参考标签（经度, 纬度, 名称）
const GEO_LABELS = [
  [103, 35, "中国"], [138, 37, "日本"], [126, 37, "韩国"],
  [122, 14, "菲律宾"], [106, 16, "越南"], [101, 15, "泰国"],
];

// 主要城市（经度, 纬度, 名称）——覆盖台风高影响区
const CITIES = [
  [116.4, 39.9, "北京"], [121.5, 31.2, "上海"], [113.3, 23.1, "广州"],
  [114.1, 22.5, "香港"], [121.5, 25.0, "台北"], [118.8, 32.0, "南京"],
  [120.2, 30.3, "杭州"], [117.2, 39.1, "天津"], [108.3, 22.8, "南宁"],
  [110.3, 20.0, "海口"], [139.7, 35.7, "东京"], [126.9, 37.6, "首尔"],
  [121.0, 14.6, "马尼拉"], [105.8, 21.0, "河内"],
];

// 加载预处理好的西太平洋海岸线/国界数据（Natural Earth，见 assets/geo）
function loadCoastline() {
  try {
    const p = path.join(__dirname, "..", "assets", "geo", "coastline-wpac.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("海岸线数据缺失，将只画网格:", e.message);
    return null;
  }
}

async function fetchJSONP(url) {
  const res = await fetch(url, { headers: { "User-Agent": "typhoon-3d-tracker-bot" } });
  const text = await res.text();
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("返回格式异常: " + url);
  return JSON.parse(text.substring(s, e + 1));
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  const year = new Date().getUTCFullYear();
  let list;
  try {
    list = await fetchJSONP(`${API}/list_default?year=${year}`);
  } catch (e) {
    console.error("列表获取失败:", e.message);
    process.exit(1);
  }

  let raw = (list.typhoonList || []).filter((t) => t[1] !== "nameless");
  const active = raw.filter((t) => t[7] === "start");
  // 优先展示活跃台风；若无活跃台风则展示最近的最多 3 个
  let chosen = active.slice();
  const noActive = chosen.length === 0;
  if (chosen.length === 0) {
    chosen = raw.slice(0, 3);
  }

  const typhoons = [];
  for (const meta of chosen) {
    try {
      const d = (await fetchJSONP(`${API}/view_${meta[0]}?id=${meta[0]}`)).typhoon;
      if (!d || !d[8]) continue;
      const pts = d[8].map((p) => ({ grade: p[3], lng: p[4], lat: p[5], pres: p[6], wind: p[7] }))
        .filter((p) => typeof p.lng === "number" && typeof p.lat === "number");
      if (!pts.length) continue;
      typhoons.push({
        num: meta[3], cn: d[2] || meta[2], en: d[1] || "",
        active: meta[7] === "start", pts,
      });
    } catch (e) { /* 单个失败跳过 */ }
  }

  const svg = renderSVG(typhoons, { year, noActive, coast: loadCoastline() });
  const outDir = path.join(__dirname, "..", "assets");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "typhoon-latest.svg");
  fs.writeFileSync(outFile, svg, "utf8");
  console.log(`已生成 ${outFile}，台风数=${typhoons.length}`);
}

function renderSVG(typhoons, meta) {
  const W = 900, H = 560;
  const pad = { l: 46, r: 20, t: 58, b: 34 };

  // 视野范围：默认西太平洋窗口，若有数据则自适应扩展
  let lonMin = 105, lonMax = 165, latMin = 5, latMax = 45;
  const all = typhoons.flatMap((t) => t.pts);
  if (all.length) {
    lonMin = Math.min(lonMin, ...all.map((p) => p.lng)) - 3;
    lonMax = Math.max(lonMax, ...all.map((p) => p.lng)) + 3;
    latMin = Math.min(latMin, ...all.map((p) => p.lat)) - 3;
    latMax = Math.max(latMax, ...all.map((p) => p.lat)) + 3;
  }
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const X = (lng) => pad.l + ((lng - lonMin) / (lonMax - lonMin)) * iw;
  const Y = (lat) => pad.t + ((latMax - lat) / (latMax - latMin)) * ih;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`);

  // 背景渐变（深海蓝，呼应网站主题）
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a1330"/><stop offset="1" stop-color="#050912"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#3fd0ff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#3fd0ff" stop-opacity="0"/>
    </radialGradient>
  </defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

  // 陆地：填充多边形 + 海岸线/国界描边（来自 Natural Earth 预处理数据）
  if (meta.coast && meta.coast.feats) {
    const landPaths = [];
    for (const f of meta.coast.feats) {
      for (const poly of f.p) {
        for (const ring of poly) {
          // 跳过完全在视野外的环
          if (!ring.some(([x, y]) => x >= lonMin - 5 && x <= lonMax + 5 && y >= latMin - 5 && y <= latMax + 5)) continue;
          const d = ring.map(([x, y], i) => `${i ? "L" : "M"}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(" ") + " Z";
          landPaths.push(d);
        }
      }
    }
    if (landPaths.length) {
      const dAll = landPaths.join(" ");
      // 陆地填充（低饱和蓝灰，与深海背景区分）
      parts.push(`<path d="${dAll}" fill="#16233f" fill-rule="evenodd" stroke="none"/>`);
      // 海岸线/国界描边
      parts.push(`<path d="${dAll}" fill="none" stroke="#3a527d" stroke-width="0.8" stroke-linejoin="round"/>`);
    }
  }

  // 经纬网格
  for (let lng = Math.ceil(lonMin / 10) * 10; lng <= lonMax; lng += 10) {
    const x = X(lng);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${H - pad.b}" stroke="#1c2a4a" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${H - pad.b + 18}" fill="#5f7196" font-size="11" text-anchor="middle">${lng}°E</text>`);
  }
  for (let lat = Math.ceil(latMin / 10) * 10; lat <= latMax; lat += 10) {
    const y = Y(lat);
    parts.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#1c2a4a" stroke-width="1"/>`);
    parts.push(`<text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" fill="#5f7196" font-size="11" text-anchor="end">${lat}°N</text>`);
  }

  // 国家/地区参考标签
  for (const [lng, lat, name] of GEO_LABELS) {
    if (lng < lonMin || lng > lonMax || lat < latMin || lat > latMax) continue;
    parts.push(`<text x="${X(lng).toFixed(1)}" y="${Y(lat).toFixed(1)}" fill="#6076a3" font-size="14" font-weight="700" text-anchor="middle" opacity="0.7">${name}</text>`);
  }

  // 主要城市：小圆点 + 名称
  for (const [lng, lat, name] of CITIES) {
    if (lng < lonMin || lng > lonMax || lat < latMin || lat > latMax) continue;
    const cx = X(lng), cy = Y(lat);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.4" fill="#aebedd"/>`);
    const anchor = cx > W - 90 ? "end" : "start";
    const tx = anchor === "end" ? cx - 5 : cx + 5;
    parts.push(`<text x="${tx.toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" fill="#8ea3c9" font-size="10.5" text-anchor="${anchor}" paint-order="stroke" stroke="#0a1330" stroke-width="2.5">${name}</text>`);
  }

  // 台风路径
  for (const t of typhoons) {
    const pts = t.pts;
    // 分段绘制，按每段起点强度着色
    for (let i = 1; i < pts.length; i++) {
      const g = gradeInfo(pts[i].grade);
      parts.push(`<line x1="${X(pts[i - 1].lng).toFixed(1)}" y1="${Y(pts[i - 1].lat).toFixed(1)}" x2="${X(pts[i].lng).toFixed(1)}" y2="${Y(pts[i].lat).toFixed(1)}" stroke="${g.color}" stroke-width="3" stroke-linecap="round" opacity="0.9"/>`);
    }
    // 观测点
    for (const p of pts) {
      parts.push(`<circle cx="${X(p.lng).toFixed(1)}" cy="${Y(p.lat).toFixed(1)}" r="2.2" fill="${gradeInfo(p.grade).color}" opacity="0.85"/>`);
    }
    // 当前（最新）位置：光晕 + 台风符号
    const last = pts[pts.length - 1];
    const cx = X(last.lng), cy = Y(last.lat), g = gradeInfo(last.grade);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="22" fill="url(#glow)"/>`);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${g.color}" stroke="#fff" stroke-width="1.5"/>`);
    // 台风编号+名称标签（靠近右/下边界时翻转对齐，避免被裁切）
    const label = `${t.num} ${t.cn}`;
    const info = `${g.cn} · ${last.wind || "?"}m/s · ${last.pres || "?"}hPa`;
    const flipX = cx > W - 170;             // 太靠右 -> 标签放到点左侧
    const flipY = cy < pad.t + 24;          // 太靠上 -> 标签放到点下方
    const anchor = flipX ? "end" : "start";
    const lx = flipX ? cx - 12 : cx + 12;
    const ty = flipY ? cy + 22 : cy - 10;
    parts.push(`<text x="${lx.toFixed(1)}" y="${ty.toFixed(1)}" fill="#fff" font-size="13" font-weight="700" text-anchor="${anchor}" paint-order="stroke" stroke="#050912" stroke-width="3">${esc(label)}</text>`);
    parts.push(`<text x="${lx.toFixed(1)}" y="${(ty + 15).toFixed(1)}" fill="${g.color}" font-size="11" font-weight="600" text-anchor="${anchor}" paint-order="stroke" stroke="#050912" stroke-width="3">${esc(info)}</text>`);
  }

  // 标题
  parts.push(`<text x="${pad.l}" y="26" fill="#ffffff" font-size="18" font-weight="800">🌀 台风实时路径 · Typhoon Live Tracks</text>`);
  const subtitle = meta.noActive
    ? `${meta.year}年当前无活跃台风，展示最近 ${typhoons.length} 个`
    : `当前活跃台风 ${typhoons.length} 个`;
  parts.push(`<text x="${pad.l}" y="45" fill="#8aa0c8" font-size="12">${esc(subtitle)} · 数据:中央气象台</text>`);

  // 图例（右上角）
  const grades = Object.values(GRADE);
  let lx = W - pad.r, ly = 20;
  parts.push(`<g font-size="10.5">`);
  const legendItems = grades.map((g) => g.cn);
  // 从右往左排一行不够，改为右上角竖排小图例
  grades.forEach((g, i) => {
    const yy = 46 + i * 15;
    parts.push(`<rect x="${W - 128}" y="${yy - 8}" width="10" height="10" rx="2" fill="${g.color}"/>`);
    parts.push(`<text x="${W - 114}" y="${yy}" fill="#c8d3e8">${g.cn}</text>`);
  });
  parts.push(`</g>`);

  // 更新时间戳（右下角）
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600000);
  const stamp = `更新于 ${bj.toISOString().slice(0, 16).replace("T", " ")} (北京时间)`;
  parts.push(`<text x="${W - pad.r}" y="${H - 10}" fill="#5f7196" font-size="11" text-anchor="end">${esc(stamp)}</text>`);

  parts.push(`</svg>`);
  return parts.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
