/* ================= 台风三维追踪 · Typhoon 3D Globe Tracker =================
 * 路径数据 : 中央气象台台风网 typhoon.nmc.cn (JSONP+CORS)
 * 三维地球 : CesiumJS 1.121 (已接入 Cesium ion Token)
 * 地形     : Cesium World Terrain (Ion Asset 1, 真实三维高程 + 顶点法线着色)
 * 底图     : ESRI World Imagery (高清真实卫星影像) + 参考注记
 * 云图     : NASA GIBS WMTS
 *            - 葵花9号 Band13 清洁红外 (近实时 ~1h, 西太平洋台风最佳)
 *            - GOES-East GeoColor       (近实时 ~1h)
 *            - VIIRS 真彩合成           (每日, 完整覆盖, 昨日)
 * 坐标     : WGS-84，经纬度直接使用。
 * ======================================================================= */

const API = "https://typhoon.nmc.cn/weatherservice/typhoon/jsons";

const GRADE = {
  TD:      { cn:"热带低压",   color:"#3DB2FF" },
  TS:      { cn:"热带风暴",   color:"#00D084" },
  STS:     { cn:"强热带风暴", color:"#FFD500" },
  TY:      { cn:"台风",       color:"#FF8C00" },
  STY:     { cn:"强台风",     color:"#FF3B30" },
  SuperTY: { cn:"超强台风",   color:"#C724B1" },
};
const gradeInfo = (g)=>GRADE[g]||{cn:g||"未知",color:"#8aa0c8"};

/* 风向 / 移动方向：英文 -> 中文 + 罗盘方位角(度, 顺时针自北) */
const DIR = {
  N:  {cn:"北",     deg:0},   NNE:{cn:"北东北", deg:22.5}, NE: {cn:"东北",   deg:45},  ENE:{cn:"东东北", deg:67.5},
  E:  {cn:"东",     deg:90},  ESE:{cn:"东东南", deg:112.5},SE: {cn:"东南",   deg:135}, SSE:{cn:"南东南", deg:157.5},
  S:  {cn:"南",     deg:180}, SSW:{cn:"南西南", deg:202.5},SW: {cn:"西南",   deg:225}, WSW:{cn:"西西南", deg:247.5},
  W:  {cn:"西",     deg:270}, WNW:{cn:"西西北", deg:292.5},NW: {cn:"西北",   deg:315}, NNW:{cn:"北西北", deg:337.5},
};
const dirCn  = (d)=> (DIR[d]&&DIR[d].cn) || d || "—";
const dirDeg = (d)=> (DIR[d] ? DIR[d].deg : null);

function fmtTime(str){ if(!str||str.length<12) return str||""; return `${str.slice(4,6)}-${str.slice(6,8)} ${str.slice(8,10)}:${str.slice(10,12)}`; }

async function fetchJSONP(url){
  const res=await fetch(url,{cache:"no-store"}); const text=await res.text();
  const s=text.indexOf("{"),e=text.lastIndexOf("}");
  if(s<0||e<0) throw new Error("返回格式异常");
  return JSON.parse(text.substring(s,e+1));
}

/* 近实时时间戳(向前取整到10分钟, 减去 lag 分钟) -> YYYY-MM-DDTHH:mm:00Z */
function nrtTime(lagMin){
  const d=new Date(Date.now()-lagMin*60000);
  d.setUTCSeconds(0,0); d.setUTCMinutes(Math.floor(d.getUTCMinutes()/10)*10);
  return d.toISOString().slice(0,19)+"Z";
}
function ymd(offsetDays){ const d=new Date(Date.now()+offsetDays*86400000); return d.toISOString().slice(0,10); }

const $=(id)=>document.getElementById(id);
function toast(msg){ const t=$("toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove("show"),2800); }
function showLoading(b){ $("loading").style.display=b?"flex":"none"; }
function tickClock(){ $("clock").textContent="UTC+8 "+new Date().toLocaleString("zh-CN",{hour12:false}); }
setInterval(tickClock,1000); tickClock();

/* ================= Cesium 初始化 =================
 * 说明：本环境无法访问 ESRI ArcGIS 瓦片(services.arcgisonline.com 被网络屏蔽)，
 *      因此全部改用经 CORS 验证可用的免费瓦片源：Google / CartoDB / NASA GIBS。
 * 地形：已接入用户的 Cesium ion Access Token，加载 Cesium World Terrain (Asset 1)
 *      真实三维高程地形（带顶点法线，含地形着色）。若加载失败（Token 失效/额度用尽）
 *      则优雅回退到椭球地形(平滑球面)，不会崩溃。
 * ================================================================= */

// Cesium ion Access Token（用户提供）—— 必须在创建 Viewer 之前设置
Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5OGQyOTU3Yy04ZTkyLTQ0MjMtOGE1Yi0yMDljNWRiNGVjMGIiLCJpZCI6NDU1MTI3LCJzdWIiOiJMaXl1cnVuIiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6ImxpeXJ1biIsImlhdCI6MTc4Mzc0MjA0OH0.jJ6uP6cJnmGEwqro1oCdkOuIw_kKZd903EdR39vCgoY";

// 初始使用椭球地形（同步创建 Viewer 所需）；随后异步替换为 Cesium World Terrain。
const terrainProvider = new Cesium.EllipsoidTerrainProvider();

/* ---------- 底图源定义（工厂函数：每次切换生成全新 provider，避免复用问题） ----------
 * labels=true 表示该底图本身没有地名/边界注记，需要叠加参考注记层。
 * 按用户要求：只保留“地形图”相关底图，去掉卫星影像 / 行政区划 / 深色底图。
 *   - topo   : Google 地形底图 (lyrs=p)，绿色地形晕渲 + 地名路网，经 CORS 验证可用；
 *   - relief : NASA GIBS ASTER GDEM 彩色晕渲地形，纯地形起伏着色（无注记），全球覆盖。 */
const BASEMAP_DEFS = {
  topo:{ label:"地形图", labels:false, make:()=>new Cesium.UrlTemplateImageryProvider({
    url:"https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}", subdomains:["0","1","2","3"],
    maximumLevel:19, credit:"Map data © Google" }) },
  relief:{ label:"晕渲地形", labels:true, make:()=>new Cesium.UrlTemplateImageryProvider({
    url:"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/ASTER_GDEM_Color_Shaded_Relief/default/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpg",
    maximumLevel:12, credit:"NASA GIBS · ASTER GDEM Color Shaded Relief" }) },
};
// 参考注记层（国界/地名，半透明叠加）——Google 混合注记，CORS 可用
const makeLabelProvider = ()=>new Cesium.UrlTemplateImageryProvider({
  url:"https://mt{s}.google.com/vt/lyrs=h&x={x}&y={y}&z={z}", subdomains:["0","1","2","3"],
  maximumLevel:19, credit:"Labels © Google" });

const viewer = new Cesium.Viewer("globe",{
  terrainProvider:terrainProvider,
  baseLayer:new Cesium.ImageryLayer(BASEMAP_DEFS.topo.make()),
  baseLayerPicker:false, geocoder:false, timeline:false, animation:false,
  homeButton:false, infoBox:false, sceneModePicker:false, navigationHelpButton:false,
  fullscreenButton:false, selectionIndicator:false, requestRenderMode:false,
  contextOptions:{ webgl:{ alpha:false, antialias:true } },
});

/* ================= 球形地球真实感增强 ================= */
const scene = viewer.scene;
const globe = scene.globe;

// 海洋/地表基础色（影像未加载时的球体底色，深海蓝）
globe.baseColor = Cesium.Color.fromCssColorString("#0a1a33");

// 光照与昼夜晨昏线（动态太阳）
globe.enableLighting = true;
globe.dynamicAtmosphereLighting = true;
globe.dynamicAtmosphereLightingFromSun = true;
globe.atmosphereLightIntensity = 12.0;
// 柔化夜面，避免台风/云图完全隐没在黑暗中
globe.lightingFadeOutDistance = 1.0e7;
globe.lightingFadeInDistance = 2.0e7;
globe.nightFadeOutDistance = 1.0e7;
globe.nightFadeInDistance = 5.0e7;

// 地面大气散射（贴近地表的蓝色辉光）
globe.showGroundAtmosphere = true;
globe.atmosphereBrightnessShift = 0.02;
globe.atmosphereSaturationShift = 0.10;

// 天空大气（球体边缘的蓝色 limb 辉光）
const sky = scene.skyAtmosphere;
sky.show = true;
sky.hueShift = 0.0;
sky.saturationShift = 0.10;
sky.brightnessShift = 0.04;
if(sky.atmosphereLightIntensity !== undefined) sky.atmosphereLightIntensity = 20.0;

// 大气景深雾（远处地表柔和过渡，不遮挡台风）
scene.fog.enabled = true;
scene.fog.density = 1.0e-4;
scene.fog.screenSpaceErrorFactor = 2.0;

// 太阳 / 月亮 / 星空
scene.sun.show = true;
if(scene.sun.glowFactor !== undefined) scene.sun.glowFactor = 1.4;
scene.moon.show = true;
scene.skyBox = new Cesium.SkyBox({
  sources:{
    positiveX: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_px.jpg"),
    negativeX: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_mx.jpg"),
    positiveY: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_py.jpg"),
    negativeY: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_my.jpg"),
    positiveZ: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_pz.jpg"),
    negativeZ: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_mz.jpg"),
  }
});

// HDR + 抗锯齿 + 轻微泛光（太阳/高光辉光）
try{
  if(scene.highDynamicRangeSupported){ scene.highDynamicRange = true; }
}catch(e){ scene.highDynamicRange = false; }
if(scene.postProcessStages && scene.postProcessStages.fxaa) scene.postProcessStages.fxaa.enabled = true;
try{
  const bloom = scene.postProcessStages.bloom;
  if(bloom){
    bloom.enabled = true;
    bloom.uniforms.glowOnly = false;
    bloom.uniforms.contrast = 120;
    bloom.uniforms.brightness = -0.35;
    bloom.uniforms.delta = 1.0;
    bloom.uniforms.sigma = 2.2;
    bloom.uniforms.stepSize = 1.0;
  }
}catch(e){ console.warn("bloom 不可用", e); }

viewer.cesiumWidget.creditContainer.style.display = "none";

/* ================= 真实三维地形 · Cesium World Terrain =================
 * 使用 Ion Asset 1（Cesium World Terrain），Cesium 1.121 的正确 API 为
 * CesiumTerrainProvider.fromIonAssetId(1, {...})，异步返回 provider。
 * requestVertexNormals:true 提供地形着色（山体明暗）。
 * 加载失败时优雅回退到椭球地形，绝不崩溃。 */
// 垂直夸张：让山体起伏更明显（1.121 使用 scene.verticalExaggeration）
try{
  if(scene.verticalExaggeration !== undefined){ scene.verticalExaggeration = 1.5; }
  else if(globe.terrainExaggeration !== undefined){ globe.terrainExaggeration = 1.5; }
}catch(e){ console.warn("verticalExaggeration 设置失败", e); }

(async function loadWorldTerrain(){
  try{
    const cwt = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, { requestVertexNormals:true });
    viewer.terrainProvider = cwt;
    globe.enableLighting = true;           // 地形着色依赖光照（已开启）
    console.log("[terrain] Cesium World Terrain 加载成功（真实三维高程地形）");
    if(typeof toast === "function") toast("已启用真实三维地形（Cesium World Terrain）");
  }catch(err){
    console.warn("[terrain] Cesium World Terrain 加载失败，回退椭球地形：", err);
    try{ viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider(); }catch(e){}
    if(typeof toast === "function") toast("三维地形不可用，已回退平滑球面地形");
  }
})();

/* 参考注记（国界/地名，半透明叠加） */
const refLabels = viewer.imageryLayers.addImageryProvider(makeLabelProvider());
refLabels.alpha = 0.6;
refLabels.show = BASEMAP_DEFS.topo.labels;

// 底图管理
let currentBaseKey = "topo";
let baseLayer = viewer.imageryLayers.get(0);   // 初始地形图层（Viewer 构造时创建）

function updateBaseButtons(){
  const map = {
    topo:"baseTopo",
    relief:"baseRelief",
  };
  Object.keys(map).forEach(function(k){
    const el = $(map[k]);
    if(el){ el.classList.toggle("on", k===currentBaseKey); }
  });
}

/* 切换底图：
 * 1) 先在最底层(index 0)加入新底图，再移除旧底图 —— 避免切换瞬间出现黑球闪烁；
 * 2) 每次都用工厂函数生成全新 provider，杜绝 provider 复用导致的不渲染问题；
 * 3) 根据底图是否自带注记，决定参考注记层的显隐；
 * 4) 最后把参考注记层与云图层重新提到顶部，保证叠加顺序正确、不遮挡台风覆盖物。 */
function setBaseMap(key){
  const def = BASEMAP_DEFS[key];
  if(!def || key===currentBaseKey || !viewer || !viewer.imageryLayers) return;
  currentBaseKey = key;
  const layers = viewer.imageryLayers;
  const oldLayer = baseLayer;
  // 支持同步 provider 与异步 provider(Promise, 如 Cesium World Imagery)
  const made = def.make();
  if(def.async || (made && typeof made.then === "function")){
    baseLayer = Cesium.ImageryLayer.fromProviderAsync(made, {});
    layers.add(baseLayer, 0);
  }else{
    baseLayer = layers.addImageryProvider(made, 0);   // 新底图置于最底层
  }
  if(oldLayer){ layers.remove(oldLayer, true); }          // 移除并销毁旧底图
  if(refLabels){ refLabels.show = !!def.labels; layers.raiseToTop(refLabels); }
  if(typeof cloudLayer!=="undefined" && cloudLayer){
    layers.raiseToTop(cloudLayer);
  }
  updateBaseButtons();
}

/* 初始视角：西太平洋全景（略微框住球体，凸显蓝色大气辉光） */
const HOME = { destination: Cesium.Cartesian3.fromDegrees(134, 18, 20000000) };
viewer.camera.setView(HOME);

/* ================= 云图图层 =================
 * 默认关闭：云图为不透明覆盖层，开启后会盖住地形底图，故首屏默认不显示，
 * 由用户按需在右侧“卫星云图”面板开启；默认浓度降到 0.5，开启后仍能透出地形。 */
let cloudLayer=null, cloudOn=false, cloudKind="ir", cloudAlpha=0.5;
function cloudConfig(kind){
  if(kind==="geocolor") return { layer:"GOES-East_ABI_GeoColor", tms:"GoogleMapsCompatible_Level7", max:6, fmt:"image/png",  time:nrtTime(180), label:"GOES-East GeoColor · 近实时(美洲)" };
  if(kind==="truecolor")return { layer:"VIIRS_NOAA20_CorrectedReflectance_TrueColor", tms:"GoogleMapsCompatible_Level9", max:7, fmt:"image/jpeg", time:ymd(-1), label:"VIIRS 真彩合成 · 每日" };
  return { layer:"Himawari_AHI_Band13_Clean_Infrared", tms:"GoogleMapsCompatible_Level6", max:6, fmt:"image/png", time:nrtTime(90), label:"葵花9号 Band13 红外 · 近实时" };
}
function setCloudLayer(kind){
  cloudKind=kind; const c=cloudConfig(kind);
  if(cloudLayer){ viewer.imageryLayers.remove(cloudLayer,true); cloudLayer=null; }
  const prov=new Cesium.WebMapTileServiceImageryProvider({
    url:"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi",
    layer:c.layer, style:"default", format:c.fmt,
    tileMatrixSetID:c.tms, maximumLevel:c.max,
    dimensions:{ time:c.time },
    tilingScheme:new Cesium.WebMercatorTilingScheme(),
    tileWidth:256, tileHeight:256, credit:"NASA GIBS"
  });
  cloudLayer=viewer.imageryLayers.addImageryProvider(prov);
  cloudLayer.alpha=cloudAlpha; cloudLayer.show=cloudOn;
  const t=c.time.includes("T") ? c.time.replace("T"," ").replace("Z"," UTC") : c.time+" (全天合成)";
  $("cloudDate").innerHTML = `数据：${c.label}<br/>时间：${t}`;
}
setCloudLayer("ir");

/* ================= 图标 Canvas ================= */
function eyeCanvas(color){
  const s=64, cv=document.createElement("canvas"); cv.width=cv.height=s; const g=cv.getContext("2d");
  const cx=s/2, cy=s/2;
  // 外发光
  const rg=g.createRadialGradient(cx,cy,2,cx,cy,30);
  rg.addColorStop(0,"rgba(255,255,255,.95)"); rg.addColorStop(.35,color+"cc"); rg.addColorStop(1,"rgba(0,0,0,0)");
  g.fillStyle=rg; g.beginPath(); g.arc(cx,cy,30,0,7); g.fill();
  // 旋臂
  g.strokeStyle="rgba(255,255,255,.92)"; g.lineWidth=3.4; g.lineCap="round";
  for(let k=0;k<2;k++){ g.beginPath();
    for(let a=0;a<=Math.PI*1.15;a+=0.12){ const r=4+a*7; const x=cx+Math.cos(a+k*Math.PI)*r, y=cy+Math.sin(a+k*Math.PI)*r; a===0?g.moveTo(x,y):g.lineTo(x,y);} g.stroke(); }
  // 台风眼
  g.fillStyle="#fff"; g.beginPath(); g.arc(cx,cy,4.5,0,7); g.fill();
  return cv;
}
function arrowCanvas(color){
  const w=30,h=44, cv=document.createElement("canvas"); cv.width=w; cv.height=h; const g=cv.getContext("2d");
  g.translate(w/2,h/2); // 箭头指向"上"(北)
  g.fillStyle=color; g.strokeStyle="rgba(0,0,0,.45)"; g.lineWidth=1.4;
  g.beginPath();
  g.moveTo(0,-19); g.lineTo(9,3); g.lineTo(2.5,3); g.lineTo(2.5,17); g.lineTo(-2.5,17); g.lineTo(-2.5,3); g.lineTo(-9,3); g.closePath();
  g.fill(); g.stroke();
  return cv;
}

/* ================= 状态 ================= */
let state = { year:new Date().getFullYear(), typhoons:[], focusId:null, mode:"all",
              showFc:true, showRing:true, autoTimer:null, playTimer:null };
let forceCamera = false;   // 当 URL 指定了相机位置(lon/lat)时置真，抑制加载完成后的自动全景飞行
const fcEnts=[]; // 预报路径实体(仅聚焦台风)
const swirl = new Cesium.CallbackProperty(()=> (performance.now()/1000)*1.4, false); // 逆时针旋臂

const focusTy = ()=> state.typhoons.find(t=>t.id===state.focusId);
const curPt   = (ty)=> ty.points[ty.cursor];
const posOf   = (ty)=> { const p=curPt(ty); return Cesium.Cartesian3.fromDegrees(p.lng,p.lat); };

/* ================= 数据加载 ================= */
function initYearSelector(){
  const cur=new Date().getFullYear(); const sel=$("yearSel"); sel.innerHTML="";
  for(let y=cur;y>=2010;y--){ const o=document.createElement("option"); o.value=y; o.textContent=y+"年"; sel.appendChild(o); }
  sel.value=cur; sel.onchange=()=>{ state.year=+sel.value; loadYear(state.year); };
}

async function loadYear(year){
  showLoading(true);
  try{
    const data=await fetchJSONP(`${API}/list_default?year=${year}`);
    let raw=(data.typhoonList||[]).filter(t=> t[1]!=="nameless");
    if(raw.length===0){ toast(`${year}年暂无台风数据`); clearAllTyphoons(); buildChips([]); showLoading(false); return; }

    const active = raw.filter(t=>t[7]==="start");
    let chosen = active.slice();
    let fallback = false;
    if(chosen.length < 2){                     // 无/仅一个活跃台风 -> 补充最近台风以演示多台风
      fallback = active.length===0;
      for(const t of raw){ if(chosen.length>=3) break; if(!chosen.includes(t)) chosen.push(t); }
    }

    // 并行拉取详情
    const details = await Promise.all(chosen.map(t=> fetchJSONP(`${API}/view_${t[0]}?id=${t[0]}`).catch(()=>null)));
    clearAllTyphoons();
    state.typhoons = [];
    chosen.forEach((meta,i)=>{
      const d = details[i] && details[i].typhoon; if(!d) return;
      const pts=(d[8]||[]).map(p=>({ time:p[1],ts:p[2],grade:p[3],lng:p[4],lat:p[5],
        pres:p[6],wind:p[7],dir:p[8],speed:p[9],radius:p[10],forecast:p[11] }));
      if(!pts.length) return;
      state.typhoons.push({
        id:meta[0], num:meta[3], cn:d[2]||meta[2]||d[1], en:d[1]||"", meaning:d[6]||"",
        active:meta[7]==="start", points:pts, cursor:pts.length-1, ents:{track:[],cas:null,pts:[],eye:null,label:null,arrow:null,circle:null}
      });
    });

    if(state.typhoons.length===0){ toast("台风路径数据为空"); buildChips([]); showLoading(false); return; }

    state.focusId = (state.typhoons.find(t=>t.active) || state.typhoons[0]).id;
    state.typhoons.forEach(buildTyphoonEntities);
    buildChips(state.typhoons);
    buildLegend();
    applyVisibility();
    updatePanel();
    drawForecast();
    flyToAll();

    const activeCnt=state.typhoons.filter(t=>t.active).length;
    if(fallback) toast(`${year}年当前无活跃台风，已展示最近 ${state.typhoons.length} 个台风`);
    else toast(`已加载 ${state.typhoons.length} 个台风（活跃 ${activeCnt} 个）`);
  }catch(e){ console.error(e); toast("加载台风数据失败"); }
  showLoading(false);
}

/* ================= 实体构建 ================= */
function clearAllTyphoons(){
  viewer.entities.removeAll(); fcEnts.length=0;
  state.typhoons.forEach(t=>{ t.ents={track:[],cas:null,pts:[],eye:null,label:null,arrow:null,circle:null}; });
}

function buildTyphoonEntities(ty){
  const pts=ty.points; const e=ty.ents;
  const carto=(p)=>Cesium.Cartesian3.fromDegrees(p.lng,p.lat);

  // 外发光描边（整条路径）
  const full=[]; pts.forEach(p=>full.push(p.lng,p.lat));
  e.cas = viewer.entities.add({ polyline:{ positions:Cesium.Cartesian3.fromDegreesArray(full),
    width:8, material:Cesium.Color.WHITE.withAlpha(0.18), clampToGround:false, arcType:Cesium.ArcType.GEODESIC },
    properties:{ ty:ty.id, kind:"cas" } });

  // 分段着色路径
  for(let i=1;i<pts.length;i++){
    const seg = viewer.entities.add({ polyline:{
      positions:[carto(pts[i-1]),carto(pts[i])],
      width:4, material:Cesium.Color.fromCssColorString(gradeInfo(pts[i].grade).color),
      clampToGround:false, arcType:Cesium.ArcType.GEODESIC },
      properties:{ ty:ty.id, kind:"track" } });
    e.track.push(seg);
  }

  // 观测点
  pts.forEach((p,i)=>{
    const g=gradeInfo(p.grade);
    const pt = viewer.entities.add({ position:carto(p),
      point:{ pixelSize:i===pts.length-1?0:6, color:Cesium.Color.fromCssColorString(g.color),
        outlineColor:Cesium.Color.WHITE.withAlpha(.85), outlineWidth:1.2,
        disableDepthTestDistance:Number.POSITIVE_INFINITY },
      properties:{ ty:ty.id, kind:"pt", idx:i,
        info:`<b>${ty.num} ${ty.cn}</b> · <b>${fmtTime(p.time)}</b><br/>等级：${g.cn}<br/>气压：${p.pres} hPa　风速：${p.wind} m/s<br/>移动：${dirCn(p.dir)} ${p.speed!=null?p.speed+" km/h":""}<br/>位置：${p.lat}°N, ${p.lng}°E` } });
    e.pts.push(pt);
  });

  const posCB = new Cesium.CallbackProperty(()=>posOf(ty), false);

  // 七级风圈（30KTS 四象限平均）
  e.circle = viewer.entities.add({ position:posCB,
    ellipse:{ semiMajorAxis:new Cesium.CallbackProperty(()=>ringRadius(ty),false),
      semiMinorAxis:new Cesium.CallbackProperty(()=>ringRadius(ty),false),
      height:0, material:Cesium.Color.fromCssColorString("#3fd0ff").withAlpha(0.10),
      outline:true, outlineColor:Cesium.Color.fromCssColorString("#3fd0ff").withAlpha(0.75), outlineWidth:2 },
    properties:{ ty:ty.id, kind:"circle" } });

  // 移动方向（风向）箭头
  const g0=gradeInfo(curPt(ty).grade);
  e.arrow = viewer.entities.add({ position:posCB,
    billboard:{ image:arrowCanvas("#ffd500"), scale:0.85, verticalOrigin:Cesium.VerticalOrigin.CENTER,
      pixelOffset:new Cesium.Cartesian2(0,-34),
      rotation:new Cesium.CallbackProperty(()=>{ const d=dirDeg(curPt(ty).dir); return d==null?0:Cesium.Math.toRadians(-d); },false),
      alignedAxis:Cesium.Cartesian3.ZERO,
      disableDepthTestDistance:Number.POSITIVE_INFINITY },
    properties:{ ty:ty.id, kind:"arrow",
      info:new Cesium.CallbackProperty(()=>{ const p=curPt(ty); return `移动方向：${dirCn(p.dir)}　速度：${p.speed!=null?p.speed+" km/h":"—"}`; },false) } });

  // 台风眼（旋转旋臂）
  e.eye = viewer.entities.add({ position:posCB,
    billboard:{ image:eyeCanvas(gradeInfo(curPt(ty).grade).color), scale:0.95,
      rotation:swirl, alignedAxis:Cesium.Cartesian3.ZERO,
      disableDepthTestDistance:Number.POSITIVE_INFINITY },
    properties:{ ty:ty.id, kind:"eye",
      info:new Cesium.CallbackProperty(()=>{ const p=curPt(ty); const g=gradeInfo(p.grade);
        return `<b>${ty.num} ${ty.cn}</b>${ty.active?" · 活跃":""}<br/>等级：${g.cn}　气压：${p.pres} hPa<br/>风速：${p.wind} m/s　移动：${dirCn(p.dir)}`; },false) } });

  // 名称标签
  e.label = viewer.entities.add({ position:posCB,
    label:{ text:new Cesium.CallbackProperty(()=>`${ty.num} ${ty.cn}${ty.active?" ●":""}`,false),
      font:"600 13px 'Noto Sans SC',sans-serif", fillColor:Cesium.Color.WHITE,
      outlineColor:Cesium.Color.fromCssColorString("#04121f"), outlineWidth:3, style:Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground:true, backgroundColor:Cesium.Color.fromCssColorString("#0b1428").withAlpha(0.72),
      backgroundPadding:new Cesium.Cartesian2(7,4), pixelOffset:new Cesium.Cartesian2(0,26),
      verticalOrigin:Cesium.VerticalOrigin.TOP, disableDepthTestDistance:Number.POSITIVE_INFINITY,
      scale:1.0 },
    properties:{ ty:ty.id, kind:"label" } });
}

function ringRadius(ty){
  const p=curPt(ty), r=p.radius; if(!r||!r.length) return 1;
  const c30=r.find(x=>x[0]==="30KTS")||r[0]; if(!c30) return 1;
  const avg=(c30[1]+c30[2]+c30[3]+c30[4])/4; return Math.max(avg*1000,1);
}

/* ================= 预报路径（聚焦台风） ================= */
function drawForecast(){
  fcEnts.forEach(e=>viewer.entities.remove(e)); fcEnts.length=0;
  if(!state.showFc) return;
  const ty=focusTy(); if(!ty) return;
  const p=ty.points[ty.points.length-1]; const fc=p.forecast; if(!fc) return;
  const agency=fc.BABJ||Object.values(fc)[0]; if(!agency||!agency.length) return;
  const path=[[p.lng,p.lat]];
  agency.forEach(f=>{ const g=gradeInfo(f[7]); path.push([f[2],f[3]]);
    fcEnts.push(viewer.entities.add({ position:Cesium.Cartesian3.fromDegrees(f[2],f[3]),
      point:{ pixelSize:5, color:Cesium.Color.fromCssColorString(g.color),
        outlineColor:Cesium.Color.WHITE, outlineWidth:1, disableDepthTestDistance:Number.POSITIVE_INFINITY },
      properties:{ kind:"fc", info:`<b>${ty.num} ${ty.cn} · +${f[0]}h 预报</b><br/>等级：${g.cn}<br/>气压：${f[4]} hPa　风速：${f[5]} m/s<br/>位置：${f[3]}°N, ${f[2]}°E` } }));
  });
  const arr=[]; path.forEach(c=>arr.push(c[0],c[1]));
  fcEnts.push(viewer.entities.add({ polyline:{ positions:Cesium.Cartesian3.fromDegreesArray(arr),
    width:2.5, material:new Cesium.PolylineDashMaterialProperty({ color:Cesium.Color.fromCssColorString("#ff7ad9"), dashLength:14 }),
    clampToGround:false, arcType:Cesium.ArcType.GEODESIC }, properties:{ kind:"fc" } }));
}

/* ================= 显隐控制 ================= */
function applyVisibility(){
  state.typhoons.forEach(ty=>{
    const vis = state.mode==="all" || ty.id===state.focusId;
    const e=ty.ents;
    [e.cas,e.eye,e.label,e.arrow].forEach(x=>{ if(x) x.show=vis; });
    e.track.forEach(x=>x.show=vis); e.pts.forEach(x=>x.show=vis);
    if(e.circle) e.circle.show = vis && state.showRing;
  });
  fcEnts.forEach(x=>x.show=state.showFc);
}

/* ================= 面板 / 图例 / 观测点列表 ================= */
function updatePanel(){
  const ty=focusTy(); if(!ty) return;
  const p=curPt(ty), g=gradeInfo(p.grade);
  $("tyName").textContent=`${ty.num||""} ${ty.cn}`;
  $("tyEn").textContent=`${ty.en}${ty.meaning?" · "+ty.meaning:""}`;
  const badge=$("tyBadge"); badge.textContent=g.cn; badge.style.background=g.color; badge.style.color=g.color;
  $("sPres").innerHTML=`${p.pres}<span class="u"> hPa</span>`;
  $("sWind").innerHTML=`${p.wind}<span class="u"> m/s</span>`;
  $("sDir").innerHTML=`${dirCn(p.dir)}${dirDeg(p.dir)!=null?` <span class="u">(${dirDeg(p.dir)}°)</span>`:""}`;
  $("sSpeed").innerHTML=`${p.speed!=null?p.speed:"—"}<span class="u"> km/h</span>`;
  $("sPos").textContent=`${p.lat}°N, ${p.lng}°E`;
  $("sTime").textContent=`观测：${fmtTime(p.time)}`+(ty.cursor===ty.points.length-1?"（最新）":"");
  $("tlLabel").textContent=`${fmtTime(p.time)} · ${g.cn}`;
  const tl=$("timeline"); tl.min=0; tl.max=ty.points.length-1; tl.value=ty.cursor;
  buildPointList(ty);
  updateChipActive();
}
function buildPointList(ty){
  const box=$("ptList"); box.innerHTML=""; const pts=ty.points; $("ptCount").textContent=`共 ${pts.length} 点`;
  for(let i=pts.length-1;i>=0;i--){ const p=pts[i],g=gradeInfo(p.grade);
    const row=document.createElement("div"); row.className="pt-row"; row.dataset.idx=i;
    row.innerHTML=`<span class="dot" style="background:${g.color};color:${g.color}"></span>
      <span style="width:78px;color:var(--sub)" class="mono">${fmtTime(p.time)}</span>
      <span style="width:58px">${g.cn}</span>
      <span style="color:var(--sub)">${p.pres}hPa · ${p.wind}m/s</span>`;
    row.onclick=()=>{ ty.cursor=i; updatePanel(); }; box.appendChild(row); }
  highlightPointRow(ty);
}
function highlightPointRow(ty){ document.querySelectorAll(".pt-row").forEach(r=>{ r.style.background=(+r.dataset.idx===ty.cursor)?"rgba(63,208,255,.16)":""; }); }
function buildLegend(){ const box=$("legendBody"); box.innerHTML="";
  Object.values(GRADE).forEach(g=>{ const row=document.createElement("div"); row.className="legend-row";
    row.innerHTML=`<span class="sw" style="background:${g.color}"></span>${g.cn}`; box.appendChild(row); }); }

/* 台风选择 chips */
function buildChips(list){
  const box=$("tyChips"); box.innerHTML="";
  if(!list.length){ box.innerHTML=`<div style="font-size:12px;color:var(--sub);padding:6px 2px">暂无台风</div>`; return; }
  list.forEach(ty=>{ const p=curPt(ty), g=gradeInfo(p.grade);
    const chip=document.createElement("div"); chip.className="ty-chip"; chip.dataset.id=ty.id;
    chip.innerHTML=`<span class="dot" style="background:${g.color};color:${g.color}"></span>
      <span style="flex:1"><b>${ty.num}</b> ${ty.cn}</span>
      ${ty.active?`<span class="live">活跃</span>`:""}`;
    chip.onclick=()=>focusTyphoon(ty.id,true);
    box.appendChild(chip);
  });
  updateChipActive();
}
function updateChipActive(){ document.querySelectorAll(".ty-chip").forEach(c=>c.classList.toggle("on",+c.dataset.id===state.focusId)); }

/* ================= 聚焦 / 飞行 ================= */
function focusTyphoon(id,fly){
  state.focusId=id; stopPlay();
  applyVisibility(); drawForecast(); applyVisibility(); updatePanel();
  if(fly){ const ty=focusTy(); if(ty) viewer.flyTo(ty.ents.eye,{ offset:new Cesium.HeadingPitchRange(0,-Math.PI/2.2,2600000) }).catch(()=>{}); }
}
function flyToAll(){
  if(forceCamera) return;   // URL 指定了相机位置时不做自动全景飞行
  const cs=[]; state.typhoons.forEach(t=>t.points.forEach(p=>cs.push(Cesium.Cartesian3.fromDegrees(p.lng,p.lat))));
  if(!cs.length) return;
  const sphere=Cesium.BoundingSphere.fromPoints(cs);
  viewer.camera.flyToBoundingSphere(sphere,{ duration:1.4, offset:new Cesium.HeadingPitchRange(0,-Math.PI/2.1, Math.max(sphere.radius*3.2,2600000)) });
}

/* ================= 交互：hover / click ================= */
const popupEl=$("popup");
const handler=new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
function readProp(v){ return (v&&typeof v.getValue==="function")?v.getValue(Cesium.JulianDate.now()):v; }
handler.setInputAction((m)=>{
  const picked=viewer.scene.pick(m.endPosition);
  if(picked&&picked.id&&picked.id.properties&&picked.id.properties.info){
    const info=readProp(picked.id.properties.info);
    popupEl.style.display="block"; popupEl.innerHTML=info;
    popupEl.style.left=m.endPosition.x+"px"; popupEl.style.top=m.endPosition.y+"px";
    viewer.scene.canvas.style.cursor="pointer";
  }else{ popupEl.style.display="none"; viewer.scene.canvas.style.cursor="default"; }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
handler.setInputAction((m)=>{
  const picked=viewer.scene.pick(m.position);
  if(picked&&picked.id&&picked.id.properties){
    const pr=picked.id.properties;
    const tyId=readProp(pr.ty); const kind=readProp(pr.kind);
    if(tyId!=null){ if(kind==="pt"){ const ty=state.typhoons.find(t=>t.id===tyId);
        if(ty){ state.focusId=tyId; ty.cursor=readProp(pr.idx); applyVisibility(); drawForecast(); applyVisibility(); updatePanel(); }
      } else focusTyphoon(tyId,true);
    }
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ================= 控件 ================= */
// 底图切换按钮（只保留地形图 / 晕渲地形）
[["baseTopo","topo","地形图"],
 ["baseRelief","relief","晕渲地形"],
].forEach(([id,key,label])=>{
  const el = $(id);
  if(!el) return;
  el.onclick = function(){
    setBaseMap(key);
    toast("已切换到底图：" + label);
  };
});
updateBaseButtons();

$("modeAll").onclick=()=>{ state.mode="all"; $("modeAll").classList.add("on"); $("modeSingle").classList.remove("on"); applyVisibility(); flyToAll(); };
$("modeSingle").onclick=()=>{ state.mode="single"; $("modeSingle").classList.add("on"); $("modeAll").classList.remove("on"); applyVisibility(); focusTyphoon(state.focusId,true); };

$("timeline").oninput=(e)=>{ const ty=focusTy(); if(!ty) return; ty.cursor=+e.target.value; updatePanel(); };
$("playBtn").onclick=function(){
  if(state.playTimer){ stopPlay(); return; }
  const ty=focusTy(); if(!ty) return;
  this.classList.add("on"); this.querySelector(".material-symbols-outlined").textContent="pause";
  if(ty.cursor>=ty.points.length-1) ty.cursor=0;
  state.playTimer=setInterval(()=>{ const t=focusTy(); if(!t){stopPlay();return;}
    if(t.cursor>=t.points.length-1){ stopPlay(); return; } t.cursor++; updatePanel(); },550);
};
function stopPlay(){ if(state.playTimer){ clearInterval(state.playTimer); state.playTimer=null; }
  const b=$("playBtn"); b.classList.remove("on"); b.querySelector(".material-symbols-outlined").textContent="play_arrow"; }

$("fcBtn").onclick=function(){ state.showFc=!state.showFc; this.classList.toggle("on",state.showFc); drawForecast(); applyVisibility(); };
$("ringBtn").onclick=function(){ state.showRing=!state.showRing; this.classList.toggle("on",state.showRing); applyVisibility(); };
$("homeBtn").onclick=()=>{ state.mode="all"; $("modeAll").classList.add("on"); $("modeSingle").classList.remove("on"); applyVisibility(); flyToAll(); };
$("refreshBtn").onclick=()=>{ loadYear(state.year); toast("正在刷新台风与云图数据"); setCloudLayer(cloudKind); };
$("autoBtn").onclick=function(){
  if(state.autoTimer){ clearInterval(state.autoTimer); state.autoTimer=null; this.classList.remove("on"); toast("已关闭自动刷新"); return; }
  this.classList.add("on"); toast("已开启自动刷新（每10分钟）");
  state.autoTimer=setInterval(()=>{ loadYear(state.year); setCloudLayer(cloudKind); },600000);
};
$("fcBtn").classList.add("on"); $("ringBtn").classList.add("on");

/* 云图开关 / 类型 / 浓度 */
$("cloudToggle").onclick=function(){
  cloudOn=!cloudOn; if(cloudLayer) cloudLayer.show=cloudOn; this.classList.toggle("on",cloudOn);
  $("cloudOpRow").style.opacity=cloudOn?"1":".45"; toast(cloudOn?"已开启卫星云图":"已关闭卫星云图");
};
$("cloudSel").onchange=(e)=>{ setCloudLayer(e.target.value); if(cloudOn) toast("已切换云图数据源"); };
$("cloudOp").oninput=(e)=>{ cloudAlpha=e.target.value/100; if(cloudLayer) cloudLayer.alpha=cloudAlpha; };
if(cloudOn){ $("cloudToggle").classList.add("on"); $("cloudOpRow").style.opacity="1"; } else { $("cloudOpRow").style.opacity=".45"; }

/* ================= 启动 ================= */
initYearSelector();
loadYear(state.year);

/* URL 参数 ?base=topo|relief 可指定初始底图（便于自动化验证/分享）
 * URL 参数 ?lon=&lat=&h=&pitch= 可指定初始相机位置（便于验证三维地形起伏） */
(function(){
  try{
    const q = new URLSearchParams(location.search);
    const b = q.get("base");
    if(b && BASEMAP_DEFS[b] && b!==currentBaseKey){ setBaseMap(b); toast("已切换到底图："+BASEMAP_DEFS[b].label); }
    const lon = parseFloat(q.get("lon")), lat = parseFloat(q.get("lat"));
    if(!isNaN(lon) && !isNaN(lat)){
      forceCamera = true;   // 抑制自动全景飞行
      const h = parseFloat(q.get("h")) || 12000;
      const pitch = q.get("pitch")!=null ? parseFloat(q.get("pitch")) : -25;
      // 延迟飞行，确保地形瓦片已开始加载
      setTimeout(function(){
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
          orientation: { heading: Cesium.Math.toRadians(0),
                         pitch: Cesium.Math.toRadians(pitch), roll: 0 }
        });
      }, 1500);
    }
  }catch(e){}
})();
