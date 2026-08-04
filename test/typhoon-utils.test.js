"use strict";

const TU = require("../lib/typhoon-utils.js");

describe("gradeInfo", () => {
  test("返回已知强度等级的中文名与配色", () => {
    expect(TU.gradeInfo("TD")).toEqual({ cn: "热带低压", color: "#3DB2FF" });
    expect(TU.gradeInfo("SuperTY")).toEqual({ cn: "超强台风", color: "#C724B1" });
  });

  test("未知等级回退：用原始值作为名称、灰色作为配色", () => {
    expect(TU.gradeInfo("XX")).toEqual({ cn: "XX", color: "#8aa0c8" });
  });

  test("空/未定义等级回退为“未知”", () => {
    expect(TU.gradeInfo(undefined)).toEqual({ cn: "未知", color: "#8aa0c8" });
    expect(TU.gradeInfo("")).toEqual({ cn: "未知", color: "#8aa0c8" });
  });

  test("GRADE 覆盖全部六个官方强度等级", () => {
    expect(Object.keys(TU.GRADE)).toEqual(["TD", "TS", "STS", "TY", "STY", "SuperTY"]);
  });
});

describe("dirCn / dirDeg", () => {
  test("已知罗盘方位的中文与角度", () => {
    expect(TU.dirCn("N")).toBe("北");
    expect(TU.dirDeg("N")).toBe(0);
    expect(TU.dirCn("SE")).toBe("东南");
    expect(TU.dirDeg("SE")).toBe(135);
    expect(TU.dirDeg("NNW")).toBe(337.5);
  });

  test("16 个方位全部定义且角度递增 22.5°", () => {
    const keys = Object.keys(TU.DIR);
    expect(keys).toHaveLength(16);
    keys.forEach((k, i) => expect(TU.DIR[k].deg).toBeCloseTo(i * 22.5, 5));
  });

  test("未知方位：dirCn 回退到原值或占位符，dirDeg 返回 null", () => {
    expect(TU.dirCn("ZZ")).toBe("ZZ");
    expect(TU.dirCn(undefined)).toBe("—");
    expect(TU.dirCn("")).toBe("—");
    expect(TU.dirDeg("ZZ")).toBeNull();
  });
});

describe("fmtTime", () => {
  test("将 YYYYMMDDHHmm 时间戳格式化为 MM-DD HH:mm", () => {
    expect(TU.fmtTime("202408040406")).toBe("08-04 04:06");
  });

  test("多余字符被忽略（仅取前 12 位对应片段）", () => {
    expect(TU.fmtTime("20240804040659")).toBe("08-04 04:06");
  });

  test("长度不足 12 或空值时原样返回", () => {
    expect(TU.fmtTime("2024")).toBe("2024");
    expect(TU.fmtTime("")).toBe("");
    expect(TU.fmtTime(undefined)).toBe("");
    expect(TU.fmtTime(null)).toBe("");
  });
});

describe("nrtTime", () => {
  test("向下取整到 10 分钟并减去 lag 分钟，输出 UTC ISO", () => {
    // 2024-08-04T04:06:37Z, lag=90min -> 02:36:37 -> 向下取整到 02:30
    const now = Date.UTC(2024, 7, 4, 4, 6, 37);
    expect(TU.nrtTime(90, now)).toBe("2024-08-04T02:30:00Z");
  });

  test("lag=0 时仅做 10 分钟向下取整与清零秒数", () => {
    const now = Date.UTC(2024, 7, 4, 4, 19, 59);
    expect(TU.nrtTime(0, now)).toBe("2024-08-04T04:10:00Z");
  });

  test("会跨小时/跨日回退", () => {
    const now = Date.UTC(2024, 7, 4, 0, 5, 0);
    expect(TU.nrtTime(30, now)).toBe("2024-08-03T23:30:00Z");
  });

  test("省略 now 时默认取当前时间，输出合法 ISO 且分钟为 10 的倍数", () => {
    const out = TU.nrtTime(0);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Number(out.slice(14, 16)) % 10).toBe(0);
  });
});

describe("ymd", () => {
  test("offset=0 返回当天 UTC 日期", () => {
    const now = Date.UTC(2024, 7, 4, 4, 0, 0);
    expect(TU.ymd(0, now)).toBe("2024-08-04");
  });

  test("负偏移返回前一天（昨日合成）", () => {
    const now = Date.UTC(2024, 7, 4, 4, 0, 0);
    expect(TU.ymd(-1, now)).toBe("2024-08-03");
  });

  test("正偏移跨月", () => {
    const now = Date.UTC(2024, 7, 31, 12, 0, 0);
    expect(TU.ymd(1, now)).toBe("2024-09-01");
  });

  test("省略 now 时默认取当前日期（合法 YYYY-MM-DD）", () => {
    expect(TU.ymd(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("cloudConfig", () => {
  const now = Date.UTC(2024, 7, 4, 4, 6, 37);

  test("默认（ir / 未知）返回葵花红外配置，时间由 nrtTime(90) 决定", () => {
    const c = TU.cloudConfig("ir", now);
    expect(c.layer).toBe("Himawari_AHI_Band13_Clean_Infrared");
    expect(c.fmt).toBe("image/png");
    expect(c.max).toBe(6);
    expect(c.time).toBe(TU.nrtTime(90, now));
    expect(TU.cloudConfig("something-else", now).layer).toBe(c.layer);
  });

  test("geocolor 返回 GOES 配置，lag=180", () => {
    const c = TU.cloudConfig("geocolor", now);
    expect(c.layer).toBe("GOES-East_ABI_GeoColor");
    expect(c.time).toBe(TU.nrtTime(180, now));
  });

  test("truecolor 返回 VIIRS 每日合成（前一天日期）", () => {
    const c = TU.cloudConfig("truecolor", now);
    expect(c.layer).toBe("VIIRS_NOAA20_CorrectedReflectance_TrueColor");
    expect(c.fmt).toBe("image/jpeg");
    expect(c.time).toBe(TU.ymd(-1, now));
  });
});

describe("esc", () => {
  test("转义 & < > 三种 XML 敏感字符", () => {
    expect(TU.esc("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("先转义 & 再转义尖括号，避免二次转义", () => {
    expect(TU.esc("<a>&")).toBe("&lt;a&gt;&amp;");
  });

  test("非字符串输入被 String() 强制转换", () => {
    expect(TU.esc(42)).toBe("42");
    expect(TU.esc(null)).toBe("null");
  });
});

describe("parseJsonpBody", () => {
  test("从 JSONP 包裹中截取 JSON 对象并解析", () => {
    expect(TU.parseJsonpBody('callback({"a":1,"b":[2,3]});')).toEqual({ a: 1, b: [2, 3] });
  });

  test("允许对象前后有噪声文本", () => {
    expect(TU.parseJsonpBody('var x = {"ok":true} // trailing')).toEqual({ ok: true });
  });

  test("找不到花括号时抛出格式异常", () => {
    expect(() => TU.parseJsonpBody("no json here")).toThrow("返回格式异常");
  });

  test("内部 JSON 非法时向上抛错", () => {
    expect(() => TU.parseJsonpBody("{not valid json}")).toThrow();
  });
});

describe("speedColor", () => {
  test("最低档及以下返回首个色标（深蓝）", () => {
    expect(TU.speedColor(0)).toEqual([58, 92, 200]);
    expect(TU.speedColor(-5)).toEqual([58, 92, 200]);
  });

  test("命中断点处返回该断点精确颜色", () => {
    expect(TU.speedColor(3)).toEqual([42, 160, 235]);
    expect(TU.speedColor(30)).toEqual([242, 60, 48]);
  });

  test("断点之间做线性插值并四舍五入", () => {
    // 0->3 之间的中点 1.5：R=(58+42)/2=50, G=(92+160)/2=126, B=(200+235)/2=217.5->218
    expect(TU.speedColor(1.5)).toEqual([50, 126, 218]);
  });

  test("超过最高档返回极端品红色", () => {
    expect(TU.speedColor(100)).toEqual([180, 30, 120]);
  });
});

describe("windUV", () => {
  test("北风（来向 0°）产生向南的 V 分量、零 U 分量", () => {
    const [u, v] = TU.windUV(10, 0);
    expect(u).toBeCloseTo(0, 6);
    expect(v).toBeCloseTo(-10, 6);
  });

  test("东风（来向 90°）产生向西的 U 分量", () => {
    const [u, v] = TU.windUV(10, 90);
    expect(u).toBeCloseTo(-10, 6);
    expect(v).toBeCloseTo(0, 6);
  });

  test("风速为 0 时两个分量均为 0", () => {
    const [u, v] = TU.windUV(0, 123);
    expect(Math.abs(u)).toBe(0);
    expect(Math.abs(v)).toBe(0);
  });
});

describe("sampleGrid", () => {
  // 2x2 规则网格，la1(最北)=10，向南递减；lo1=100 向东递增，步长 1。
  const grid = {
    lo1: 100, la1: 10, dx: 1, dy: 1, nx: 2, ny: 2,
    //          (100,10) (101,10) (100,9) (101,9)
    u: [0, 4, 8, 12],
    v: [0, 0, 0, 0],
  };

  test("grid 为空时返回 null", () => {
    expect(TU.sampleGrid(null, 100, 10)).toBeNull();
  });

  test("落在网格结点上直接取该点值", () => {
    const [u, v, sp] = TU.sampleGrid(grid, 100, 10);
    expect(u).toBe(0);
    expect(v).toBe(0);
    expect(sp).toBe(0);
  });

  test("双线性插值：网格正中央取四角平均", () => {
    const [u] = TU.sampleGrid(grid, 100.5, 9.5);
    expect(u).toBeCloseTo((0 + 4 + 8 + 12) / 4, 6); // = 6
  });

  test("speed 为 U/V 分量的模", () => {
    const g2 = { lo1: 0, la1: 0, dx: 1, dy: 1, nx: 2, ny: 2, u: [3, 3, 3, 3], v: [4, 4, 4, 4] };
    const [, , sp] = TU.sampleGrid(g2, 0.5, -0.5);
    expect(sp).toBeCloseTo(5, 6);
  });

  test("超出经纬度范围返回 null", () => {
    expect(TU.sampleGrid(grid, 99, 10)).toBeNull();   // 偏西
    expect(TU.sampleGrid(grid, 103, 10)).toBeNull();  // 偏东
    expect(TU.sampleGrid(grid, 100, 12)).toBeNull();  // 偏北
    expect(TU.sampleGrid(grid, 100, 7)).toBeNull();   // 偏南
  });
});
