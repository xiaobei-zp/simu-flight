/* =========================================================================
 * aircraft-types.js — 机型定义（四种真实飞机）
 *
 * 每种机型给出三套数据：
 *   real   ：真机公开数据，界面上直接展示
 *   geometry：尺寸按真机来，aircraft.js 按这份规格参数化建模
 *   physics ：气动参数，直接覆盖 physics.js 的 DEFAULTS
 *
 * 真机数据与实际能飞出来的数据往往有差距（这个模拟器没有跨音速阻力上升、
 * 没有变距桨效率模型等），所以 perf() 会把「这个模型实际能飞出的数字」
 * 也算出来，界面上两个都给，不混为一谈。
 *
 * 只依赖 THREE 的约定（实际不依赖），不碰 DOM，可在 Node 里回归。
 * ========================================================================= */
(function (root, factory) {
  var api = factory();
  root.SimAircraftTypes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TYPES = [

    /* =====================================================================
     * 1. 教练机 —— 下单翼单发活塞教练机
     *    尺寸与气动按同级真机（如 PA-28 / C172 这一级）标定，
     *    但不绑定具体型号
     * =================================================================== */
    {
      key: 'trainer',
      name: '教练机',
      tag: 'TRAINER · SINGLE-ENGINE PISTON',
      desc: '下单翼单发活塞教练机。速度慢、失速温和、起降容易，推荐新手。',
      bench: {
        note: '同级真机参考',
        power: '180 hp 活塞 · 定距桨',
        span: 10.7, length: 7.25, area: 15.8, mass: 1157,
        vsKmh: 94, cruiseKmh: 230, vneKmh: 285, climb: 3.9
      },
      colors: { body: 0xf3f5f7, accent: 0x1d4f96, accent2: 0xd23b2e, dark: 0x23262b, metal: 0x9aa2ab },
      fuselage: { len: 5.6, rF: 0.46, rR: 0.63, z: -0.30, noseLen: 0.50, section: 1.06,
        profile: [[0, 0.44], [0.12, 0.55], [0.34, 0.60], [0.60, 0.55], [0.84, 0.38], [1, 0.22]] },
      canopy: { x: 0, y: 0.46, z: -0.85, sx: 0.44, sy: 0.42, sz: 1.05 },
      // span 4.93 × 2 + 翼根留出机身宽度 = 10.7 m
      wing: { chord0: 2.05, chord1: 1.10, span: 4.93, thick: 0.30, sweep: -0.28, dihedral: 5, x: 0.42, y: 0.00, z: 0.20 },
      aileron: { t0: 0.36, t1: 0.93, cf: 0.72, thickFrac: 0.42 },
      flap: { t0: 0.10, t1: 0.34, cf: 0.72, thickFrac: 0.42 },
      winglet: { h: 0.95, len: 0.80, thick: 0.09, tilt: 0.13, up: 0.28 },
      stab: { chord0: 1.20, chord1: 0.66, span: 1.95, thick: 0.20, sweep: 0.06, dihedral: 0, x: 0.14, y: 0.26, z: 1.95 },
      elevator: { t0: 0.06, t1: 0.94, cf: 0.62, thickFrac: 0.50 },
      fin: { chord0: 1.62, chord1: 0.86, span: 1.48, thick: 0.17, sweep: 0.32, x: 0, y: 0.30, z: 1.90 },
      rudder: { t0: 0.06, t1: 0.96, cf: 0.62, thickFrac: 0.55 },
      tailType: 'conv', finTwin: false,
      engine: { type: 'prop', blades: 2, propR: 0.95, bladeLen: 1.90, spinZ: -3.20 },
      gear: { type: 'tricycle', noseZ: -2.15, mainZ: -0.05, mainX: 1.28, wheelR: 0.32, legDrop: 1.16 },
      gearH: 1.50, bellyH: 0.62,
      eye: [0, 0.80, -0.35],
      physics: {
        mass: 1157, wingArea: 15.8, AR: 7.25, oswald: 0.80,
        maxThrust: 2500, thrustFalloff: 185,
        propTorque: 0.12, propSlip: 0.11, pFactor: 0.09, engineType: 'piston',
        vRef: 36, vRotate: 29, vne: 79
      }
    },

    /* =====================================================================
     * 2. 特技机 —— 中单翼单发特技机
     *    尺寸与气动按同级真机（Extra 300 / Pitts 这一级）标定
     * =================================================================== */
    {
      key: 'aerobatic',
      name: '特技机',
      tag: 'AEROBATIC · UNLIMITED CLASS',
      desc: '无限级特技机。推重比 0.45，滚转率接近 370°/s，能长时间垂直爬升。穿环计时用它最合适。',
      bench: {
        note: '同级真机参考',
        power: '300 hp 活塞 · 恒速桨',
        span: 8.0, length: 6.95, area: 10.7, mass: 950,
        vsKmh: 100, cruiseKmh: 315, vneKmh: 407, climb: 15.0, rollDegPerSec: 400
      },
      colors: { body: 0xe0392a, accent: 0xf4f6f8, accent2: 0x22304f, dark: 0x1c1f24, metal: 0xb9c0c7 },
      fuselage: { len: 6.3, rF: 0.50, rR: 0.58, z: -0.25, noseLen: 0.60, section: 1.02,
        profile: [[0, 0.47], [0.10, 0.56], [0.32, 0.58], [0.62, 0.50], [0.86, 0.34], [1, 0.20]] },
      canopy: { x: 0, y: 0.50, z: -0.60, sx: 0.42, sy: 0.40, sz: 0.95 },
      // span 3.60 × 2 + 0.40 × 2 = 8.0 m；展弦比 6.0
      wing: { chord0: 1.90, chord1: 1.05, span: 3.60, thick: 0.30, sweep: 0.06, dihedral: 0, x: 0.40, y: -0.06, z: 0.15 },
      aileron: { t0: 0.22, t1: 0.96, cf: 0.58, thickFrac: 0.44 },
      flap: { t0: 0.05, t1: 0.20, cf: 0.58, thickFrac: 0.44 },
      winglet: { h: 0.50, len: 0.50, thick: 0.08, tilt: 0.0, up: 0.14 },
      stab: { chord0: 1.30, chord0b: 0, chord1: 0.80, span: 1.85, thick: 0.22, sweep: 0.10, dihedral: 0, x: 0.12, y: 0.24, z: 2.05 },
      elevator: { t0: 0.04, t1: 0.96, cf: 0.52, thickFrac: 0.48 },
      fin: { chord0: 1.55, chord1: 0.92, span: 1.62, thick: 0.18, sweep: 0.42, x: 0, y: 0.30, z: 2.00 },
      rudder: { t0: 0.04, t1: 0.96, cf: 0.52, thickFrac: 0.52 },
      tailType: 'conv', finTwin: false,
      engine: { type: 'prop', blades: 3, propR: 1.05, bladeLen: 2.10, spinZ: -3.45 },
      gear: { type: 'tricycle', noseZ: -2.45, mainZ: -0.10, mainX: 1.05, wheelR: 0.30, legDrop: 1.18 },
      gearH: 1.52, bellyH: 0.60,
      eye: [0, 0.84, -0.20],
      physics: {
        mass: 950, wingArea: 10.7, AR: 6.0, oswald: 0.75,
        maxThrust: 4200, thrustFalloff: 250,
        pitchRateMax: 1.9, alphaMax: 0.42, alphaMin: 0.26, alphaGain: 5.0,
        gLimitPos: 10.0, gLimitNeg: -6.0,
        rollRateMax: 6.5, yawRateMax: 1.1, rateGain: 13.0,
        stabilityYaw: 1.0, dihedral: 0.20,
        propTorque: 0.28, propSlip: 0.20, pFactor: 0.15, engineType: 'piston',
        vRef: 32, vRotate: 32, vne: 113,
        CD0: 0.030
      }
    },

    /* =====================================================================
     * 3. 喷气战斗机 —— 双发双垂尾轻型战斗机
     *    尺寸与气动按同级真机（F-5E / T-38 这一级）标定
     * =================================================================== */
    {
      key: 'jet',
      name: '喷气战斗机',
      tag: 'JET FIGHTER · LIGHTWEIGHT',
      desc: '双发双垂尾轻型战斗机。推重比 0.63，海平面能飞近音速；但失速速度 258 km/h，起降必须保持大速度。',
      bench: {
        note: '同级真机参考',
        power: '2 × 加力涡喷 · 合计 44.5 kN',
        span: 8.13, length: 14.45, area: 17.28, mass: 7200,
        vsKmh: 260, maxKmh: 1700, climbSeaLevelMS: 62, gLimit: 7.3
      },
      colors: { body: 0x8d959c, accent: 0x59636d, accent2: 0xc6cbd1, dark: 0x2a2f35, metal: 0xa8b0b8 },
      // 细长机身 + 尖头：11.6 + 2.7 = 14.3 m
      fuselage: { len: 11.6, rF: 0.62, rR: 0.78, z: -0.10, noseLen: 1.90, section: 1.00,
        profile: [[0, 0.60], [0.10, 0.68], [0.34, 0.72], [0.62, 0.71], [0.86, 0.63], [1, 0.46]] },
      canopy: { x: 0, y: 0.52, z: -2.10, sx: 0.46, sy: 0.38, sz: 1.35 },
      // span 3.55 × 2 + 0.52 × 2 = 8.14 m；前缘后掠 25°
      wing: { chord0: 3.00, chord1: 0.90, span: 3.55, thick: 0.26, sweep: 0.605, dihedral: -2, x: 0.52, y: -0.16, z: 0.75 },
      aileron: { t0: 0.34, t1: 0.93, cf: 0.80, thickFrac: 0.44 },
      flap: { t0: 0.06, t1: 0.32, cf: 0.80, thickFrac: 0.44 },
      winglet: null,
      // 平尾前缘约 30°
      stab: { chord0: 1.70, chord1: 0.70, span: 1.75, thick: 0.20, sweep: 0.52, dihedral: -6, x: 0.26, y: 0.16, z: 4.60 },
      elevator: { t0: 0.05, t1: 0.95, cf: 0.68, thickFrac: 0.46 },
      // 双垂尾：翼尖整体向外倾 12°，前缘约 33°
      fin: { chord0: 2.20, chord1: 1.00, span: 1.65, thick: 0.16, sweep: 0.48, x: 0.50, y: 0.06, z: 4.20, cant: 14 },
      finTwin: true,
      rudder: { t0: 0.05, t1: 0.95, cf: 0.66, thickFrac: 0.50 },
      tailType: 'conv',
      engine: { type: 'jet', intakeR: 0.42, nozzleR: 0.38, nozZ: 5.55, nozzles: 2, nozzleX: 0.40 },
      gear: { type: 'retract', noseZ: -4.30, mainZ: 0.65, mainX: 1.30, wheelR: 0.38, legDrop: 1.32 },
      gearH: 1.72, bellyH: 0.95,
      eye: [0, 0.86, -1.55],
      physics: {
        mass: 7200, wingArea: 17.3, AR: 3.83, oswald: 0.68,
        maxThrust: 44500, thrustFalloff: 700,
        CLalpha: 4.0, CL0: 0.10, alphaStall: 0.30,
        pitchRateMax: 1.6, alphaMax: 0.40, alphaMin: 0.22, alphaGain: 4.5,
        gLimitPos: 7.3, gLimitNeg: -3.0,
        rollRateMax: 3.6, yawRateMax: 0.9, rateGain: 7.0,
        stabilityYaw: 1.5, dihedral: 0.30,
        propTorque: 0.0,  propSlip: 0.0,  pFactor: 0.0, engineType: 'jet',
        vRef: 110, vRotate: 82, vne: 340,
        CD0: 0.020,
        gearH: 1.72, bellyH: 0.95
      }
    },

    /* =====================================================================
     * 4. 滑翔机 —— 动力滑翔机（自爬升）
     *    尺寸与气动按同级真机（Stemme S10 / ASH 这一级）标定
     * =================================================================== */
    {
      key: 'glider',
      name: '滑翔机',
      tag: 'MOTOR GLIDER · SELF-LAUNCH',
      desc: '23 米翼展的动力滑翔机，滑翔比约 53:1、下沉率 0.6 m/s。收油门能长时间滞空；推力很小，爬升很慢。',
      bench: {
        note: '同级真机参考',
        power: '115 hp 活塞 · 可折叠桨',
        span: 23.0, length: 8.42, area: 11.8, mass: 850,
        vsKmh: 91, vneKmh: 245, glide: 50, sink: 0.6, climb: 2.3
      },
      colors: { body: 0xfafbfc, accent: 0x2a5fa8, accent2: 0xd94f3a, dark: 0x24282d, metal: 0xb4bcc4 },
      fuselage: { len: 7.9, rF: 0.30, rR: 0.40, z: -0.20, noseLen: 0.50, section: 1.10,
        profile: [[0, 0.28], [0.10, 0.35], [0.30, 0.38], [0.58, 0.33], [0.84, 0.22], [1, 0.11]] },
      canopy: { x: 0, y: 0.40, z: -1.85, sx: 0.34, sy: 0.34, sz: 1.55 },
      // span 11.3 × 2 + 0.30 × 2 = 23.2 m，展弦比 44.8
      wing: { chord0: 0.78, chord1: 0.34, span: 11.30, thick: 0.13, sweep: 0, dihedral: 3, x: 0.30, y: 0.10, z: -0.45 },
      aileron: { t0: 0.40, t1: 0.96, cf: 0.70, thickFrac: 0.46 },
      flap: { t0: 0.12, t1: 0.38, cf: 0.70, thickFrac: 0.46 },
      winglet: { h: 0.36, len: 0.34, thick: 0.05, tilt: 0.10, up: 0.10 },
      // T 尾：平尾坐在垂尾顶上
      stab: { chord0: 0.80, chord1: 0.44, span: 1.05, thick: 0.12, sweep: 0.10, dihedral: 0, x: 0.08, y: 1.30, z: 3.65 },
      elevator: { t0: 0.05, t1: 0.95, cf: 0.55, thickFrac: 0.50 },
      fin: { chord0: 1.10, chord1: 0.58, span: 1.15, thick: 0.12, sweep: 0.40, x: 0, y: 0.10, z: 3.25 },
      rudder: { t0: 0.05, t1: 0.95, cf: 0.58, thickFrac: 0.54 },
      tailType: 'ttail', finTwin: false,
      engine: { type: 'prop', blades: 2, propR: 0.62, bladeLen: 1.24, spinZ: -4.05 },
      gear: { type: 'taildragger', noseZ: -3.60, mainZ: 0.40, mainX: 0.0, wheelR: 0.26, legDrop: 0.82 },
      gearH: 1.10, bellyH: 0.40,
      eye: [0, 0.64, -1.45],
      physics: {
        mass: 850, wingArea: 11.8, AR: 44.8, oswald: 0.92,
        // 自爬升能力：真机资料在 2.3~4.2 m/s 之间（随气温/载重差别很大）。
        // 这里用约 4.1 m/s：机场北面 2000→3000m 那一段地形坡度接近 18%，
        // 爬升梯度低于约 12% 就会撞山。推力衰减点给得很低（82 m/s），
        // 因为折叠桨本来就是为爬升优化的，高速效率很差——这样平飞速度
        // 也能压在 Vne 以内。
        maxThrust: 2000, thrustFalloff: 82,
        CLalpha: 5.6, CL0: 0.32,
        pitchRateMax: 0.85, alphaMax: 0.30, alphaMin: 0.16, alphaGain: 3.0,
        gLimitPos: 5.3, gLimitNeg: -2.5,
        rollRateMax: 2.0, yawRateMax: 0.6, rateGain: 6.5,
        stabilityYaw: 1.3, dihedral: 0.55,
        propTorque: 0.04, propSlip: 0.05, pFactor: 0.03, engineType: 'piston',
        vRef: 26, vRotate: 24, vne: 70,
        CD0: 0.0115,
        gearH: 1.10, bellyH: 0.40
      }
    }
  ];

  var BY_KEY = {};
  for (var i = 0; i < TYPES.length; i++) BY_KEY[TYPES[i].key] = TYPES[i];
  // 兼容旧的 URL 参数（?ac=pa28 之类）
  BY_KEY.pa28 = BY_KEY.trainer;
  BY_KEY.extra300 = BY_KEY.aerobatic;
  BY_KEY.f5e = BY_KEY.jet;
  BY_KEY.s10 = BY_KEY.glider;

  function get(key) { return BY_KEY[key] || TYPES[0]; }

  /* 把机型的气动覆盖项并到一份基准参数上（供 Node 回归与 HUD 使用）。
     gearH/bellyH 必须强制取自机型顶层的几何值：它们决定飞机停在地面时
     重心离地多高，如果和模型对不上，飞机要么悬空要么陷进跑道。 */
  function physicsFor(key, base) {
    var t = get(key);
    var out = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (var j in t.physics) if (Object.prototype.hasOwnProperty.call(t.physics, j)) out[j] = t.physics[j];
    out.gearH = t.gearH;
    out.bellyH = t.bellyH;
    out.wingSpan = t.wing.span * 2 + t.wing.x * 2;
    return out;
  }

  /* 由气动参数反推：失速速度、最大平飞速度、最大爬升率、最佳滑翔比。
     base 是 physics.js 的 DEFAULTS——必须先合并，否则机型没覆盖到的项会是 undefined。 */
  function perf(t, base) {
    var p = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p[k] = base[k];
    for (var j in t.physics) if (Object.prototype.hasOwnProperty.call(t.physics, j)) p[j] = t.physics[j];
    var mass = p.mass, S = p.wingArea, AR = p.AR, osw = p.oswald, W = mass * 9.80665;
    var CLmax = p.CL0 + p.CLalpha * p.alphaStall;
    var kInd = 1 / (Math.PI * AR * osw);
    var vs = Math.sqrt(2 * W / (1.225 * S * CLmax));
    var fall = p.thrustFalloff || 185;
    function thrustAt(v) { return p.maxThrust * Math.max(0, 1 - v / fall); }
    function dragAt(v) {
      var q = 0.5 * 1.225 * v * v;
      var CL = W / (q * S);
      return q * S * (p.CD0 + kInd * CL * CL);
    }
    // 最大平飞速度：从高速往低压，找到第一个推力还够用的速度
    var vmax = vs;
    for (var v = 450; v > vs; v -= 0.25) {
      if (thrustAt(v) >= dragAt(v)) { vmax = v; break; }
    }
    // 最大爬升率 = max(单位剩余功率) / W。
    // 早先直接取 1.35×失速速度，那个速度上诱导阻力还很大，会把爬升率算低一大截。
    var climb = 0, vY = vs * 1.3;
    for (var vv = vs * 1.05; vv < vmax; vv += 0.25) {
      var ex = (thrustAt(vv) - dragAt(vv)) * vv;
      if (ex > climb * W) { climb = ex / W; vY = vv; }
    }
    // 最佳滑翔比：L/D 的最大值，在 CL = sqrt(CD0/k) 处取到
    var CLbest = Math.sqrt(p.CD0 / kInd);
    var glide = CLbest / (p.CD0 + kInd * CLbest * CLbest);
    // 对应下沉率
    var vGlide = Math.sqrt(2 * W / (1.225 * S * CLbest));
    return {
      vs: vs, vmax: vmax, climb: climb, vClimb: vY,
      glide: glide, sink: vGlide / glide, vGlide: vGlide,
      rollDegPerSec: p.rollRateMax * 180 / Math.PI
    };
  }

  return { TYPES: TYPES, get: get, physicsFor: physicsFor, perf: perf };
});
