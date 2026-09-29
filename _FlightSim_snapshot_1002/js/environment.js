/* =========================================================================
 * environment.js — 昼夜环境配色
 *
 * 输入一个「小时数」（0..24，可带小数），输出一整套环境参数：
 * 太阳方向、直射光颜色/强度、半球光、环境光、天空三层渐变色、雾色、
 * 星空可见度、灯具亮度。
 *
 * 只依赖 THREE 的 Color / Vector3，不碰 DOM，可以在 Node 里直接回归。
 * ========================================================================= */
(function (root, factory) {
  var api = factory(root.THREE);
  root.SimEnv = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (THREE) {
  'use strict';

  var R2D = 180 / Math.PI;
  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };

  /* ---------------------------------------------------------------------
   * 太阳位置
   * 简化模型：6:00 从正东升起，12:00 在正南最高，18:00 从正西落下。
   * 方位角从正北顺时针计；方向向量是「从场景指向太阳」。
   * ------------------------------------------------------------------- */
  var SUNRISE = 6.0, SUNSET = 18.0, MAX_ELEV = 62;

  function sunDirection(hour, out) {
    var dayT = (hour - SUNRISE) / (SUNSET - SUNRISE);   // 0=日出 1=日落
    var az = (90 + dayT * 180) * Math.PI / 180;         // 东 -> 南 -> 西
    // 夜间的"太阳"沿同一轨迹继续走到地平线以下
    var elev = Math.sin(clamp(dayT, -0.5, 1.5) * Math.PI) * MAX_ELEV * Math.PI / 180;
    out = out || new THREE.Vector3();
    var ce = Math.cos(elev);
    out.set(ce * Math.sin(az), Math.sin(elev), -ce * Math.cos(az));
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  function sunElevationDeg(hour) {
    var dayT = (hour - SUNRISE) / (SUNSET - SUNRISE);
    return Math.sin(clamp(dayT, -0.5, 1.5) * Math.PI) * MAX_ELEV;
  }

  /* ---------------------------------------------------------------------
   * 配色关键帧（按太阳高度角排列，从深夜到正午）
   * ------------------------------------------------------------------- */
  var STOPS = [
    { e: -30, top: 0x04060d, mid: 0x070c1a, bot: 0x0b1220, sun: 0x1a2440, sunI: 0.00,
      hSky: 0x141d33, hGnd: 0x080a10, hI: 0.16, amb: 0.085, fog: 0x080d18, star: 1.00, lamp: 1.00 },
    { e: -12, top: 0x070c1c, mid: 0x101830, bot: 0x1c2438, sun: 0x2a3a60, sunI: 0.02,
      hSky: 0x1c2742, hGnd: 0x0c0f16, hI: 0.20, amb: 0.10, fog: 0x121a2c, star: 1.00, lamp: 1.00 },
    { e: -5,  top: 0x101a38, mid: 0x2a2c4e, bot: 0x53384e, sun: 0x7a4258, sunI: 0.08,
      hSky: 0x333c62, hGnd: 0x16161c, hI: 0.30, amb: 0.12, fog: 0x2c2c44, star: 0.72, lamp: 0.95 },
    { e: 0,   top: 0x1c3466, mid: 0x6b5a7e, bot: 0xff9a52, sun: 0xff8033, sunI: 0.38,
      hSky: 0x6c6e96, hGnd: 0x38291f, hI: 0.44, amb: 0.14, fog: 0x8a6a58, star: 0.34, lamp: 0.70 },
    { e: 7,   top: 0x27569e, mid: 0x93a6c6, bot: 0xffc684, sun: 0xffc070, sunI: 1.00,
      hSky: 0x9eb4d4, hGnd: 0x4a4030, hI: 0.56, amb: 0.15, fog: 0xc0a184, star: 0.06, lamp: 0.35 },
    { e: 20,  top: 0x2b6cc4, mid: 0x8fb8e0, bot: 0xc3d6e4, sun: 0xfff0d0, sunI: 1.32,
      hSky: 0xbcd8ff, hGnd: 0x4d5a3c, hI: 0.62, amb: 0.16, fog: 0x9dbdd8, star: 0.00, lamp: 0.00 },
    { e: 62,  top: 0x1f60c2, mid: 0x88b6e6, bot: 0xd2e2ee, sun: 0xfffcf2, sunI: 1.52,
      hSky: 0xcae4ff, hGnd: 0x55603f, hI: 0.68, amb: 0.17, fog: 0xa9c7de, star: 0.00, lamp: 0.00 }
  ];

  var _c1 = new THREE.Color(), _c2 = new THREE.Color(), _out = new THREE.Color();

  function lerpColor(out, a, b, t) {
    _c1.setHex(a); _c2.setHex(b);
    out.copy(_c1).lerp(_c2, t);
    return out;
  }

  function lerpHex(a, b, t) {
    _c1.setHex(a); _c2.setHex(b);
    return _out.copy(_c1).lerp(_c2, t).getHex();
  }

  /* ---------------------------------------------------------------------
   * 主入口：hour -> 环境参数
   * ------------------------------------------------------------------- */
  function at(hour, out) {
    hour = ((hour % 24) + 24) % 24;
    var e = sunElevationDeg(hour);

    // 找到夹住当前高度角的两帧
    var i = 0;
    while (i < STOPS.length - 2 && e > STOPS[i + 1].e) i++;
    var a = STOPS[i], b = STOPS[i + 1];
    var t = clamp((e - a.e) / (b.e - a.e), 0, 1);
    t = t * t * (3 - 2 * t);           // 平滑，避免关键帧处出现折角

    out = out || {};
    out.hour = hour;
    out.elevation = e;
    out.top = lerpHex(a.top, b.top, t);
    out.mid = lerpHex(a.mid, b.mid, t);
    out.bottom = lerpHex(a.bot, b.bot, t);
    out.sunColor = lerpHex(a.sun, b.sun, t);
    out.sunIntensity = a.sunI + (b.sunI - a.sunI) * t;
    out.hemiSky = lerpHex(a.hSky, b.hSky, t);
    out.hemiGround = lerpHex(a.hGnd, b.hGnd, t);
    out.hemiIntensity = a.hI + (b.hI - a.hI) * t;
    out.ambient = a.amb + (b.amb - a.amb) * t;
    out.fog = lerpHex(a.fog, b.fog, t);
    out.star = a.star + (b.star - a.star) * t;
    out.lamp = a.lamp + (b.lamp - a.lamp) * t;
    out.night = clamp(-e / 8, 0, 1);   // 0=白天 1=全黑，给灯具/星空用

    // 太阳与月亮各一盏平行光，强度交叉淡入淡出。
    // 只切换方向会在黄昏出现 180° 的光照突跳，两盏灯就没这个问题。
    out.sunDir = sunDirection(hour, out.sunDir || new THREE.Vector3());
    out.moonDir = (out.moonDir || new THREE.Vector3()).copy(out.sunDir).negate();
    out.sunLight = out.sunIntensity;
    out.sunLightColor = out.sunColor;
    var night = clamp((-e - 1.5) / 12, 0, 1);
    out.moonLight = 0.26 * clamp((-e + 1.0) / 6, 0, 1);
    out.moonLightColor = lerpHex(0x3d4c6e, 0x9fb4dc, night);
    out.isMoon = (e < -1.5);
    return out;
  }

  function label(hour) {
    hour = ((hour % 24) + 24) % 24;
    var h = Math.floor(hour), m = Math.round((hour - h) * 60);
    if (m === 60) { m = 0; h = (h + 1) % 24; }
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function phaseName(hour) {
    hour = ((hour % 24) + 24) % 24;
    var e = sunElevationDeg(hour);
    var morning = hour < 12;
    if (e > 25) return '白天';
    if (e > 8) return morning ? '上午' : '午后';
    if (e > 0) return morning ? '清晨' : '黄昏';
    if (e > -5) return morning ? '黎明' : '暮色';
    return '夜晚';
  }

  /* 预设时刻，供开始界面选择 */
  var PRESETS = [
    { key: 'dawn',    hour: 6.4,  label: '清晨' },
    { key: 'noon',    hour: 12.5, label: '正午' },
    { key: 'sunset',  hour: 17.9, label: '黄昏' },
    { key: 'night',   hour: 22.0, label: '夜晚' }
  ];

  return {
    at: at,
    label: label,
    phaseName: phaseName,
    sunDirection: sunDirection,
    sunElevationDeg: sunElevationDeg,
    PRESETS: PRESETS,
    STOPS: STOPS
  };
});
