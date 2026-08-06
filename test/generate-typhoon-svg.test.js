"use strict";

const gen = require("../scripts/generate-typhoon-svg.js");

describe("generate-typhoon-svg 导出的纯函数", () => {
  test("复用 lib 的 esc / gradeInfo", () => {
    expect(gen.esc("<x>&")).toBe("&lt;x&gt;&amp;");
    expect(gen.gradeInfo("STY")).toEqual({ cn: "强台风", color: "#FF3B30" });
    expect(Object.keys(gen.GRADE)).toContain("SuperTY");
  });
});

describe("loadCoastline", () => {
  test("能读取并解析随仓库分发的海岸线数据", () => {
    const coast = gen.loadCoastline();
    expect(coast).not.toBeNull();
    expect(Array.isArray(coast.feats)).toBe(true);
  });
});

describe("renderSVG", () => {
  const sampleTyphoon = {
    num: "2401",
    cn: "艾云尼",
    en: "Ewiniar",
    active: true,
    pts: [
      { grade: "TS", lng: 125, lat: 15, pres: 998, wind: 20 },
      { grade: "TY", lng: 128, lat: 20, pres: 970, wind: 38 },
      { grade: "STY", lng: 132, lat: 26, pres: 945, wind: 48 },
    ],
  };

  test("生成结构完整、尺寸正确的 SVG 文档", () => {
    const svg = gen.renderSVG([sampleTyphoon], { year: 2024, noActive: false, coast: null });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="900"');
    expect(svg).toContain('height="560"');
  });

  test("包含台风编号+名称标签与强度配色路径", () => {
    const svg = gen.renderSVG([sampleTyphoon], { year: 2024, noActive: false, coast: null });
    expect(svg).toContain("2401 艾云尼");
    // 分段路径使用每段起点(索引 i)的强度着色
    expect(svg).toContain("#FF8C00"); // TY
    expect(svg).toContain("#FF3B30"); // STY
    // 观测点数量：三个点各一个 r=2.2 圆点
    const obsDots = svg.match(/r="2\.2"/g) || [];
    expect(obsDots).toHaveLength(3);
  });

  test("noActive=true 时副标题展示“最近 N 个”文案", () => {
    const svg = gen.renderSVG([sampleTyphoon], { year: 2023, noActive: true, coast: null });
    expect(svg).toContain("2023年当前无活跃台风，展示最近 1 个");
  });

  test("noActive=false 时副标题展示活跃台风数量", () => {
    const svg = gen.renderSVG([sampleTyphoon], { year: 2024, noActive: false, coast: null });
    expect(svg).toContain("当前活跃台风 1 个");
  });

  test("无台风时仍生成合法 SVG（含图例与标题）", () => {
    const svg = gen.renderSVG([], { year: 2024, noActive: true, coast: null });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Typhoon Live Tracks");
    expect(svg).toContain("热带低压"); // 图例
  });

  test("提供 coast 数据时渲染陆地填充路径", () => {
    const coast = {
      feats: [
        { p: [[[[120, 20], [140, 20], [140, 40], [120, 40], [120, 20]]]] },
      ],
    };
    const svg = gen.renderSVG([sampleTyphoon], { year: 2024, noActive: false, coast });
    expect(svg).toContain('fill="#16233f"');
    expect(svg).toContain('fill-rule="evenodd"');
  });

  test("对名称中的 XML 敏感字符做转义", () => {
    const t = Object.assign({}, sampleTyphoon, { cn: "A<B>&C" });
    const svg = gen.renderSVG([t], { year: 2024, noActive: false, coast: null });
    expect(svg).toContain("A&lt;B&gt;&amp;C");
    expect(svg).not.toContain("A<B>&C");
  });
});

describe("fetchJSONP", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test("解析 JSONP 响应体为对象", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve('cb({"typhoonList":[[1,"ewiniar"]]});'),
    });
    const data = await gen.fetchJSONP("https://example.test/list");
    expect(data).toEqual({ typhoonList: [[1, "ewiniar"]] });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.test/list",
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  test("响应体无法解析时抛出带 URL 的格式异常", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve("garbage-without-braces"),
    });
    await expect(gen.fetchJSONP("https://example.test/bad"))
      .rejects.toThrow("返回格式异常: https://example.test/bad");
  });
});
