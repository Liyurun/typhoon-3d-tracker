/* ================= 台风追踪 · 纯函数工具库 · Typhoon Utils =================
 * 从 app.js / wind-layer.js / scripts/generate-typhoon-svg.js 抽取出来的、
 * 不依赖浏览器 DOM 与 CesiumJS 的纯函数集合，便于单元测试与复用。
 *
 * 采用 UMD 风格导出：
 *   - 浏览器：挂到全局 window.TyphoonUtils（供 app.js / wind-layer.js 引用）；
 *   - Node/Jest：module.exports（供单元测试引用）。
 * ======================================================================= */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node / CommonJS（单元测试）
  }
  if (root) {
    root.TyphoonUtils = api; // 浏览器全局
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- 强度分级配色（与网站前端 / README SVG 保持一致） ---------- */
  var GRADE = {
    TD:      { cn: "热带低压",   color: "#3DB2FF" },
    TS:      { cn: "热带风暴",   color: "#00D084" },
    STS:     { cn: "强热带风暴", color: "#FFD500" },
    TY:      { cn: "台风",       color: "#FF8C00" },
    STY:     { cn: "强台风",     color: "#FF3B30" },
    SuperTY: { cn: "超强台风",   color: "#C724B1" },
  };
  function gradeInfo(g) {
    return GRADE[g] || { cn: g || "未知", color: "#8aa0c8" };
  }

  /* ---------- 风向 / 移动方向：英文 -> 中文 + 罗盘方位角(度, 顺时针自北) ---------- */
  var DIR = {
    N:  { cn: "北",     deg: 0 },   NNE: { cn: "北东北", deg: 22.5 }, NE:  { cn: "东北", deg: 45 },  ENE: { cn: "东东北", deg: 67.5 },
    E:  { cn: "东",     deg: 90 },  ESE: { cn: "东东南", deg: 112.5 }, SE: { cn: "东南", deg: 135 }, SSE: { cn: "南东南", deg: 157.5 },
    S:  { cn: "南",     deg: 180 }, SSW: { cn: "南西南", deg: 202.5 }, SW: { cn: "西南", deg: 225 }, WSW: { cn: "西西南", deg: 247.5 },
    W:  { cn: "西",     deg: 270 }, WNW: { cn: "西西北", deg: 292.5 }, NW: { cn: "西北", deg: 315 }, NNW: { cn: "北西北", deg: 337.5 },
  };
  function dirCn(d)  { return (DIR[d] && DIR[d].cn) || d || "—"; }
  function dirDeg(d) { return DIR[d] ? DIR[d].deg : null; }

  /* ---------- 台风观测时间戳 "YYYYMMDDHHmm..." -> "MM-DD HH:mm" ---------- */
  function fmtTime(str) {
    if (!str || str.length < 12) return str || "";
    return str.slice(4, 6) + "-" + str.slice(6, 8) + " " + str.slice(8, 10) + ":" + str.slice(10, 12);
  }

  /* ---------- 近实时时间戳 ----------
   * 向下取整到 10 分钟、减去 lag 分钟 -> "YYYY-MM-DDTHH:mm:00Z"
   * 可传入 now（毫秒）便于测试；默认取当前时间。 */
  function nrtTime(lagMin, now) {
    var d = new Date((now == null ? Date.now() : now) - lagMin * 60000);
    d.setUTCSeconds(0, 0);
    d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10);
    return d.toISOString().slice(0, 19) + "Z";
  }
  /* 相对当天偏移 offsetDays 天的 "YYYY-MM-DD"。可传入 now 便于测试。 */
  function ymd(offsetDays, now) {
    var d = new Date((now == null ? Date.now() : now) + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  }

  /* ---------- NASA GIBS 云图图层配置（纯配置，无副作用） ---------- */
  function cloudConfig(kind, now) {
    if (kind === "geocolor") return { layer: "GOES-East_ABI_GeoColor", tms: "GoogleMapsCompatible_Level7", max: 6, fmt: "image/png",  time: nrtTime(180, now), label: "GOES-East GeoColor · 近实时(美洲)" };
    if (kind === "truecolor") return { layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor", tms: "GoogleMapsCompatible_Level9", max: 7, fmt: "image/jpeg", time: ymd(-1, now), label: "VIIRS 真彩合成 · 每日" };
    return { layer: "Himawari_AHI_Band13_Clean_Infrared", tms: "GoogleMapsCompatible_Level6", max: 6, fmt: "image/png", time: nrtTime(90, now), label: "葵花9号 Band13 红外 · 近实时" };
  }

  /* ---------- XML/HTML 转义（SVG 文本节点安全） ---------- */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- JSONP/CORS 响应体解析：截取首个 { 到末个 } 再 JSON.parse ---------- */
  function parseJsonpBody(text) {
    var s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) throw new Error("返回格式异常");
    return JSON.parse(text.substring(s, e + 1));
  }

  /* ---------- 风速色标 (m/s -> [r,g,b]) ---------- */
  var STOPS = [
    [0,  [58, 92, 200]],
    [3,  [42, 160, 235]],
    [7,  [26, 214, 170]],
    [12, [120, 220, 60]],
    [17, [242, 226, 60]],
    [23, [250, 150, 40]],
    [30, [242, 60, 48]],
    [42, [180, 30, 120]],
  ];
  function speedColor(sp) {
    if (sp <= STOPS[0][0]) return STOPS[0][1];
    for (var i = 1; i < STOPS.length; i++) {
      if (sp <= STOPS[i][0]) {
        var a = STOPS[i - 1], b = STOPS[i];
        var t = (sp - a[0]) / (b[0] - a[0]);
        return [
          Math.round(a[1][0] + (b[1][0] - a[1][0]) * t),
          Math.round(a[1][1] + (b[1][1] - a[1][1]) * t),
          Math.round(a[1][2] + (b[1][2] - a[1][2]) * t),
        ];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }

  /* ---------- 气象风向 -> U/V 分量（风的"来向"约定） ----------
   * U = -speed*sin(dir),  V = -speed*cos(dir)（dir 单位：度） */
  function windUV(speed, dirDegVal) {
    var rad = dirDegVal * Math.PI / 180;
    return [-speed * Math.sin(rad), -speed * Math.cos(rad)];
  }

  /* ---------- 规则网格双线性插值 ----------
   * grid = { lo1, la1, dx, dy, nx, ny, u[], v[] }，la1 为最北纬度。
   * 返回 [u, v, speed]；超出范围返回 null。 */
  function sampleGrid(grid, lon, lat) {
    if (!grid) return null;
    var fx = (lon - grid.lo1) / grid.dx;
    var fy = (grid.la1 - lat) / grid.dy;
    if (fx < 0 || fx > grid.nx - 1 || fy < 0 || fy > grid.ny - 1) return null;
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var x1 = Math.min(x0 + 1, grid.nx - 1), y1 = Math.min(y0 + 1, grid.ny - 1);
    var tx = fx - x0, ty = fy - y0;
    function at(arr, x, y) { return arr[y * grid.nx + x]; }
    function bl(arr) {
      var a = at(arr, x0, y0), b = at(arr, x1, y0), c = at(arr, x0, y1), d = at(arr, x1, y1);
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
    var u = bl(grid.u), v = bl(grid.v);
    return [u, v, Math.sqrt(u * u + v * v)];
  }

  return {
    GRADE: GRADE,
    gradeInfo: gradeInfo,
    DIR: DIR,
    dirCn: dirCn,
    dirDeg: dirDeg,
    fmtTime: fmtTime,
    nrtTime: nrtTime,
    ymd: ymd,
    cloudConfig: cloudConfig,
    esc: esc,
    parseJsonpBody: parseJsonpBody,
    STOPS: STOPS,
    speedColor: speedColor,
    windUV: windUV,
    sampleGrid: sampleGrid,
  };
});
