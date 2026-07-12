/* ================= 动态风场图层 · Animated Wind Field =================
 * 渲染方式 : 覆盖在 Cesium 画布之上的 2D Canvas 粒子引擎（windy / leaflet-velocity 风格）
 *            每帧把粒子经纬度用 Cesium.SceneTransforms 重投影到屏幕，并做地平线遮挡剔除，
 *            因此粒子始终"贴"在三维地球球面上，随相机平移/旋转/缩放实时同步。
 * 数据来源 : Open-Meteo（免费·无需 Key）10m 风场，实时抓取西太平洋 90–180°E / 0–50°N 网格；
 *            抓取失败时回退到内置样例 wind-sample.json。
 * U/V 换算 : U = -speed*sin(dir),  V = -speed*cos(dir)  （气象风向：风的来向）
 * 颜色编码 : 蓝→青→绿→黄→橙→红 表示风速 (m/s)。
 * 依赖全局 : viewer, Cesium, $, toast（均由 app.js 在同页面先行声明）
 * ==================================================================== */
(function () {
  "use strict";

  /* ---------- 参数 ---------- */
  var CFG = {
    particles: 3200,   // 粒子数量（受密度滑块控制）
    maxAge: 90,        // 粒子寿命(帧)
    fade: 0.90,        // 拖尾衰减（越大拖尾越长）
    speedScale: 0.0065,// 位移比例：经纬度增量 = 分量(m/s) * speedScale
    lineWidth: 1.4,
    opacity: 0.9,      // 整体透明度（受浓度滑块控制）
  };

  /* 风速色标 (m/s -> 颜色) */
  var STOPS = [
    [0,  [58, 92, 200]],   // 深蓝
    [3,  [42, 160, 235]],  // 蓝
    [7,  [26, 214, 170]],  // 青绿
    [12, [120, 220, 60]],  // 绿
    [17, [242, 226, 60]],  // 黄
    [23, [250, 150, 40]],  // 橙
    [30, [242, 60, 48]],   // 红
    [42, [180, 30, 120]],  // 品红(极端)
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

  /* ---------- 状态 ---------- */
  var grid = null;         // {lo1,la1,dx,dy,nx,ny,u[],v[],source,validTime,live}
  var particles = [];
  var enabled = false;     // 默认关闭：风场为覆盖层，会遮挡地形，首屏不显示，由用户按需开启
  var canvas, g, dpr = 1, W = 0, H = 0;
  var scene = viewer.scene;
  var toWin = Cesium.SceneTransforms.wgs84ToWindowCoordinates ||
              Cesium.SceneTransforms.worldToWindowCoordinates;
  var occluder = new Cesium.EllipsoidalOccluder(scene.globe.ellipsoid, scene.camera.positionWC);
  var scratch = new Cesium.Cartesian3();

  /* ---------- Canvas 覆盖层 ---------- */
  function buildCanvas() {
    canvas = document.createElement("canvas");
    canvas.id = "windCanvas";
    canvas.style.cssText = "position:absolute;inset:0;z-index:5;pointer-events:none";
    document.getElementById("globe").appendChild(canvas);
    g = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var c = scene.canvas;
    W = c.clientWidth || window.innerWidth;
    H = c.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- 网格插值 ---------- */
  function interp(lon, lat) {
    if (!grid) return null;
    var fx = (lon - grid.lo1) / grid.dx;          // 列（向东增大）
    var fy = (grid.la1 - lat) / grid.dy;          // 行（向南增大，la1 在最北）
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

  /* ---------- 粒子 ---------- */
  function randLon() { return grid.lo1 + Math.random() * (grid.nx - 1) * grid.dx; }
  function randLat() { return grid.la1 - Math.random() * (grid.ny - 1) * grid.dy; }
  function respawn(p, fresh) {
    p.lon = randLon(); p.lat = randLat();
    p.age = fresh ? Math.floor(Math.random() * CFG.maxAge) : 0;
  }
  function seedParticles() {
    particles = [];
    for (var i = 0; i < CFG.particles; i++) {
      var p = { lon: 0, lat: 0, age: 0 };
      respawn(p, true);
      particles.push(p);
    }
  }

  /* 经纬度 -> 屏幕像素（含地平线遮挡剔除），返回 {x,y} 或 null */
  function project(lon, lat) {
    var cart = Cesium.Cartesian3.fromDegrees(lon, lat, 0, scene.globe.ellipsoid, scratch);
    if (!occluder.isPointVisible(cart)) return null;
    var win = toWin(scene, cart);
    if (!win) return null;
    if (win.x < -40 || win.x > W + 40 || win.y < -40 || win.y > H + 40) return null;
    return win;
  }

  /* ---------- 渲染循环 ---------- */
  function frame() {
    requestAnimationFrame(frame);
    if (!enabled || !grid || !g) return;
    occluder.cameraPosition = scene.camera.positionWC;

    // 拖尾衰减：destination-in 保留 fade 比例的既有像素透明度（保持覆盖层整体透明）
    g.globalCompositeOperation = "destination-in";
    g.globalAlpha = CFG.fade;
    g.fillStyle = "rgba(0,0,0,1)";
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.lineWidth = CFG.lineWidth;
    g.lineCap = "round";

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var uv = interp(p.lon, p.lat);
      if (!uv) { respawn(p, false); continue; }
      var u = uv[0], v = uv[1], sp = uv[2];
      var cosLat = Math.max(Math.cos(p.lat * Math.PI / 180), 0.2);
      var nlon = p.lon + u * CFG.speedScale / cosLat;
      var nlat = p.lat + v * CFG.speedScale;

      var a = project(p.lon, p.lat);
      var b = project(nlon, nlat);
      if (a && b) {
        var c = speedColor(sp);
        g.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + CFG.opacity + ")";
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
      p.lon = nlon; p.lat = nlat; p.age++;
      if (p.age > CFG.maxAge) respawn(p, false);
    }
  }

  /* ---------- 数据加载 ---------- */
  function buildGridFromOpenMeteo() {
    var lo1 = 90, la1 = 50, dx = 5, dy = 5;
    var nx = (180 - 90) / dx + 1, ny = (50 - 0) / dy + 1;
    var las = [], los = [];
    for (var j = 0; j < ny; j++) {
      var lat = la1 - j * dy;
      for (var i = 0; i < nx; i++) { las.push(la1 - j * dy); los.push(lo1 + i * dx); }
    }
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + las.join(",") +
      "&longitude=" + los.join(",") +
      "&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms";
    return fetch(url, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("open-meteo " + r.status); return r.json(); })
      .then(function (arr) {
        if (!Array.isArray(arr) || arr.length !== nx * ny) throw new Error("网格长度不符");
        var u = [], v = [], vt = arr[0].current.time;
        for (var k = 0; k < arr.length; k++) {
          var cur = arr[k].current;
          var s = cur.wind_speed_10m, d = cur.wind_direction_10m;
          if (s == null || d == null) { s = 0; d = 0; }
          var rad = d * Math.PI / 180;
          u.push(-s * Math.sin(rad));
          v.push(-s * Math.cos(rad));
        }
        return {
          lo1: lo1, la1: la1, dx: dx, dy: dy, nx: nx, ny: ny, u: u, v: v,
          source: "Open-Meteo · GFS 10m 风场 · 实时",
          validTime: vt + "Z", live: true
        };
      });
  }
  function loadSample() {
    return fetch("./wind-sample.json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { j.live = false; return j; });
  }
  function loadWind() {
    setStatus("正在获取风场数据…", "");
    buildGridFromOpenMeteo()
      .then(function (gd) { grid = gd; seedParticles(); onLoaded(); })
      .catch(function (e) {
        console.warn("[wind] 实时风场获取失败，回退内置样例:", e);
        loadSample()
          .then(function (gd) { grid = gd; seedParticles(); onLoaded(); })
          .catch(function (e2) { console.error("[wind] 样例风场也失败:", e2); setStatus("风场数据加载失败", "err"); });
      });
  }
  function onLoaded() {
    var t = grid.validTime ? grid.validTime.replace("T", " ").replace("Z", " UTC") : "";
    setStatus((grid.live ? "实时" : "样例") + " · " + t, grid.live ? "live" : "sample");
    if (typeof toast === "function") toast(grid.live ? "已加载实时风场（Open-Meteo）" : "实时风场不可用，已用内置样例");
  }

  /* ---------- UI ---------- */
  function setStatus(txt, cls) {
    var el = document.getElementById("windStatus"); if (!el) return;
    el.textContent = txt;
    el.style.color = cls === "err" ? "#ff6b6b" : (cls === "live" ? "#00e08a" : "var(--sub)");
  }
  function bindUI() {
    var tgl = document.getElementById("windToggle");
    var opRow = document.getElementById("windOpRow");
    tgl.onclick = function () {
      enabled = !enabled;
      this.classList.toggle("on", enabled);
      canvas.style.display = enabled ? "block" : "none";
      if (!enabled && g) g.clearRect(0, 0, W, H);
      opRow.style.opacity = enabled ? "1" : ".45";
      if (typeof toast === "function") toast(enabled ? "已开启动态风场" : "已关闭动态风场");
    };
    document.getElementById("windOp").oninput = function (e) {
      CFG.opacity = Math.max(0.15, e.target.value / 100);
    };
    document.getElementById("windDensity").oninput = function (e) {
      CFG.particles = +e.target.value;
      if (grid) seedParticles();
    };
    // 默认关闭（风场覆盖层会遮挡地形，首屏不显示）
    tgl.classList.remove("on");
    canvas.style.display = "none";
    opRow.style.opacity = ".45";
    // 颜色图例渐变
    var grad = document.getElementById("windLegendBar");
    if (grad) {
      var css = STOPS.map(function (s) {
        var pct = Math.round(s[0] / 42 * 100);
        return "rgb(" + s[1][0] + "," + s[1][1] + "," + s[1][2] + ") " + pct + "%";
      }).join(",");
      grad.style.background = "linear-gradient(90deg," + css + ")";
    }
  }

  /* ---------- 启动 ---------- */
  buildCanvas();
  bindUI();
  loadWind();
  requestAnimationFrame(frame);
  // Cesium 画布尺寸可能在初始化后变化，稍后再校正一次
  setTimeout(resize, 800);
})();
