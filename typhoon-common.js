/* ================= 共享工具 · Shared Typhoon Utilities =================
 * 浏览器端（index.html -> app.js / wind-layer.js）与 Node 端
 * （scripts/generate-typhoon-svg.js）共用的常量与函数：
 *   - 中央气象台接口地址与拉取/解析
 *   - 台风强度分级配色
 *   - 台风列表筛选与路径点解析
 *   - 时间戳格式化、覆盖层开关绑定（仅浏览器）
 * 浏览器中挂载为全局 TyphoonCommon，Node 中通过 require 导出。
 * ==================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TyphoonCommon = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NMC_API = "https://typhoon.nmc.cn/weatherservice/typhoon/jsons";

  /* 强度分级配色（网站与 README SVG 共用） */
  const GRADE = {
    TD:      { cn: "热带低压",   color: "#3DB2FF" },
    TS:      { cn: "热带风暴",   color: "#00D084" },
    STS:     { cn: "强热带风暴", color: "#FFD500" },
    TY:      { cn: "台风",       color: "#FF8C00" },
    STY:     { cn: "强台风",     color: "#FF3B30" },
    SuperTY: { cn: "超强台风",   color: "#C724B1" },
  };
  const gradeInfo = (g) => GRADE[g] || { cn: g || "未知", color: "#8aa0c8" };

  /* 列表接口：当年用 list_default（含实时活跃状态），历史年份用 list_{year}
   * （list_default 会忽略 year 参数、恒返回当前年） */
  function listUrl(year) {
    return year >= new Date().getFullYear() ? `${NMC_API}/list_default` : `${NMC_API}/list_${year}`;
  }
  const viewUrl = (id) => `${NMC_API}/view_${id}?id=${id}`;

  /* 接口返回是 JSONP 包裹的 JSON，截取首尾大括号之间的内容解析 */
  async function fetchNmcJson(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) throw new Error("返回格式异常: " + url);
    return JSON.parse(text.substring(s, e + 1));
  }

  /* 具名台风列表（过滤 nameless 无名热低压） */
  const namedTyphoons = (list) => ((list && list.typhoonList) || []).filter((t) => t[1] !== "nameless");
  const isActive = (meta) => meta[7] === "start";

  /* 优先展示活跃台风；不足 limit 个时用最近台风补足（用于演示多台风）
   * 返回 { chosen, noActive } */
  function selectTyphoons(raw, limit) {
    const max = limit || 3;
    const active = raw.filter(isActive);
    const chosen = active.slice();
    if (chosen.length < 2) {
      for (const t of raw) {
        if (chosen.length >= max) break;
        if (!chosen.includes(t)) chosen.push(t);
      }
    }
    return { chosen, noActive: active.length === 0 };
  }

  /* 详情接口的观测点数组 -> 结构化路径点（丢弃缺少经纬度的点） */
  function parseTrackPoints(detail) {
    return ((detail && detail[8]) || [])
      .map((p) => ({
        time: p[1], ts: p[2], grade: p[3], lng: p[4], lat: p[5],
        pres: p[6], wind: p[7], dir: p[8], speed: p[9], radius: p[10], forecast: p[11],
      }))
      .filter((p) => typeof p.lng === "number" && typeof p.lat === "number");
  }

  /* 列表元数据 + 详情 -> 台风基础信息 */
  function typhoonInfo(meta, detail) {
    return {
      id: meta[0], num: meta[3], cn: detail[2] || meta[2] || detail[1],
      en: detail[1] || "", meaning: detail[6] || "", active: isActive(meta),
    };
  }

  /* "2026-08-04T03:20:00Z" -> "2026-08-04 03:20:00 UTC" */
  const formatUtcStamp = (iso) => String(iso).replace("T", " ").replace("Z", " UTC");

  /* 覆盖层（云图 / 风场）开关按钮：切换 .on、联动浓度行透明度，并回调新状态。
   * 仅浏览器端使用。 */
  function bindOverlayToggle(toggleId, opRowId, initial, onChange) {
    const tgl = document.getElementById(toggleId);
    const opRow = document.getElementById(opRowId);
    const paint = (on) => {
      if (tgl) tgl.classList.toggle("on", on);
      if (opRow) opRow.style.opacity = on ? "1" : ".45";
    };
    let on = !!initial;
    paint(on);
    if (tgl) tgl.onclick = () => { on = !on; paint(on); onChange(on); };
  }

  return {
    NMC_API, GRADE, gradeInfo, listUrl, viewUrl, fetchNmcJson,
    namedTyphoons, isActive, selectTyphoons, parseTrackPoints, typhoonInfo,
    formatUtcStamp, bindOverlayToggle,
  };
});
