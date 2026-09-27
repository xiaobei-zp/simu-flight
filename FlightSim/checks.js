/* =========================================================================
 * checks.js — 数值回归（Node 直接跑，不需要浏览器）
 *
 *   node checks.js
 *
 * 覆盖三块：
 *   几何  四种机型的零件装配（操纵面铰链必须精确落在母面后缘上）
 *   操纵  俯仰配平、螺旋桨效应、尾旋进入与改出、正常包线
 *   动力  密度高度（气温）、混合比、以及机型差异
 *
 * terrain.js / environment.js / physics.js / aircraft.js / aircraft-types.js
 * 都不依赖 DOM，所以这些都能脱离浏览器验证。
 * ========================================================================= */
global.THREE = require('./three.min.js');

/* canvas 桩：world.js 画水面/云/灯光贴图、aircraft.js 画座舱仪表板都要用。
   Proxy 把任何未列出的成员都当成「返回 undefined 的函数」，
   这样即使以后加了新的绘图调用也不会在这里炸掉。 */
function makeCtx() {
  const grad = { addColorStop() { } };
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'canvas') return { width: 512, height: 512 };
      if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
        k === 'createPattern') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k in t) return t[k];
      return () => { };
    },
    set: (t, k, v) => { t[k] = v; return true; }
  });
}
global.document = {
  createElement: (tag) => {
    const el = { width: 512, height: 512, style: {}, tagName: tag };
    el.getContext = () => makeCtx();
    el.appendChild = () => { };
    return el;
  },
  createElementNS: () => ({ style: {} }),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => { }
};
global.window = global;
global.Image = function () { return { addEventListener() { }, set src(v) { } }; };

/* world.js 是 UMD 的，从全局取这几个依赖，必须提前挂好 */
global.SimTerrain = require('./js/terrain.js');
global.SimEnv = require('./js/environment.js');
global.SimLandmarks = require('./js/landmarks.js');

const AT = require('./js/aircraft-types.js');
const A = require('./js/aircraft.js');
const { Terrain } = require('./js/terrain.js');
const { FlightModel, DEFAULTS } = require('./js/physics.js');
const SimWorld = require('./js/world.js');
const terrain = new Terrain({}).generate();
const DT = 1 / 240;
const cl = (v, a, b) => Math.min(b, Math.max(a, v));
const coord = m => cl(m.betaDeg * 0.035, -1, 1);
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('    ❌ ' + msg); } };

/* ===================================================================== */
console.log('══ 1. 几何：铰链必须精确落在母面后缘上 ══');

function tightBoxes(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const b = new THREE.Box3(); const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); b.expandByPoint(v); }
    out.push(b);
  });
  return out;
}
function sp(spec, pos, t, cf, mirror) {
  const c = spec.chord0 + (spec.chord1 - spec.chord0) * t;
  const s = mirror ? -1 : 1;
  return new THREE.Vector3(pos.x + s * spec.span * t,
    pos.y + Math.tan((spec.dihedral || 0) * Math.PI / 180) * spec.span * t,
    pos.z + spec.sweep * t + (cf - 0.5) * c);
}
for (const t of AT.TYPES) {
  const cfg = AT.physicsFor(t.key, DEFAULTS);
  const ac = A.build({ spec: t, simple: true });
  const boxes = tightBoxes(ac.group);
  let maxErr = 0;
  const check = (pivot, spec, pos, o, label, mirror) => {
    ok(pivot, '缺' + label);
    if (!pivot) return;
    const h = pivot.userData.hinge;
    const w0 = sp(spec, pos, o.t0, o.cf, mirror);
    const w1 = sp(spec, pos, o.t1, o.cf, mirror);
    const e = Math.max(Math.min(h[0].distanceTo(w0), h[1].distanceTo(w0)),
      Math.min(h[0].distanceTo(w1), h[1].distanceTo(w1)));
    maxErr = Math.max(maxErr, e);
  };
  const WP = { x: t.wing.x, y: t.wing.y, z: t.wing.z };
  const WPm = { x: -WP.x, y: WP.y, z: WP.z };
  check(ac.surfaces.aileronR, t.wing, WP, t.aileron, '副翼R', false);
  check(ac.surfaces.aileronL, t.wing, WPm, t.aileron, '副翼L', true);
  if (t.flap) {
    check(ac.surfaces.flapR, t.wing, WP, t.flap, '襟翼R', false);
    check(ac.surfaces.flapL, t.wing, WPm, t.flap, '襟翼L', true);
  }
  check(ac.surfaces.elevator, t.stab, { x: t.stab.x, y: t.stab.y, z: t.stab.z }, t.elevator, '升降舵R', false);
  check(ac.surfaces.elevatorL, t.stab, { x: -t.stab.x, y: t.stab.y, z: t.stab.z }, t.elevator, '升降舵L', true);
  /* 母面必须长在正确的一侧。notchedSurface 的签名是 (spec,pos,notches[],mirror)，
     曾经因为调用点还留着旧的按位置传参写法，t1 落到 mirror 上被当成 true，
     左右平尾全被镜像到左边、垂尾朝下长。铰链误差检查抓不到这种错——
     操纵面本身是好的，是它底下的母面没了。 */
  {
    const sideOf = (boxes, sign) => boxes.filter(b => {
      const c2 = (b.min.x + b.max.x) / 2;
      return sign > 0 ? c2 > 0.05 : c2 < -0.05;
    });
    // 右平尾：z 在平尾附近、|y| 小的 body 网格
    const stabBoxes = boxes.filter(b => {
      const c2 = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
      return Math.abs(c2.z - t.stab.z) < 1.6 && Math.abs(c2.x) > 0.05 &&
        Math.abs(c2.y - t.stab.y) < 0.5;
    });
    const R = sideOf(stabBoxes, 1).length, L = sideOf(stabBoxes, -1).length;
    ok(R > 0 && L > 0, '平尾左右不对称（右 ' + R + ' 块 / 左 ' + L + ' 块）');
  }

  // 垂尾必须向上长：机身坐标系里 +Y 是上
  {
    let finTop = -99, finBot = 99, finN = 0;
    ac.group.traverse(o => {
      if (!o.isMesh || o.material.color.getHex() !== t.colors.accent) return;
      const pos = o.geometry.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i); o.localToWorld(v);
        finTop = Math.max(finTop, v.y); finBot = Math.min(finBot, v.y); finN++;
      }
    });
    if (finN > 0) {
      ok(finTop > t.fin.y + t.fin.span * 0.5,
        '垂尾没有向上长（顶点最高 y=' + finTop.toFixed(2) + '，根部 y=' + t.fin.y + '）');
      ok(finBot > -0.2, '垂尾向下穿出机身（最低 y=' + finBot.toFixed(2) + '）');
    }
  }

  /* 主要部件必须真的接在机身上。垂尾、平尾、喷口这些的根部一旦离轴距离
     超过该处机身半径，就会在机身旁边的空气里飘着——镜像是看不出来的，
     包围盒也看不出来，必须拿机身半径去比。 */
  {
    const F = t.fuselage;
    const fusR = (z) => {
      const zs = F.z - F.len / 2, tt = (z - zs) / F.len, pr = F.profile;
      if (tt <= 0) return pr[0][1];
      if (tt >= 1) return pr[pr.length - 1][1];
      for (let i = 0; i < pr.length - 1; i++) {
        if (tt >= pr[i][0] && tt <= pr[i + 1][0]) {
          const k = (tt - pr[i][0]) / ((pr[i + 1][0] - pr[i][0]) || 1);
          return pr[i][1] + (pr[i + 1][1] - pr[i][1]) * k;
        }
      }
      return pr[pr.length - 1][1];
    };
    /* 机身截面在 Y 方向被 section 拉伸过，是椭圆不是圆：
       (x/r)² + (y/(r·section))² ≤ 1 才算在机身内 */
    const sec = F.section || 1;
    const attach = (label, x, y, z, r) => {
      const R = fusR(z) + (r || 0);
      const inside = R > 1e-6 ? ((x * x) / (R * R) + (y * y) / (R * sec * R * sec)) : 9;
      ok(inside <= 1.01, label + ' 悬空（离轴 ' + Math.hypot(x, y).toFixed(2) +
        '，机身半径 ' + fusR(z).toFixed(2) + '×' + sec.toFixed(2) + '）');
    };
    attach('垂尾R', t.fin.x, t.fin.y, t.fin.z, 0);
    if (t.finTwin) attach('垂尾L', -t.fin.x, t.fin.y, t.fin.z, 0);
    // T 尾的平尾是架在垂尾顶上的，不能拿机身半径去卡
    if (t.tailType !== 'ttail') attach('平尾', t.stab.x, t.stab.y, t.stab.z, 0);
    attach('主翼根', t.wing.x, t.wing.y, t.wing.z, 0);
    if (t.engine.type === 'jet') {
      attach('尾喷口', t.engine.nozzleX, 0, t.engine.nozZ, t.engine.nozzleR);
      attach('进气口', F.rF + t.engine.intakeR * 0.70, -0.10, F.z - 0.4, t.engine.intakeR);
    }
  }

  ok(ac.surfaces.rudder, '缺方向舵');
  if (t.gear.type === 'retract') ok(ac.gearDoors.length > 0, '可收放起落架缺舱门');
  if (t.engine.type === 'prop') {
    ok(ac.bladePivots.length === t.engine.blades, '桨叶数量不对');
    ok(ac.bladePivots.length > 0 && ac.bladePivots[0].parent !== ac.propeller,
      '桨叶应挂在 holder 上才能单独改变桨叶角');
  }
  if (t.finTwin) ok(ac.surfaces.rudderR, '缺右方向舵');
  if (t.engine.type === 'prop') ok(ac.propeller, '缺螺旋桨');
  if (t.engine.type === 'jet') ok(ac.jetGlowMat, '缺加力焰');
  if (t.flap) ok(t.flap.t1 <= t.aileron.t0 + 1e-6, '襟翼与副翼展向重叠');
  ok(Math.abs(ac.wingSpan - (t.wing.span + t.wing.x) * 2) < 0.01, '翼展与规格不符');
  ok(Math.abs(ac.gearH - cfg.gearH) < 1e-6, 'gearH 与物理不一致');

  // 翼面不得前掠
  const sweepLE = s => Math.atan2(s.sweep + (s.chord0 - s.chord1) / 2, s.span) * 180 / Math.PI;
  ok(sweepLE(t.wing) > -3, '主翼前掠 ' + sweepLE(t.wing).toFixed(1) + '°');
  ok(sweepLE(t.stab) > -3, '平尾前掠');
  ok(sweepLE(t.fin) > -3, '垂尾前掠');

  console.log('  ' + t.name.padEnd(6) + ' 网格 ' + String(boxes.length).padStart(3) +
    '  机长 ' + ac.length.toFixed(1) + 'm  翼展 ' + ac.wingSpan.toFixed(1) + 'm' +
    '  铰链最大误差 ' + maxErr.toExponential(1));
}

/* ===================================================================== */
console.log('');
console.log('══ 2. 操纵：配平 / 螺旋桨效应 / 尾旋 ══');

function air(key, alt) {
  const m = new FlightModel(AT.physicsFor(key, DEFAULTS));
  m.reset(0, 430, 0, terrain);
  m.pos.set(0, alt, 0); m.onGround = false;
  m.vel.set(0, 0, -55);
  m.quat.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
  m.oat = 14;
  return m;
}
function run(m, secs, fn) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    const o = Object.assign({ pitch: 0, roll: 0, yaw: 0, throttleUp: false, throttleDown: false, brakes: false }, fn(m) || {});
    m.step(DT, o, terrain);
    if (m.crashed) return false;
  }
  return true;
}

// 配平：向后配平应该让飞机稳定在更低的空速
const speeds = [];
for (const trim of [-0.15, 0, 0.15]) {
  const m = air('trainer', 1800);
  m.trim = trim;
  run(m, 40, () => ({ throttleUp: m.tas < 62, throttleDown: m.tas > 68, yaw: coord(m) }));
  speeds.push(m.tas);
}
ok(speeds[0] > speeds[1] && speeds[1] > speeds[2], '配平没有改变配平速度');
console.log('  配平 -0.15/0/+0.15 → 配平速度 ' + speeds.map(s => s.toFixed(0)).join(' / ') + ' m/s（应单调递减）');

// 螺旋桨效应：扭矩应随桨的功率增大，喷气机为零
const rolls = {};
for (const key of ['trainer', 'aerobatic', 'glider', 'jet']) {
  const m = air(key, 1800);
  m.throttleCmd = 1; m.throttle = 1;
  m.vel.set(0, 0, -Math.max(18, m.cfg.vRef * 0.5));
  run(m, 6, () => ({ throttleUp: true }));
  rolls[key] = -m.rollDeg;
}
ok(rolls.jet === 0, '喷气机不应有螺旋桨扭矩');
ok(rolls.aerobatic > rolls.trainer && rolls.trainer > rolls.glider, '扭矩大小顺序不对');
console.log('  左滚量：特技机 ' + rolls.aerobatic.toFixed(1) + '° > 教练机 ' + rolls.trainer.toFixed(1) +
  '° > 滑翔机 ' + rolls.glider.toFixed(1) + '° > 喷气机 ' + rolls.jet.toFixed(1) + '°');

// 尾旋：蹬舵拉杆应进入，推杆应改出
for (const key of ['trainer', 'aerobatic']) {
  const t = AT.get(key);
  const m = air(key, 3000);
  m.throttleCmd = 0; m.throttle = 0;
  run(m, 8, () => ({ pitch: 1.0, yaw: 1.0, throttleDown: true }));
  ok(m.spin > 0.9, t.name + ' 未能进入尾旋');
  const entered = m.spin, h0 = m.spinHdg;
  let maxVs = 0;
  run(m, 20, (mm) => { maxVs = Math.min(maxVs, mm.vs); return { pitch: 1.0, yaw: 1.0, throttleDown: true }; });
  const rate = Math.abs(m.spinHdg - h0) / 20 * 180 / Math.PI;
  let out = -1, tt = 0;
  run(m, 30, (mm) => {
    tt += DT;
    if (out < 0 && mm.spin < 0.05) out = tt;
    if (out > 0) return { pitch: 0, roll: 0, yaw: 0, throttleUp: true };
    return { pitch: -0.8, roll: 0, yaw: 0, throttleDown: true };
  });
  ok(out > 0, t.name + ' 推杆后未能改出尾旋');
  ok(rate > 40 && rate < 250, t.name + ' 自旋转速不合理 ' + rate.toFixed(0));
  console.log('  ' + t.name.padEnd(6) + ' 进入 ' + entered.toFixed(2) +
    '  自旋 ' + rate.toFixed(0) + '°/s  下降 ' + maxVs.toFixed(0) + 'm/s' +
    '  改出耗时 ' + (out > 0 ? out.toFixed(1) : '未改出') + 's');
}

// 对照：不蹬舵不应该进尾旋
{
  const m = air('trainer', 1800);
  m.throttleCmd = 0; m.throttle = 0;
  run(m, 20, () => ({ pitch: 1.0, throttleDown: true }));
  ok(m.spin < 0.05, '只拉杆就进了尾旋');
  console.log('  对照（只拉杆不蹬舵）：尾旋 ' + m.spin.toFixed(3) +
    '  迎角 ' + m.alphaDeg.toFixed(0) + '°  下降 ' + m.vs.toFixed(1) + ' m/s');
}

/* ===================================================================== */
console.log('');
console.log('══ 3. 动力：密度高度 / 混合比 / 包线 ══');

for (const [label, oat] of [['寒夜 4℃', 4], ['标准 14℃', 14], ['酷热 34℃', 34]]) {
  const cfg = AT.physicsFor('trainer', DEFAULTS);
  const p = AT.perf(AT.get('trainer'), DEFAULTS);
  const m = new FlightModel(cfg);
  m.reset(0, 430, 0, terrain);
  m.oat = oat;
  let roll = 0, maxAlt = 0;
  for (let i = 0; i < 240 * 180; i++) {
    let o;
    if (m.onGround) o = m.tas < cfg.vRotate ? { throttleUp: true } : { throttleUp: true, pitch: 0.7 };
    else {
      if (!roll) roll = Math.abs(m.pos.z - 430);
      const tv = cl((600 - m.agl) * 0.30, -8, 8);
      let pitch = cl((tv - m.vs) * 0.10, -0.65, 0.55);
      if (m.tas < p.vs * 1.30) pitch = Math.min(pitch, 0.02);
      o = { pitch: pitch, roll: cl(-m.rollDeg * 0.05, -1, 1), yaw: coord(m), throttleUp: true };
    }
    m.step(DT, o, terrain);
    if (m.crashed) break;
    maxAlt = Math.max(maxAlt, m.agl);
  }
  console.log('  ' + label.padEnd(9) + ' 密度 ' + (m.rho / 1.225 * 100).toFixed(1) + '%' +
    '  密度高度 ' + m.densityAlt.toFixed(0).padStart(5) + 'm' +
    '  滑跑 ' + roll.toFixed(0).padStart(3) + 'm  180s 后 ' + maxAlt.toFixed(0).padStart(4) + 'm');
  if (label === '寒夜 4℃') ok(m.densityAlt < 400, '冷天密度高度应偏低');
  if (label === '酷热 34℃') ok(m.densityAlt > 800, '热天密度高度应偏高');
}

for (const mix of [1.0, 0.3, 0.0]) {
  const m = air('trainer', 1500);
  m.mixture = mix; m.throttle = 1; m.throttleCmd = 1;
  run(m, 3, () => ({ pitch: 0.1, throttleUp: true }));
  console.log('  混合比 ' + (mix * 100).toFixed(0).padStart(3) + '%  最佳 ' +
    (m.bestMix * 100).toFixed(0) + '%  功率系数 ' + m.mixPower.toFixed(2) +
    '  推力 ' + m.thrustNow.toFixed(0).padStart(5) + ' N' + (m.mixPower < 0.02 ? '  ← 停车' : ''));
  if (mix === 0) ok(m.thrustNow === 0, '混合比 0 应该停车');
}
{
  const m = air('jet', 2000);
  m.mixture = 0; m.throttle = 1;
  run(m, 2, () => ({ throttleUp: true }));
  ok(m.thrustNow > 0, '喷气机不应受混合比影响');
  console.log('  喷气机在混合比 0% 下仍有推力 ' + m.thrustNow.toFixed(0) + ' N ✓');
}

console.log('');
for (const t of AT.TYPES) {
  const cfg = AT.physicsFor(t.key, DEFAULTS);
  const p = AT.perf(t, DEFAULTS);
  const m = new FlightModel(cfg);
  m.reset(0, 430, 0, terrain);
  m.oat = 14;
  let flew = false, maxAlt = 0;
  for (let i = 0; i < 240 * 200; i++) {
    let o;
    if (m.onGround) o = m.tas < cfg.vRotate ? { throttleUp: true } : { throttleUp: true, pitch: 0.7 };
    else {
      flew = true;
      maxAlt = Math.max(maxAlt, m.agl);
      const tv = cl((600 - m.agl) * 0.30, -8, 8);
      let pitch = cl((tv - m.vs) * 0.10, -0.65, 0.55);
      if (m.tas < p.vs * 1.30) pitch = Math.min(pitch, 0.02);
      o = { pitch: pitch, roll: cl(-m.rollDeg * 0.05, -1, 1), yaw: coord(m),
            throttleUp: m.tas < p.vs * 1.9, throttleDown: m.tas > p.vs * 2.1 };
    }
    m.step(DT, o, terrain);
    if (m.crashed) break;
  }
  ok(!m.crashed, t.name + ' 在包线回归中坠毁：' + m.crashReason);
  ok(flew, t.name + ' 未能离地');
  console.log('  ' + t.name.padEnd(6) + (m.crashed ? ' ❌ ' + m.crashReason : ' ✅ 爬到 ' + maxAlt.toFixed(0) + 'm') +
    '  侧滑 ' + m.betaDeg.toFixed(1) + '°  尾旋 ' + m.spin.toFixed(2));
}

/* ===================================================================== */
console.log('');
console.log('══ 4. 发动机：磁电机 / 起动机 / 变距桨 ══');

{
  const m = new FlightModel(AT.physicsFor('trainer', DEFAULTS));
  m.reset(0, 430, 0, terrain); m.oat = 14;
  m.magneto = 0;
  run(m, 3, () => ({ throttleUp: true }));
  ok(!m.engineOn && m.thrustNow === 0, '磁电机关了还在出推力');
  console.log('  磁电机关 + 满油门 → 引擎 ' + m.engineOn + '  转速 ' + m.rpm.toFixed(0) + '  推力 ' + m.thrustNow.toFixed(0));

  m.magneto = 2; m.starter = true;
  run(m, 0.8, () => ({ throttleUp: true }));
  ok(!m.engineOn, '起动机只转了 0.8 秒就点着了（应该约 1.2 秒）');
  run(m, 1.0, () => ({ throttleUp: true }));
  ok(m.engineOn, '起动机转够时间仍未点着');
  m.starter = false;
  run(m, 4, () => ({ throttleUp: true }));
  ok(m.thrustNow > 1000, '开车后推力不足');
  console.log('  起动机 1.8s → 引擎 ' + m.engineOn + '  转速 ' + m.rpm.toFixed(0) + '  推力 ' + m.thrustNow.toFixed(0));
}

{
  // 空中关磁电机 → 风车；再开车 → 恢复
  const m = air('trainer', 2000);
  m.throttle = 0.8; m.throttleCmd = 0.8;
  m.magneto = 0;
  run(m, 5, () => ({ throttleUp: true }));
  ok(!m.engineOn && m.rpm > 100 && m.thrustNow === 0, '空中停车后应风车转动但无推力');
  console.log('  空中关磁电机 → 引擎 ' + m.engineOn + '  风车转速 ' + m.rpm.toFixed(0) + '  推力 ' + m.thrustNow.toFixed(0));
  m.magneto = 2; m.starter = true;
  run(m, 3, () => ({ throttleUp: true }));
  m.starter = false;
  run(m, 2, () => ({ throttleUp: true }));
  ok(m.engineOn && m.thrustNow > 500, '空中重新开车失败');
  console.log('  重新开车 → 引擎 ' + m.engineOn + '  转速 ' + m.rpm.toFixed(0) + '  推力 ' + m.thrustNow.toFixed(0));
}

{
  // 变距桨：桨叶角应该随工况单调变化
  const samples = [];
  for (const [label, thr, v] of [['地面慢车', 0.05, 0.1], ['起飞全功率', 1.0, 30], ['巡航', 0.65, 60]]) {
    const m = air('trainer', 1000);
    m.throttle = thr; m.throttleCmd = thr;
    m.vel.set(0, 0, -v);
    run(m, 1.5, () => ({}));
    samples.push([label, m.bladePitch * 180 / Math.PI]);
  }
  ok(samples[1][1] > samples[0][1], '起飞桨叶角应大于地面慢车');
  ok(samples[1][1] > samples[2][1], '起飞桨叶角应大于巡航（恒速桨低速大功率时最粗）');
  console.log('  桨叶角 ' + samples.map(s => s[0] + ' ' + s[1].toFixed(0) + '°').join(' ｜ '));
}

{
  // 喷气机不受磁电机/混合比影响
  const m = air('jet', 2000);
  m.magneto = 0; m.mixture = 0; m.throttle = 1;
  run(m, 2, () => ({ throttleUp: true }));
  ok(m.engineOn && m.thrustNow > 0, '喷气机不该被磁电机/混合比停车');
  console.log('  喷气机（磁电机 0 + 混合比 0）→ 引擎 ' + m.engineOn + '  推力 ' + m.thrustNow.toFixed(0) + ' N');
}

/* ===================================================================== */
console.log('');
console.log('══ 5. 天气：降水强度与额外阻力 ══');

function fogOf(wx) {
  const w = SimWorld.create({ terrain: terrain, quality: 'low', hour: 12.5, noLandmarks: true });
  w.setWeather(wx);
  for (let i = 0; i < 240 * 4; i++) w.update(1 / 240, G_CAM, { x: 0, y: 0, z: 0 }, 270, 5);
  return { near: w.scene.fog.near, far: w.scene.fog.far, amt: w.weather };
}
const G_CAM = { position: { x: 0, y: 300, z: 0, copy() { }, set() { } } };
for (const wx of ['clear', 'rain', 'snow']) {
  const f = fogOf(wx);
  console.log('  ' + ({ clear: '晴', rain: '雨', snow: '雪' }[wx]).padEnd(2) +
    '  雾 near ' + f.near.toFixed(0).padStart(5) + 'm  far ' + f.far.toFixed(0).padStart(6) +
    'm  能见度 ' + (f.far / 1000).toFixed(1) + ' km');
  if (wx === 'clear') ok(f.far > 12000, '晴天能见度应大于 12 km');
  if (wx === 'rain') ok(f.far < 6000 && f.far > 2000, '雨天能见度应在 2~6 km');
  if (wx === 'snow') ok(f.far < 4500 && f.far > 1500, '雪天能见度应在 1.5~4.5 km');
}

{
  /* 降水带来额外阻力。必须在真正的平飞状态下比——
     早先直接给 pitch:0 让飞机自己加速，那是在俯冲，三种天气的速度几乎一样，
     看不出任何差别。 */
  const res = {};
  for (const [wx, precip] of [['clear', 0], ['rain', 0.6], ['snow', 0.9]]) {
    const m = air('trainer', 900);
    m.precip = precip;
    m.throttle = 1; m.throttleCmd = 1;
    // 先用升降舵把高度稳住，再取稳定后的真空速
    run(m, 120, (mm) => {
      const vsErr = 0 - mm.vs;
      return { pitch: cl(vsErr * 0.08, -0.35, 0.35), roll: cl(-mm.rollDeg * 0.06, -1, 1),
               yaw: coord(mm), throttleUp: true };
    });
    res[wx] = { tas: m.tas, cd: 0.030 + 0.0 };
  }
  ok(res.clear.tas > res.rain.tas && res.rain.tas > res.snow.tas, '降水应该降低平飞速度');
  const dRain = (1 - res.rain.tas / res.clear.tas) * 100;
  const dSnow = (1 - res.snow.tas / res.clear.tas) * 100;
  ok(dRain > 1.0, '雨的减速效果太小 ' + dRain.toFixed(1) + '%');
  ok(dSnow > dRain, '雪应该比雨更慢');
  console.log('  平飞最大速度：晴 ' + res.clear.tas.toFixed(1) + '  雨 ' + res.rain.tas.toFixed(1) +
    '（-' + dRain.toFixed(1) + '%）  雪 ' + res.snow.tas.toFixed(1) + '（-' + dSnow.toFixed(1) + '%） m/s');
}

console.log('');
console.log(fails ? '❌ ' + fails + ' 项不通过' : '✅ 全部通过');
process.exit(fails ? 1 : 0);
