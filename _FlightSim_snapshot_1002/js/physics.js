/* =========================================================================
 * physics.js — 简化飞行动力学模型
 *
 * 设计取舍：
 *   姿态用「速率指令 + 气动稳定性」混合模型（稳定、手感可控、可调参），
 *   轨迹则由真实的升力/阻力/推力/重力积分得到，因此转弯、爬升、失速、
 *   俯冲加速等宏观行为都是物理涌现的，而不是硬编码。
 *
 * 依赖 THREE（仅用 Vector3 / Quaternion / Euler）
 * ========================================================================= */
(function (root, factory) {
  var api = factory(root.THREE);
  root.SimPhysics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (THREE) {
  'use strict';

  var G = 9.80665;
  var RHO0 = 1.225;
  var R2D = 180 / Math.PI;
  var D2R = Math.PI / 180;

  var DEFAULTS = {
    mass: 1150,             // kg
    wingArea: 16.4,         // m²
    AR: 7.2,                // 展弦比
    oswald: 0.80,
    CLalpha: 5.2,           // 升力线斜率 /rad
    CL0: 0.28,              // 零迎角升力（翼型弯度）
    alphaStall: 0.26,       // 失速迎角 rad ≈ 15°
    CD0: 0.030,
    CYbeta: 0.85,
    maxThrust: 3200,        // N
    pitchRateMax: 1.10,     // rad/s（俯仰速率上限）
    alphaMax: 0.34,         // 全拉杆对应迎角 rad ≈ 19.5°（超过失速迎角，可失速）
    alphaMin: 0.17,         // 全推杆对应负迎角 rad
    alphaGain: 3.6,         // 迎角环增益
    gLimitPos: 6.0,         // 结构过载限制
    gLimitNeg: -2.5,
    rollRateMax: 2.60,      // 149°/s（原来 3.30 太快，稍给杆就过量）
    yawRateMax: 0.75,
    stabilityYaw: 1.20,     // 风标效应（同时提供荷兰滚阻尼，不能太小）
    dihedral: 0.45,         // 上反角效应（侧滑产生滚转；太小则荷兰滚阻尼不足）
    rateGain: 9.0,          // 速率指令跟随速度
    vRef: 36,               // 操纵面全效速度
    vRotate: 26,            // 抬前轮速度
    gearH: 1.50,
    bellyH: 0.62,
    vne: 108                // 不可超越速度 m/s（仅告警）
  };

  var _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
  var _vhat = new THREE.Vector3(), _liftDir = new THREE.Vector3();
  var _vB = new THREE.Vector3(), _tmp = new THREE.Vector3(), _axis = new THREE.Vector3();
  var _vRel = new THREE.Vector3();
  var _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };

  function FlightModel(opts) {
    this.cfg = Object.assign({}, DEFAULTS, opts || {});
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3();      // 机体系角速率 x=俯仰 y=偏航 z=滚转

    this.throttleCmd = 0;
    this.throttle = 0;
    this.rpm = 0;
    this.propAngle = 0;
    this.flapCmd = 0;
    this.flaps = 0;
    this.gearCmd = true;
    this.gearPos = 1;
    this.brakes = false;

    this.ctl = { pitch: 0, roll: 0, yaw: 0 };

    /* 风与湍流（世界坐标系） */
    this.wind = new THREE.Vector3();       // 稳态风向量：风往哪个方向吹
    this.turbulence = 0;                   // 0=无湍流，1=强湍流
    this.tSim = 0;                         // 湍流用时间累积（每次 reset 归零，保证可复现）
    this.windSpeed = 0;
    this.windFromDeg = 0;
    this.gust = new THREE.Vector3();

    this.onGround = true;
    this.crashed = false;
    this.crashReason = '';
    this.stall = false;
    this.buffet = 0;

    // 派生量（HUD 读取）
    this.ias = 0; this.tas = 0; this.mach = 0; this.gs = 0; this.driftDeg = 0;
    this.alpha = 0; this.beta = 0; this.alphaDeg = 0; this.betaDeg = 0;
    this.gForce = 1; this.vs = 0; this.agl = 0; this.radarAlt = 0;
    this.headingDeg = 0; this.pitchDeg = 0; this.rollDeg = 0;
    this.overspeed = false; this.terrainWarn = false; this.outOfBounds = false;
    this.justLanded = false; this.justTookOff = false; this.landingImpact = 0;
    this.rho = RHO0;
    this.thrustNow = 0;
    this.liftNow = 0; this.dragNow = 0;

    this.reset(0, 430, 0, null);
  }

  /* ------------------------------------------------------------------ */
  FlightModel.prototype.reset = function (x, z, headingDeg, terrain) {
    var gh = terrain ? terrain.sample(x, z) : this.cfg.gearH;
    this.pos.set(x, gh + this.cfg.gearH, z);
    this.vel.set(0, 0, 0);
    this.quat.setFromEuler(new THREE.Euler(0, -(headingDeg || 0) * D2R, 0, 'YXZ'));
    this.omega.set(0, 0, 0);
    this.throttleCmd = 0; this.throttle = 0; this.rpm = 0;
    this.flapCmd = 0; this.flaps = 0;
    this.gearCmd = true; this.gearPos = 1;
    this.brakes = false;
    this.ctl.pitch = this.ctl.roll = this.ctl.yaw = 0;
    this.onGround = true;
    this.crashed = false; this.crashReason = '';
    this.stall = false; this.buffet = 0;
    this.tSim = 0;
    this.ias = 0; this.tas = 0; this.mach = 0; this.gs = 0; this.driftDeg = 0;
    this.alpha = 0; this.beta = 0; this.alphaDeg = 0; this.betaDeg = 0;
    this.gForce = 1; this.vs = 0; this.agl = 0; this.radarAlt = 0;
    this.headingDeg = 0; this.pitchDeg = 0; this.rollDeg = 0;
    this.overspeed = false; this.terrainWarn = false; this.outOfBounds = false;
    this.justLanded = false; this.justTookOff = false; this.landingImpact = 0;
    return this;
  };

  FlightModel.prototype.crash = function (reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason || '坠毁';
  };

  FlightModel.prototype.toggleFlaps = function () {
    // 0% -> 50% -> 100% -> 0%
    this.flapCmd = this.flapCmd < 0.25 ? 0.5 : (this.flapCmd < 0.75 ? 1 : 0);
  };
  FlightModel.prototype.toggleGear = function () { this.gearCmd = !this.gearCmd; };

  FlightModel.prototype.attitude = function () {
    _e.setFromQuaternion(this.quat, 'YXZ');
    return {
      pitch: _e.x * R2D,
      roll: -_e.z * R2D,
      heading: ((-_e.y * R2D) % 360 + 360) % 360
    };
  };

  /* ------------------------------------------------------------------ */
  /* 单步积分                                                            */
  /* ------------------------------------------------------------------ */
  FlightModel.prototype.step = function (dt, inp, terrain) {
    var c = this.cfg;
    this.justLanded = false;
    this.justTookOff = false;
    if (this.crashed) return;

    /* ---- 0. 操纵输入平滑 + 油门/襟翼/起落架动画 ---- */
    var k = Math.min(1, dt * 11);
    this.ctl.pitch += (clamp(inp.pitch || 0, -1, 1) - this.ctl.pitch) * k;
    this.ctl.roll += (clamp(inp.roll || 0, -1, 1) - this.ctl.roll) * k;
    this.ctl.yaw += (clamp(inp.yaw || 0, -1, 1) - this.ctl.yaw) * k;

    if (inp.throttleUp) this.throttleCmd = clamp(this.throttleCmd + dt * 0.55, 0, 1);
    if (inp.throttleDown) this.throttleCmd = clamp(this.throttleCmd - dt * 0.75, 0, 1);
    this.throttle += (this.throttleCmd - this.throttle) * Math.min(1, dt * 1.8);
    this.brakes = !!inp.brakes;

    // 起落架收放：约 3 秒
    var gearTarget = this.gearCmd ? 1 : 0;
    this.gearPos += clamp(gearTarget - this.gearPos, -dt / 3, dt / 3);
    this.gearPos = clamp(this.gearPos, 0, 1);
    // 襟翼：约 2 秒
    this.flaps += clamp(this.flapCmd - this.flaps, -dt / 2, dt / 2);

    var clearance = c.bellyH + (c.gearH - c.bellyH) * this.gearPos;
    var gh0 = terrain ? terrain.sample(this.pos.x, this.pos.z) : 0;

    /* ---- 1. 大气与气流角 ----
       气动力必须用「相对于空气」的速度，而不是相对地面的速度。
       这一条同时带来了偏流、侧风修正和湍流颠簸，不需要额外特判。 */
    var alt = Math.max(0, this.pos.y);
    var rho = RHO0 * Math.exp(-alt / 8500);
    this.rho = rho;

    this.tSim += dt;
    var wx = this.wind.x, wy = this.wind.y, wz = this.wind.z;
    if (this.turbulence > 0) {
      var ts = this.tSim, tb = this.turbulence;
      // 多个不成比例的正弦叠加：平滑、可复现、不会突然跳变
      wx += (Math.sin(ts * 0.73) + 0.62 * Math.sin(ts * 1.97 + 1.3) + 0.35 * Math.sin(ts * 3.4 + 2.6)) * tb * 3.4;
      wy += (Math.sin(ts * 1.13 + 2.1) + 0.55 * Math.sin(ts * 2.71 + 0.4)) * tb * 2.6;
      wz += (Math.sin(ts * 0.91 + 4.2) + 0.62 * Math.sin(ts * 2.33 + 2.8) + 0.35 * Math.sin(ts * 3.9 + 5.1)) * tb * 3.4;
    }
    this.gust.set(wx, wy, wz);
    _vRel.set(this.vel.x - wx, this.vel.y - wy, this.vel.z - wz);

    var V = _vRel.length();
    this.tas = V;
    this.ias = V * Math.sqrt(rho / RHO0);
    var tempK = Math.max(216.65, 288.15 - 0.0065 * alt);
    this.mach = V / Math.sqrt(1.4 * 287.05 * tempK);
    this.gs = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
    this.windSpeed = Math.sqrt(wx * wx + wz * wz);
    // 气象上的"风向"指风从哪个方向吹来
    this.windFromDeg = ((Math.atan2(-wx, wz) * R2D) % 360 + 360) % 360;

    var qbar = 0, alpha = 0, beta = 0;
    if (V > 0.8) {
      _vB.copy(_vRel).applyQuaternion(_q.copy(this.quat).invert());
      alpha = Math.atan2(-_vB.y, -_vB.z);
      beta = Math.atan2(_vB.x, -_vB.z);
      qbar = 0.5 * rho * V * V;
    }
    this.alpha = alpha; this.beta = beta;
    this.alphaDeg = alpha * R2D; this.betaDeg = beta * R2D;

    /* ---- 2. 升力 / 阻力系数（含失速与襟翼） ---- */
    var aStall = c.alphaStall + this.flaps * 0.045;
    var aa = Math.abs(alpha);
    var CL;
    var attached = c.CL0 + c.CLalpha * alpha;
    if (aa < aStall) {
      CL = attached;
    } else {
      // 失速后过渡到平板理论：升力骤降、阻力剧增
      var blend = Math.min(1, (aa - aStall) / 0.13);
      var flatPlate = 2 * Math.sin(alpha) * Math.cos(alpha);
      CL = attached * (1 - blend) + flatPlate * blend;
    }
    CL += this.flaps * 0.62;

    /* 地面效应：离地一个翼展以内，地面压制翼尖涡 ->
       升力增加、诱导阻力下降。起飞离地和着陆拉平会明显更"托得住"。 */
    var aglNow = this.pos.y - gh0 - clearance;
    var geFac = (aglNow > -3 && aglNow < 14) ? (1 - clamp(aglNow / 14, 0, 1)) : 0;
    var CLwing = CL;
    CL *= (1 + 0.30 * geFac);

    var CD = c.CD0
      + (CLwing * CLwing) / (Math.PI * c.AR * c.oswald) * (1 - 0.42 * geFac)
      + this.flaps * 0.058
      + this.gearPos * 0.020
      + Math.abs(beta) * 0.075;
    if (aa > aStall) CD += 2.0 * Math.sin(alpha) * Math.sin(alpha);

    this.stall = aa > aStall * 0.93 && V > 3;
    this.buffet = this.stall ? Math.min(1, (aa - aStall * 0.93) / 0.10 + 0.35) : 0;

    /* ---- 3. 气动力 ---- */
    var S = c.wingArea;
    var liftMag = qbar * S * CL;
    var dragMag = qbar * S * CD;
    // 侧力系数限幅：大侧滑时气流分离，不能无限线性增长
    var sideMag = -qbar * S * clamp(c.CYbeta * beta, -1.1, 1.1);

    if (V > 0.8) {
      _vhat.copy(_vRel).multiplyScalar(1 / V);
      // 升力垂直于相对气流，位于机体对称面内
      _liftDir.copy(_u.set(0, 1, 0).applyQuaternion(this.quat));
      var dotUV = _liftDir.dot(_vhat);
      _liftDir.addScaledVector(_vhat, -dotUV);
      if (_liftDir.lengthSq() < 1e-8) _liftDir.copy(_u);
      else _liftDir.normalize();
    } else {
      _vhat.set(0, 0, 0);
      _liftDir.copy(_u.set(0, 1, 0).applyQuaternion(this.quat));
    }
    _r.set(1, 0, 0).applyQuaternion(this.quat);
    _f.set(0, 0, -1).applyQuaternion(this.quat);

    this.liftNow = liftMag; this.dragNow = dragMag;

    var thrust = this.throttle * c.maxThrust * (rho / RHO0);
    this.thrustNow = thrust;

    // 气动力合力（不含重力）
    _tmp.set(0, 0, 0)
      .addScaledVector(_liftDir, liftMag)
      .addScaledVector(_vhat, -dragMag)
      .addScaledVector(_r, sideMag);
    var aeroForce = _tmp.clone();
    _tmp.addScaledVector(_f, thrust);

    this.gForce = aeroForce.dot(_u) / (c.mass * G);
    if (this.onGround) this.gForce = Math.max(this.gForce, 1);

    /* ---- 4. 姿态 ----
       俯仰 = 迎角指令（杆位对应迎角，与真实飞机一致）；
       滚转/偏航 = 速率指令 + 气动稳定性（风标效应 / 上反角效应）。 */
    var speedAuth = clamp((V - 4) / (c.vRef - 4), 0, 1);
    var auth = speedAuth * (this.stall ? 0.55 : 1);

    var alphaTarget = this.ctl.pitch * (this.ctl.pitch > 0 ? c.alphaMax : c.alphaMin);
    // 过载限制器：高速时限制可用迎角，避免全拉杆瞬间拉出十几 G
    if (qbar > 1 && Math.abs(this.ctl.pitch) > 0.02) {
      var nLim = this.ctl.pitch > 0 ? c.gLimitPos : c.gLimitNeg;
      var clLim = nLim * c.mass * G / (qbar * c.wingArea);
      var aLim = (clLim - c.CL0) / c.CLalpha;
      if (this.ctl.pitch > 0) alphaTarget = Math.min(alphaTarget, aLim);
      else alphaTarget = Math.max(alphaTarget, aLim);
    }
    var pitchRate = clamp((alphaTarget - alpha) * c.alphaGain, -c.pitchRateMax, c.pitchRateMax);
    // 失速后的低头力矩：无法维持过大迎角，自然进入抖振下坠
    if (aa > aStall) pitchRate -= (alpha >= 0 ? 1 : -1) * (aa - aStall) * 5.0;

    var rollCmd = -this.ctl.roll * c.rollRateMax + beta * c.dihedral * speedAuth;
    var yawCmd = -this.ctl.yaw * c.yawRateMax - beta * c.stabilityYaw * speedAuth;

    var kk = Math.min(1, dt * c.rateGain);
    this.omega.x += (pitchRate * auth - this.omega.x) * kk;
    this.omega.y += (yawCmd * auth - this.omega.y) * kk;
    this.omega.z += (rollCmd * auth - this.omega.z) * kk;

    // 失速抖振：随机机翼下坠
    if (this.stall && !this.onGround) {
      this.omega.z += (Math.random() - 0.5) * 1.6 * dt * 60 * 0.05;
    }

    // 机体系角速率 -> 世界系四元数积分
    var w = this.omega.length();
    if (w > 1e-7) {
      _q.setFromAxisAngle(_axis.copy(this.omega).multiplyScalar(1 / w), w * dt);
      this.quat.multiply(_q).normalize();
    }

    /* ---- 5. 线运动积分 ---- */
    _tmp.y -= c.mass * G;                                 // 加上重力
    this.vel.addScaledVector(_tmp, dt / c.mass);
    this.pos.addScaledVector(this.vel, dt);

    /* ---- 6. 地面 / 水面接触 ---- */
    var wasAir = !this.onGround;
    var gh = terrain ? terrain.sample(this.pos.x, this.pos.z) : 0;
    var contact = this.pos.y - clearance <= gh;

    // 海面：地形低于海平面且机体触水
    if (gh <= 0.5 && this.pos.y <= 0.9) {
      this.crash('坠海');
      return;
    }

    if (contact) {
      var att = this.attitude();
      if (wasAir) {
        this.landingImpact = Math.max(0, -this.vel.y);
        if (this.gearPos < 0.9) this.crash('起落架未放下');
        else if (this.vel.y < -6.5) this.crash('下降率过大（' + (-this.vel.y).toFixed(1) + ' m/s）');
        else if (Math.abs(att.roll) > 22) this.crash('接地时机翼倾斜 ' + att.roll.toFixed(0) + '°');
        else if (att.pitch < -7) this.crash('接地时机头过低');
        else if (att.pitch > 22) this.crash('接地时机头过高');
        if (this.crashed) return;
        // 只有真正带下降率接地才算一次着陆，避免贴地滑跑时反复触发
        this.justLanded = this.landingImpact > 0.35;
        this.onGround = true;
      }

      this.pos.y = gh + clearance;
      if (this.vel.y < 0) this.vel.y = 0;

      /* 水平面内的正交分解。
         注意：必须把机体轴投影到 XZ 平面并重新归一化，
         否则用三维机体系分解会让水平速度每帧损失 cos²θ（俯仰角越大掉得越快）。 */
      var fl = Math.sqrt(_f.x * _f.x + _f.z * _f.z);
      if (fl > 0.12) {
        var fhx = _f.x / fl, fhz = _f.z / fl;      // 机头在水平面的投影
        var rhx = -fhz, rhz = fhx;                 // 水平面内的右向
        var gvx = this.vel.x, gvz = this.vel.z;
        var vF = gvx * fhx + gvz * fhz;            // 纵向分量
        var vR = gvx * rhx + gvz * rhz;            // 侧向分量

        var gs = Math.abs(vF);

        // 轮胎侧向抓地
        vR *= Math.max(0, 1 - dt * 8);

        // 滚阻 / 刹车
        var mu = this.brakes ? 0.62 : 0.035;
        var dec = mu * G * dt;
        var sgn = vF >= 0 ? 1 : -1;
        vF -= sgn * Math.min(gs, dec);

        this.vel.x = fhx * vF + rhx * vR;
        this.vel.z = fhz * vF + rhz * vR;
        if (this.vel.y < 0) this.vel.y = 0;

        // 前轮转向
        var steerAuth = clamp(0.10 + gs / 9, 0, 1);
        this.omega.set(0, -this.ctl.yaw * 0.95 * steerAuth, 0);

        // 地面姿态：滚转回中，抬前轮由杆位控制
        var pitchTarget = this.ctl.pitch * 0.26 * clamp((gs - 14) / 10, 0, 1);
        _q2.setFromEuler(_e.set(pitchTarget, -att.heading * D2R, 0, 'YXZ'));
        this.quat.slerp(_q2, Math.min(1, dt * 6));
        this.quat.normalize();
      }
    } else {
      if (this.onGround && this.vel.y > 0.6) {
        this.onGround = false;
        this.justTookOff = true;
      } else if (this.onGround) {
        this.onGround = false;
      }
    }

    /* ---- 7. 派生量 ---- */
    var a2 = this.attitude();
    this.pitchDeg = a2.pitch;
    this.rollDeg = a2.roll;
    this.headingDeg = a2.heading;
    this.vs = this.vel.y;
    this.agl = this.pos.y - gh;
    this.radarAlt = Math.max(0, this.agl - clearance);
    // 偏流角：机头指向与地面航迹之差，正值表示航迹偏向机头右侧
    if (this.gs > 3) {
      var trk = Math.atan2(this.vel.x, -this.vel.z) * R2D;
      this.driftDeg = ((trk - this.headingDeg + 540) % 360) - 180;
    } else {
      this.driftDeg = 0;
    }
    this.overspeed = this.ias > c.vne;
    this.terrainWarn = !this.onGround && this.radarAlt < 90 && this.vel.y < -4 &&
      this.rollDeg > -75 && this.rollDeg < 75;
    this.outOfBounds = terrain ? !terrain.inBounds(this.pos.x, this.pos.z) : false;

    // 螺旋桨
    var rpmTarget = 800 + this.throttle * 2000;
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * 2.2);
    this.propAngle += (this.rpm / 60) * Math.PI * 2 * dt;
    if (this.propAngle > Math.PI * 2) this.propAngle -= Math.PI * 2;

    return this;
  };

  /* 供 HUD 使用的快照 */
  FlightModel.prototype.snapshot = function () {
    return {
      ias: this.ias, tas: this.tas, mach: this.mach,
      alphaDeg: this.alphaDeg, betaDeg: this.betaDeg,
      gForce: this.gForce, vs: this.vs, radarAlt: this.radarAlt, agl: this.agl,
      headingDeg: this.headingDeg, pitchDeg: this.pitchDeg, rollDeg: this.rollDeg,
      throttle: this.throttle, rpm: this.rpm,
      flaps: this.flaps, gearPos: this.gearPos,
      onGround: this.onGround, stall: this.stall,
      overspeed: this.overspeed, terrainWarn: this.terrainWarn,
      outOfBounds: this.outOfBounds, crashed: this.crashed,
      crashReason: this.crashReason
    };
  };

  return { FlightModel: FlightModel, DEFAULTS: DEFAULTS, G: G };
});
