/* =========================================================================
 * aircraft.js — 飞机三维模型（纯几何构建，不依赖 DOM）
 * 机体坐标系：+X = 右翼  +Y = 上  -Z = 机头方向；原点 = 重心
 * ========================================================================= */
(function (root, factory) {
  var api = factory(root.THREE);
  root.SimAircraft = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (THREE) {
  'use strict';

  /* ---------------------------------------------------------------------
   * 梯形翼面几何：从 x=0 延伸到 x=span，可镜像
   * rootChord/tipChord 为弦长，thick 为厚度
   *
   * sweep 是把「翼尖整个沿 z 平移」的量。机头朝 -Z，所以：
   *     sweep > 0  →  翼尖往后挪  →  后掠翼
   *     sweep < 0  →  翼尖往前挪  →  前掠翼
   * 注意前缘的实际后掠角还要叠加弦长收缩：
   *     tan(前缘后掠) = (sweep + (rootChord - tipChord)/2) / span
   * 所以即使 sweep 是负的，只要弦长收缩够大，前缘仍可能是后掠的
   * （教练机就是这样：sweep=-0.28 但前缘实际后掠 2.2°）。
   * 想要真正的后掠翼，sweep 必须给正值。
   * ------------------------------------------------------------------- */
  function taperedWing(rootChord, tipChord, span, thick, sweep, dihedral, mirror, thickTipFrac) {
    var c0 = rootChord, c1 = tipChord;
    var t0 = thick, t1 = thick * (thickTipFrac == null ? 0.62 : thickTipFrac);
    var s = sweep || 0;
    var dy = Math.tan((dihedral || 0) * Math.PI / 180) * span;

    var v = [
      0,   t0 / 2, -c0 / 2,
      0,   t0 / 2,  c0 / 2,
      0,  -t0 / 2,  c0 / 2,
      0,  -t0 / 2, -c0 / 2,
      span, t1 / 2 + dy, -c1 / 2 + s,
      span, t1 / 2 + dy,  c1 / 2 + s,
      span, -t1 / 2 + dy,  c1 / 2 + s,
      span, -t1 / 2 + dy, -c1 / 2 + s
    ];

    var idx = [
      0, 1, 5, 0, 5, 4,      // 上表面 (+Y)
      3, 7, 6, 3, 6, 2,      // 下表面 (-Y)
      0, 4, 7, 0, 7, 3,      // 前缘   (-Z)
      1, 2, 6, 1, 6, 5,      // 后缘   (+Z)
      0, 3, 2, 0, 2, 1,      // 翼根   (-X)
      4, 5, 6, 4, 6, 7       // 翼尖   (+X)
    ];

    if (mirror) {
      for (var i = 0; i < v.length; i += 3) v[i] = -v[i];
      // 镜像后需翻转绕序，否则法线朝内
      for (var k = 0; k < idx.length; k += 3) {
        var tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp;
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  function meshOf(geo, mat) {
    var m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  /* =====================================================================
   * 操纵面定位
   * 副翼 / 升降舵 / 方向舵都是「母面后缘上切下来的一块」，必须跟着母面的
   * 锥度、后掠和上反角走。用一个平放的盒子代替的话，翼尖那一端会飘在
   * 母面后面和下面（例如主翼后缘从根部 z=1.23 收到翼尖 z=0.47，而盒子
   * 一直停在 z≈1.13，外端就悬空 0.55m；上反角又让外端低了 0.38m）。
   * =================================================================== */

  /* 母面上的一点：t = 展向比例(0..1)，cf = 弦向比例(0=前缘 1=后缘) */
  function surfacePoint(spec, pos, t, cf, mirror) {
    var c = spec.chord0 + (spec.chord1 - spec.chord0) * t;
    var y = Math.tan((spec.dihedral || 0) * Math.PI / 180) * spec.span * t;
    var sgn = mirror ? -1 : 1;
    return {
      x: pos.x + sgn * spec.span * t,
      y: pos.y + y,
      z: pos.z + spec.sweep * t + (cf - 0.5) * c,
      c: c
    };
  }

  /* 机身：按半径剖面堆叠若干圆台，而不是一根等径圆柱。
     真飞机机身是中间粗、两头收的，等径圆柱一眼就假。
     profile = [[t, r], ...]，t 从机头 0 到机尾 1。 */
  function fusRadiusAt(FUS, z) {
    var zStart = FUS.z - FUS.len / 2;
    var tt = (z - zStart) / FUS.len;
    var pr = FUS.profile;
    if (tt <= 0) return pr[0][1];
    if (tt >= 1) return pr[pr.length - 1][1];
    for (var i = 0; i < pr.length - 1; i++) {
      if (tt >= pr[i][0] && tt <= pr[i + 1][0]) {
        var k = (tt - pr[i][0]) / (pr[i + 1][0] - pr[i][0] || 1);
        return pr[i][1] + (pr[i + 1][1] - pr[i][1]) * k;
      }
    }
    return pr[pr.length - 1][1];
  }

  function buildFuselage(FUS) {
    var zStart = FUS.z - FUS.len / 2;          // 机头端（前端）
    // 兜底：规格里漏了 profile 时按首尾半径自动生成一个收敛剖面。
    // 这类字段缺失以前会在加载阶段直接抛异常，把整个启动流程打断（白屏），
    // 代价远大于"机身形状不太对"。
    var prof = FUS.profile;
    if (!prof || !prof.length) {
      prof = [[0, FUS.rF], [0.45, FUS.rR], [1, FUS.rR * 0.42]];
    }
    var out = [];
    var stretch = FUS.section || 1.0;          // 机身截面通常略高于宽
    for (var i = 0; i < prof.length - 1; i++) {
      var t0 = prof[i][0], r0 = prof[i][1];
      var t1 = prof[i + 1][0], r1 = prof[i + 1][1];
      var dz = (t1 - t0) * FUS.len;
      if (dz < 1e-4) continue;
      var g = new THREE.CylinderGeometry(r0, r1, dz, 16, 1, false);
      g.rotateX(-Math.PI / 2);                 // +Y 端 -> -Z（朝机头）
      if (stretch !== 1) g.scale(1, stretch, 1);
      g.translate(0, 0, zStart + (t0 + t1) / 2 * FUS.len);
      out.push(g);
    }
    return out;
  }

  /* 母面上某处的厚度（与 taperedWing 的翼尖 0.62 收缩保持一致） */
  function thicknessAt(spec, t) { return spec.thick * (1 - 0.38 * t); }

  /* 把母面按展向切开，在装操纵面的那些区段把后缘让出来。
     不这么做的话，母面是个实心棱柱，操纵面会整块埋在它内部看不见
     （或者反过来飘在外面——两种都错）。
     notches = [{ t0, t1, cf }, ...]，按 t0 升序，各区段之间自动补满弦段。
     副翼和襟翼共用同一条后缘，所以必须支持多个缺口。 */
  function notchedSurface(spec, pos, notches, mirror) {
    var segs = [];
    var cur = 0;
    for (var n = 0; n < notches.length; n++) {
      var nt = notches[n];
      if (nt.t0 - cur > 1e-4) segs.push({ a: cur, b: nt.t0, cf: 1 });
      if (nt.t1 - nt.t0 > 1e-4) segs.push({ a: nt.t0, b: nt.t1, cf: nt.cf });
      cur = Math.max(cur, nt.t1);
    }
    if (1 - cur > 1e-4) segs.push({ a: cur, b: 1, cf: 1 });
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.b - s.a < 1e-4) continue;
      var leA = surfacePoint(spec, pos, s.a, 0, mirror);
      var leB = surfacePoint(spec, pos, s.b, 0, mirror);
      var teA = surfacePoint(spec, pos, s.a, s.cf, mirror);
      var teB = surfacePoint(spec, pos, s.b, s.cf, mirror);
      var span = spec.span * (s.b - s.a);
      var thA = thicknessAt(spec, s.a), thB = thicknessAt(spec, s.b);
      var g = taperedWing(teA.c * s.cf, teB.c * s.cf, span, thA,
        (teB.z + leB.z) / 2 - (teA.z + leA.z) / 2, spec.dihedral || 0, mirror, thB / thA);
      g.translate(leA.x, leA.y, (teA.z + leA.z) / 2);
      out.push(g);
    }
    return out;
  }

  /* 生成贴合母面后缘的一块操纵面，返回 { geom, p0, p1 }（均为飞机坐标系）
     o = { t0, t1, cf, thickFrac, mirror } */
  function controlSurface(spec, pos, o) {
    var mirror = !!o.mirror;
    var a = surfacePoint(spec, pos, o.t0, o.cf, mirror);   // 铰链内端
    var b = surfacePoint(spec, pos, o.t1, o.cf, mirror);   // 铰链外端
    var eA = surfacePoint(spec, pos, o.t0, 1, mirror);     // 后缘内端
    var eB = surfacePoint(spec, pos, o.t1, 1, mirror);     // 后缘外端
    var c0 = eA.c * (1 - o.cf);
    var c1 = eB.c * (1 - o.cf);
    var span = spec.span * (o.t1 - o.t0);
    var thick = spec.thick * (o.thickFrac || 0.45);
    // 根弦中心与翼尖弦中心之差，就是这块操纵面自身的后掠量
    var zRoot = eA.z - c0 / 2;
    var zTip = eB.z - c1 / 2;
    var geom = taperedWing(c0, c1, span, thick, zTip - zRoot, spec.dihedral || 0, mirror);
    geom.translate(a.x, a.y, zRoot);
    return { geom: geom, p0: new THREE.Vector3(a.x, a.y, a.z), p1: new THREE.Vector3(b.x, b.y, b.z) };
  }

  /* 把操纵面挂到绕铰链线转动的枢轴上。
     枢轴自带一个基准四元数，偏转时用 base * Δ 叠加——
     这样即使铰链线不平行于坐标轴（上反角、垂直铰链）也能精确绕铰链转。 */
  function makeHingedSurface(surf, mat) {
    var p0 = surf.p0.clone(), p1 = surf.p1.clone();
    var axis = new THREE.Vector3().subVectors(p1, p0).normalize();
    // 铰链方向统一朝 +X（镜像那一侧会反过来），左右就能用同一套符号约定
    if (axis.x < 0) { axis.negate(); var t = p0; p0 = p1; p1 = t; }
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis);
    var m = new THREE.Matrix4().compose(p0, q, new THREE.Vector3(1, 1, 1));
    surf.geom.applyMatrix4(m.clone().invert());
    var pivot = new THREE.Group();
    pivot.position.copy(p0);
    pivot.userData.base = q.clone();
    // 铰链线两端点（飞机坐标系），几何回归用它精确校验与母面后缘是否重合
    pivot.userData.hinge = [surf.p0.clone(), surf.p1.clone()];
    pivot.quaternion.copy(q);
    var mesh = new THREE.Mesh(surf.geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    return pivot;
  }

  /* =====================================================================
   * 翼尖涡流拖带
   * 一条面向相机的带子：每个采样点沿 (路径方向 × 视线方向) 展开成两个顶点。
   * 顶点透明度存在自定义属性里，用最简 shader 输出，不写深度、双面渲染。
   * =================================================================== */
  function Trail(opts) {
    opts = opts || {};
    this.max = opts.max || 64;
    this.interval = opts.interval || 0.024;
    this.life = opts.life || 1.5;      // 每个采样点的寿命（秒），到点自动消散
    this.color = new THREE.Color(opts.color == null ? 0xffffff : opts.color);
    this.pos = new Float32Array(this.max * 2 * 3);
    this.alpha = new Float32Array(this.max * 2);
    this.pts = [];
    this.acc = 0;

    var idx = [];
    for (var i = 0; i < this.max - 1; i++) {
      var a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    var geo = new THREE.BufferGeometry();
    var pa = new THREE.BufferAttribute(this.pos, 3);
    var aa = new THREE.BufferAttribute(this.alpha, 1);
    if (THREE.DynamicDrawUsage) { pa.setUsage(THREE.DynamicDrawUsage); aa.setUsage(THREE.DynamicDrawUsage); }
    geo.setAttribute('position', pa);
    geo.setAttribute('aAlpha', aa);
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);

    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color } },
      vertexShader:
        'attribute float aAlpha; varying float vA;' +
        'void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 uColor; varying float vA;' +
        'void main(){ if (vA <= 0.002) discard; gl_FragColor = vec4(uColor, vA); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  Trail.prototype.clear = function () {
    this.pts.length = 0;
    this.acc = 0;
    this.geo.setDrawRange(0, 0);
  };

  Trail.prototype.update = function (dt, camPos, tip, emit, strength) {
    if (emit) {
      this.acc += dt;
      var guard = 0;
      while (this.acc >= this.interval && guard++ < 8) {
        this.acc -= this.interval;
        this.pts.unshift({ x: tip.x, y: tip.y, z: tip.z, s: strength, age: 0 });
        if (this.pts.length > this.max) this.pts.pop();
      }
    } else {
      this.acc = 0;
    }

    /* 老化：即使不再发射，旧点也会随时间淡出并消失，
       否则尾迹会像被冻住一样挂在空中。 */
    for (var q = 0; q < this.pts.length; q++) this.pts[q].age += dt;
    while (this.pts.length && this.pts[this.pts.length - 1].age > this.life) this.pts.pop();

    var n = this.pts.length;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }

    /* 沿尾迹从头到尾传播法线：
       视线与尾迹方向接近平行时叉积会趋近于零，法线乱翻会把四边形扭成蝴蝶结
       （看起来就是一段一段的碎片）。这里对退化点沿用上一点的法线，
       并强制相邻法线同向，保证带子连续。 */
    var px = 0, py = 0, pz = 0, havePrev = false;

    for (var i = 0; i < n; i++) {
      var p = this.pts[i];
      var pf = this.pts[i > 0 ? i - 1 : 0];
      var pb = this.pts[i < n - 1 ? i + 1 : n - 1];
      var dx = pb.x - pf.x, dy = pb.y - pf.y, dz = pb.z - pf.z;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-4) { dx = 0; dy = 0; dz = -1; len = 1; }
      dx /= len; dy /= len; dz /= len;

      var vx = camPos.x - p.x, vy = camPos.y - p.y, vz = camPos.z - p.z;
      var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;

      var nx = dy * vz - dz * vy, ny = dz * vx - dx * vz, nz = dx * vy - dy * vx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);

      if (nl < 0.12 || !isFinite(nl)) {
        if (havePrev) { nx = px; ny = py; nz = pz; }
        else { nx = 0; ny = 1; nz = 0; }
      } else {
        nx /= nl; ny /= nl; nz /= nl;
        if (havePrev && (nx * px + ny * py + nz * pz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
      }
      px = nx; py = ny; pz = nz; havePrev = true;

      var t = i / (n - 1);
      var w = 0.13 + t * 0.42;                                  // 半宽：越靠后越宽
      var ageFade = 1 - Math.min(1, p.age / this.life);
      var a = Math.pow(1 - t, 1.1) * p.s * 0.52 * (0.22 + 0.78 * ageFade);
      var o = i * 6, oa = i * 2;
      this.pos[o] = p.x + nx * w; this.pos[o + 1] = p.y + ny * w; this.pos[o + 2] = p.z + nz * w;
      this.pos[o + 3] = p.x - nx * w; this.pos[o + 4] = p.y - ny * w; this.pos[o + 5] = p.z - nz * w;
      this.alpha[oa] = a; this.alpha[oa + 1] = a;
    }
    this.geo.setDrawRange(0, (n - 1) * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  };

  /* =====================================================================
   * 座舱仪表板：把仪表画进 canvas 当贴图，比建 3D 指针便宜得多，也能画得更细
   * =================================================================== */
  var PW = 640, PH = 200;

  function drawGauge(ctx, cx, cy, r, o) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    var g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#2b2f34'); g.addColorStop(1, '#0f1215');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#5a6169'; ctx.stroke();

    var a0 = o.a0 == null ? -210 : o.a0;
    var a1 = o.a1 == null ? 30 : o.a1;
    var span = (a1 - a0) * Math.PI / 180;

    var steps = o.steps || 10;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var ang = a0 * Math.PI / 180 + span * t;
      var major = (i % (o.majorEvery || 2) === 0);
      var r1 = r * 0.88, r0 = r * (major ? 0.70 : 0.79);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineWidth = major ? 2.4 : 1.2;
      ctx.strokeStyle = major ? '#e8f0f6' : '#8b949c';
      ctx.stroke();
      if (o.ticks && major) {
        var lx = cx + Math.cos(ang) * r * 0.55, ly = cy + Math.sin(ang) * r * 0.55;
        ctx.fillStyle = '#c8d4de';
        ctx.font = 'bold ' + Math.round(r * 0.22) + 'px Consolas,monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(o.ticks[Math.round(i / (o.majorEvery || 2))], lx, ly);
      }
    }

    if (o.green) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.94, a0 * Math.PI / 180 + span * o.green[0], a0 * Math.PI / 180 + span * o.green[1]);
      ctx.lineWidth = 4; ctx.strokeStyle = '#3fd07a'; ctx.stroke();
    }
    if (o.red) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.94, a0 * Math.PI / 180 + span * o.red[0], a0 * Math.PI / 180 + span * o.red[1]);
      ctx.lineWidth = 4; ctx.strokeStyle = '#e8503a'; ctx.stroke();
    }

    var v = Math.max(0, Math.min(1, o.value));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 * Math.PI / 180 + span * v);
    ctx.beginPath();
    ctx.moveTo(-r * 0.14, 0); ctx.lineTo(r * 0.86, 0);
    ctx.lineWidth = Math.max(2, r * 0.075);
    ctx.strokeStyle = o.needleColor || '#ff9b3d';
    ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = '#c9d3db'; ctx.fill();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fb0bd';
    ctx.font = 'bold ' + Math.round(r * 0.21) + 'px "Microsoft YaHei",sans-serif';
    ctx.fillText(o.label, cx, cy + r * 0.60);
    if (o.readout != null) {
      ctx.fillStyle = '#ffd08a';
      ctx.font = 'bold ' + Math.round(r * 0.30) + 'px Consolas,monospace';
      ctx.fillText(o.readout, cx, cy - r * 0.34);
    }
    ctx.restore();
  }

  function drawAttitude(ctx, cx, cy, r, pitchDeg, rollDeg) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f1215'; ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2); ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-rollDeg * Math.PI / 180);
    var ppd = r / 45;
    var oy = pitchDeg * ppd;
    ctx.fillStyle = '#2f6fc4'; ctx.fillRect(-r * 2, -r * 2 + oy, r * 4, r * 2);
    ctx.fillStyle = '#7a5a35'; ctx.fillRect(-r * 2, oy, r * 4, r * 2);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-r * 2, oy); ctx.lineTo(r * 2, oy); ctx.stroke();
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.font = Math.round(r * 0.17) + 'px Consolas,monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var d = -60; d <= 60; d += 10) {
      if (d === 0) continue;
      var y = oy - d * ppd;
      var w = (d % 20 === 0) ? r * 0.32 : r * 0.17;
      ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
      if (d % 20 === 0) ctx.fillText(String(Math.abs(d)), w + r * 0.17, y);
    }
    ctx.restore();

    ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy); ctx.lineTo(cx - r * 0.15, cy);
    ctx.moveTo(cx + r * 0.15, cy); ctx.lineTo(cx + r * 0.5, cy);
    ctx.moveTo(cx, cy - r * 0.09); ctx.lineTo(cx, cy + r * 0.09);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.84); ctx.lineTo(cx - r * 0.085, cy - r * 0.99);
    ctx.lineTo(cx + r * 0.085, cy - r * 0.99);
    ctx.closePath(); ctx.fillStyle = '#ffd54a'; ctx.fill();

    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 3; ctx.strokeStyle = '#5a6169'; ctx.stroke();
    ctx.fillStyle = '#9fb0bd';
    ctx.font = 'bold ' + Math.round(r * 0.21) + 'px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('姿态', cx, cy + r * 0.62);
    ctx.restore();
  }

  function buildInstrumentPanel() {
    var c = document.createElement('canvas');
    c.width = PW; c.height = PH;
    var tex = new THREE.CanvasTexture(c);
    var mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.88, 0.88 * PH / PW),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    );
    // 视点在 y=0.80/z=-0.35，面板放低一点、往前一点，既看得清又不会顶到画面下缘
    mesh.position.set(0, 0.50, -1.30);
    mesh.rotation.x = -0.38;
    mesh.renderOrder = 4;
    return { mesh: mesh, canvas: c, ctx: c.getContext('2d'), tex: tex };
  }

  function drawPanel(p, m) {
    var ctx = p.ctx, W = PW, H = PH;
    ctx.clearRect(0, 0, W, H);
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#242830'); g.addColorStop(1, '#14171b');
    ctx.fillStyle = g;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(2, 2, W - 4, H - 4, 12); ctx.fill(); }
    else ctx.fillRect(2, 2, W - 4, H - 4);

    var r = 56, cy = H * 0.47;
    var xs = [68, 190, 320, 450, 572];

    var iasKmh = m.ias * 3.6;
    drawGauge(ctx, xs[0], cy, r, {
      label: '空速 km/h', value: iasKmh / 220, a0: -210, a1: 30, steps: 10, majorEvery: 2,
      ticks: ['0', '44', '88', '132', '176', '220'],
      green: [0.30, 0.78], red: [0.92, 1.0],
      readout: Math.round(iasKmh)
    });

    drawAttitude(ctx, xs[1], cy, r, m.pitchDeg, m.rollDeg);

    var alt1000 = ((m.pos.y % 1000) + 1000) % 1000 / 1000;
    drawGauge(ctx, xs[2], cy, r, {
      label: '高度 m', value: alt1000, a0: -210, a1: 30, steps: 10, majorEvery: 2,
      ticks: ['0', '2', '4', '6', '8', '10'],
      readout: Math.round(m.pos.y)
    });

    drawGauge(ctx, xs[3], cy, r, {
      label: '升降 m/s', value: (Math.max(-10, Math.min(10, m.vs)) + 10) / 20,
      a0: -120, a1: 120, steps: 8, majorEvery: 2,
      ticks: ['-10', '-5', '0', '5', '10'],
      needleColor: '#6fe3ff',
      readout: (m.vs >= 0 ? '+' : '') + m.vs.toFixed(1)
    });

    drawGauge(ctx, xs[4], cy, r, {
      label: '转速 ×100', value: m.rpm / 3000, a0: -210, a1: 30, steps: 10, majorEvery: 2,
      ticks: ['0', '6', '12', '18', '24', '30'],
      green: [0.30, 0.80], red: [0.92, 1.0],
      readout: Math.round(m.rpm)
    });

    /* 罗盘带画在面板下沿 */
    var y = H - 8;
    ctx.save();
    ctx.beginPath(); ctx.rect(6, y - 30, W - 12, 28); ctx.clip();
    ctx.fillStyle = '#0b0e11'; ctx.fillRect(6, y - 30, W - 12, 28);
    ctx.strokeStyle = '#7dffa0'; ctx.lineWidth = 1.6;
    ctx.font = 'bold 15px Consolas,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var ppd = W / 130;
    for (var d = -65; d <= 65; d += 5) {
      var a = (Math.round(m.headingDeg / 5) * 5 + d + 720) % 360;
      var x = W / 2 + d * ppd;
      var major = (a % 30 === 0);
      ctx.beginPath(); ctx.moveTo(x, y - 30); ctx.lineTo(x, y - 30 + (major ? 10 : 6)); ctx.stroke();
      if (major) {
        ctx.fillStyle = a % 90 === 0 ? '#7dffa0' : '#5f7d69';
        var lbl = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a);
        ctx.fillText(lbl, x, y - 10);
      }
    }
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(W / 2, y - 30); ctx.lineTo(W / 2 - 6, y - 38); ctx.lineTo(W / 2 + 6, y - 38);
    ctx.closePath(); ctx.fillStyle = '#ffd54a'; ctx.fill();

    p.tex.needsUpdate = true;
  }


  /* ---------------------------------------------------------------------
   * build — 返回 { group, propeller, gear, surfaces, gearH, eye }
   * ------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------
   * build — 按机型规格搭模型
   * opts.spec 见 aircraft-types.js；不给就用内置的基准教练机规格，
   * 这样旧的调用方式（SimAircraft.build()）仍然可用。
   * ------------------------------------------------------------------- */
  var FALLBACK = {
    key: 'trainer', name: '教练机',
    colors: { body: 0xf3f5f7, accent: 0x1d4f96, accent2: 0xd23b2e, dark: 0x23262b, metal: 0x9aa2ab },
    fuselage: { len: 5.3, rF: 0.46, rR: 0.63, z: -0.30, noseLen: 0.46, section: 1.06,
      profile: [[0, 0.44], [0.12, 0.55], [0.34, 0.60], [0.60, 0.55], [0.84, 0.38], [1, 0.22]] },
    canopy: { x: 0, y: 0.46, z: -0.85, sx: 0.44, sy: 0.42, sz: 1.05 },
    wing: { chord0: 2.05, chord1: 1.10, span: 5.15, thick: 0.30, sweep: -0.28, dihedral: 5, x: 0.42, y: 0, z: 0.20 },
    aileron: { t0: 0.36, t1: 0.93, cf: 0.72, thickFrac: 0.42 },
    winglet: { h: 0.95, len: 0.80, thick: 0.09, tilt: 0.13, up: 0.28 },
    stab: { chord0: 1.20, chord1: 0.66, span: 2.05, thick: 0.20, sweep: 0.06, dihedral: 0, x: 0.14, y: 0.26, z: 1.95 },
    elevator: { t0: 0.06, t1: 0.94, cf: 0.62, thickFrac: 0.50 },
    fin: { chord0: 1.62, chord1: 0.86, span: 1.48, thick: 0.17, sweep: 0.32, x: 0, y: 0.42, z: 1.90 },
    rudder: { t0: 0.06, t1: 0.96, cf: 0.62, thickFrac: 0.55 },
    tailType: 'conv', finTwin: false,
    engine: { type: 'prop', blades: 3, propR: 1.28, bladeLen: 2.55, spinZ: -3.18 },
    gear: { type: 'tricycle', noseZ: -2.15, mainZ: -0.05, mainX: 1.28, wheelR: 0.34, legDrop: 1.16 },
    spareLamp: true,
    gearH: 1.50, bellyH: 0.62, eye: [0, 0.80, -0.35]
  };

  function build(opts) {
    opts = opts || {};
    var T = opts.spec || FALLBACK;
    var simple = !!opts.simple;      // AI 飞机不需要涡流拖带与座舱仪表板
    var root = new THREE.Group();
    root.name = 'aircraft';

    var C = T.colors;
    var M = {
      body:   new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.34, metalness: 0.18 }),
      accent: new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.38, metalness: 0.22 }),
      accent2:new THREE.MeshStandardMaterial({ color: C.accent2, roughness: 0.38, metalness: 0.20 }),
      dark:   new THREE.MeshStandardMaterial({ color: C.dark, roughness: 0.62, metalness: 0.42 }),
      metal:  new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.30, metalness: 0.85 }),
      glass:  new THREE.MeshStandardMaterial({
        color: 0x9ecdf2, roughness: 0.05, metalness: 0.30,
        transparent: true, opacity: 0.40, side: THREE.DoubleSide
      }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.95 })
    };

    var FUS = T.fuselage;
    var noseZ = FUS.z - FUS.len / 2;                 // 机身前端 z

    /* ---------------- 机身 ---------------- */
    buildFuselage(FUS).forEach(function (g) { root.add(meshOf(g, M.body)); });

    // 机头：螺旋桨机用整流罩，喷气机用尖锥
    var nose;
    if (T.engine.type === 'jet') {
      var coneGeo = new THREE.ConeGeometry(FUS.rF * 0.98, FUS.noseLen, 14);
      coneGeo.rotateX(-Math.PI / 2);
      nose = meshOf(coneGeo, M.body);
      nose.position.z = noseZ - FUS.noseLen / 2;
    } else {
      var noseGeo = new THREE.SphereGeometry(FUS.rF, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      noseGeo.rotateX(-Math.PI / 2);
      nose = meshOf(noseGeo, M.body);
      nose.position.z = noseZ;
    }
    root.add(nose);

    // 机身腰线与机腹条带
    var stripeLen = FUS.len * 0.66;
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var stripe = meshOf(new THREE.BoxGeometry(0.07, FUS.rR * 0.30, stripeLen), M.accent);
      stripe.position.set(sgn * (FUS.rF * 1.02), FUS.rF * 0.02, FUS.z + FUS.len * 0.06);
      root.add(stripe);
    }
    var belly = meshOf(new THREE.BoxGeometry(FUS.rF * 1.15, 0.05, stripeLen * 1.10), M.accent2);
    belly.position.set(0, -FUS.rF * 0.86 * (FUS.section || 1), FUS.z + FUS.len * 0.05);
    root.add(belly);

    /* ---------------- 座舱 ---------------- */
    var CAN = T.canopy;
    var canopyGeo = new THREE.SphereGeometry(1, 16, 12);
    canopyGeo.scale(CAN.sx, CAN.sy, CAN.sz);
    var canopy = meshOf(canopyGeo, M.glass);
    canopy.position.set(CAN.x, CAN.y, CAN.z);
    root.add(canopy);
    var canopyFrame = meshOf(new THREE.TorusGeometry(CAN.sx * 0.90, 0.035, 6, 18), M.dark);
    canopyFrame.position.set(CAN.x, CAN.y, CAN.z + CAN.sz * 0.41);
    root.add(canopyFrame);

    /* ---------------- 主翼 ---------------- */
    var WING = T.wing, AIL = T.aileron, FLP = T.flap;
    var WING_POS = { x: WING.x, y: WING.y, z: WING.z };
    var fusR = fusRadiusAt(FUS, WING.z);             // 机翼处的机身半径
    // 襟翼在副翼内侧，两者共用同一条后缘铰链线，所以要把两个缺口一起让出来
    var wingNotches = [];
    if (FLP && FLP.t1 <= AIL.t0) wingNotches.push({ t0: FLP.t0, t1: FLP.t1, cf: FLP.cf });
    wingNotches.push({ t0: AIL.t0, t1: AIL.t1, cf: AIL.cf });
    notchedSurface(WING, WING_POS, wingNotches, false).forEach(function (g) {
      root.add(meshOf(g, M.body));
    });
    notchedSurface(WING, { x: -WING_POS.x, y: WING_POS.y, z: WING_POS.z },
      wingNotches, true).forEach(function (g) {
        root.add(meshOf(g, M.body));
      });

    var tipChordZ = WING_POS.z + WING.sweep;                 // 翼尖弦中心 z
    var tipY = WING_POS.y + Math.tan(WING.dihedral * Math.PI / 180) * WING.span;
    var tipX = WING_POS.x + WING.span;

    /* 翼根整流罩：机翼与机身交接处的小鼓包。
       尺寸必须按「机身半径」定，不能按根弦——按根弦走的话，
       喷气机 3.0m 的根弦会生成一个 2.5m 宽、3.7m 长的椭球横跨整个机身。 */
    var fairR = meshOf(new THREE.SphereGeometry(1, 14, 10), M.body);
    fairR.scale.set(fusR * 0.62, WING.thick * 1.15, WING.chord0 * 0.30);
    fairR.position.set(fusR * 0.60, WING.y, WING.z + WING.chord0 * 0.05);
    root.add(fairR);
    var fairL = fairR.clone();
    fairL.position.x = -fusR * 0.60;
    root.add(fairL);

    // 翼尖小翼：骑在翼尖弦线上
    if (T.winglet) {
      var WL = T.winglet;
      for (var w = -1; w <= 1; w += 2) {
        var tip = meshOf(new THREE.BoxGeometry(WL.thick, WL.h, WL.len), M.accent2);
        tip.position.set(w * tipX, tipY + WL.up, tipChordZ);
        tip.rotation.z = -w * WL.tilt;
        root.add(tip);
      }
    }

    /* ---------------- 尾翼 ---------------- */
    // 注意 notchedSurface 的签名是 (spec, pos, notches[], mirror) —— notches 是数组。
    // 之前这里还留着旧的按位置传参写法 (…, t0, t1, cf, mirror)，
    // 结果 t1 落到了 mirror 参数上被当成 true，左右平尾全被镜像到左边，
    // 右平尾整个消失、垂尾朝下长。checks.js 里加了方向校验防止再犯。
    var STAB = T.stab, STAB_POS = { x: STAB.x, y: STAB.y, z: STAB.z }, ELEV = T.elevator;
    var elevNotch = [{ t0: ELEV.t0, t1: ELEV.t1, cf: ELEV.cf }];
    notchedSurface(STAB, STAB_POS, elevNotch, false).forEach(function (g) {
      root.add(meshOf(g, M.body));
    });
    notchedSurface(STAB, { x: -STAB_POS.x, y: STAB_POS.y, z: STAB_POS.z },
      elevNotch, true).forEach(function (g) {
        root.add(meshOf(g, M.body));
      });

    var FIN = T.fin, RUD = T.rudder;
    var finSites = T.finTwin ? [T.fin.x, -T.fin.x] : [T.fin.x];
    var finMats = [];
    var cant = (FIN.cant || 0) * Math.PI / 180;
    var rudNotch = [{ t0: RUD.t0, t1: RUD.t1, cf: RUD.cf }];
    for (var fi = 0; fi < finSites.length; fi++) {
      // 垂尾向外倾（F-5E 那种）：绕 Z 转 90° 立起来之后再多转一个 cant，
      // 方向按左右取反，否则两片会朝同一边歪
      var rotZ = Math.PI / 2 - cant * (finSites[fi] >= 0 ? 1 : -1);
      var toAc = new THREE.Matrix4()
        .makeTranslation(finSites[fi], FIN.y, FIN.z)
        .multiply(new THREE.Matrix4().makeRotationZ(rotZ));
      notchedSurface(FIN, { x: 0, y: 0, z: 0 }, rudNotch, false).forEach(function (g) {
        g.applyMatrix4(toAc);
        root.add(meshOf(g, M.accent));
      });
      finMats.push({ toAc: toAc, x: finSites[fi] });
    }

    /* ---------------- 操纵面（可动，正好填满母面让出的后缘缺口） ---------------- */
    var elevR = makeHingedSurface(controlSurface(STAB, STAB_POS,
      { t0: ELEV.t0, t1: ELEV.t1, cf: ELEV.cf, thickFrac: ELEV.thickFrac, mirror: false }), M.accent2);
    var elevL = makeHingedSurface(controlSurface(STAB, { x: -STAB_POS.x, y: STAB_POS.y, z: STAB_POS.z },
      { t0: ELEV.t0, t1: ELEV.t1, cf: ELEV.cf, thickFrac: ELEV.thickFrac, mirror: true }), M.accent2);
    root.add(elevR); root.add(elevL);

    var ailR = makeHingedSurface(controlSurface(WING, WING_POS,
      { t0: AIL.t0, t1: AIL.t1, cf: AIL.cf, thickFrac: AIL.thickFrac, mirror: false }), M.accent2);
    var ailL = makeHingedSurface(controlSurface(WING, { x: -WING_POS.x, y: WING_POS.y, z: WING_POS.z },
      { t0: AIL.t0, t1: AIL.t1, cf: AIL.cf, thickFrac: AIL.thickFrac, mirror: true }), M.accent2);
    root.add(ailR); root.add(ailL);

    // 襟翼：副翼内侧，向下偏转（不差动）。颜色用机身色，看起来像机翼的一部分
    var flapR = null, flapL = null;
    if (FLP) {
      flapR = makeHingedSurface(controlSurface(WING, WING_POS,
        { t0: FLP.t0, t1: FLP.t1, cf: FLP.cf, thickFrac: FLP.thickFrac, mirror: false }), M.body);
      flapL = makeHingedSurface(controlSurface(WING, { x: -WING_POS.x, y: WING_POS.y, z: WING_POS.z },
        { t0: FLP.t0, t1: FLP.t1, cf: FLP.cf, thickFrac: FLP.thickFrac, mirror: true }), M.body);
      root.add(flapR); root.add(flapL);
    }

    // 方向舵：双垂尾时左右各一片
    var rudders = [];
    for (var ri2 = 0; ri2 < finMats.length; ri2++) {
      var rs = controlSurface(FIN, { x: 0, y: 0, z: 0 },
        { t0: RUD.t0, t1: RUD.t1, cf: RUD.cf, thickFrac: RUD.thickFrac, mirror: false });
      rs.geom.applyMatrix4(finMats[ri2].toAc);
      rs.p0.applyMatrix4(finMats[ri2].toAc);
      rs.p1.applyMatrix4(finMats[ri2].toAc);
      var rp = makeHingedSurface(rs, M.accent2);
      root.add(rp);
      rudders.push(rp);
    }

    /* ---------------- 动力装置 ---------------- */
    var prop = null, blur = null, blurMat = null, jetGlow = null, jetGlowMat = null;
    var bladePivots = [];
    if (T.engine.type === 'prop') {
      var EN = T.engine;
      prop = new THREE.Group();
      prop.position.set(0, 0, EN.spinZ);
      var spinnerGeo = new THREE.ConeGeometry(EN.propR * 0.27, EN.propR * 0.64, 12);
      spinnerGeo.rotateX(-Math.PI / 2);          // 锥尖指向 -Z
      var spinner = meshOf(spinnerGeo, M.metal);
      spinner.position.z = -EN.propR * 0.14;
      prop.add(spinner);
      /* 变距桨：每片桨叶挂在一个只负责「绕轴分布」的 holder 上，
         桨叶自身再绕自己的长轴转 —— 这个转角就是桨叶角，可以在飞行中变。
         恒速桨低速大功率时变粗、高速巡航时变细。 */
      for (var b = 0; b < EN.blades; b++) {
        var holder = new THREE.Group();
        holder.rotation.z = b * (Math.PI * 2 / EN.blades);
        var blade = meshOf(new THREE.BoxGeometry(0.16, EN.bladeLen, 0.055), M.dark);
        blade.rotation.y = 0.22;
        holder.add(blade);
        prop.add(holder);
        bladePivots.push(blade);
      }
      var blurGeo = new THREE.CircleGeometry(EN.propR, 32);
      blurMat = new THREE.MeshBasicMaterial({
        color: 0xdfe6ee, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false
      });
      blur = new THREE.Mesh(blurGeo, blurMat);
      blur.position.set(0, 0, EN.spinZ);
      root.add(blur);
      root.add(prop);
    } else {
      // 喷气：两侧进气口 + 尾喷口（单发或双发）+ 加力焰
      var JE = T.engine;
      for (var si = -1; si <= 1; si += 2) {
        var intake = meshOf(new THREE.CylinderGeometry(JE.intakeR, JE.intakeR, 2.6, 12, 1, true), M.dark);
        intake.rotation.x = Math.PI / 2;
        intake.position.set(si * (FUS.rF + JE.intakeR * 0.70), -0.10, FUS.z - 0.4);
        root.add(intake);
      }
      var flames = [];
      var nNoz = JE.nozzles || 1;
      for (var ni = 0; ni < nNoz; ni++) {
        var nx = nNoz > 1 ? (ni === 0 ? -(JE.nozzleX || 0.6) : (JE.nozzleX || 0.6)) : 0;
        var nozzle = meshOf(new THREE.CylinderGeometry(JE.nozzleR * 0.78, JE.nozzleR, 1.5, 14, 1, true), M.metal);
        nozzle.rotation.x = Math.PI / 2;
        nozzle.position.set(nx, 0, JE.nozZ);
        root.add(nozzle);

        var flameGeo = new THREE.ConeGeometry(JE.nozzleR * 0.72, 4.2, 12, 1, true);
        flameGeo.rotateX(Math.PI / 2);             // 锥尖指向 +Z（向后喷）
        var flameMat = new THREE.MeshBasicMaterial({
          color: 0x7fc4ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false
        });
        var fm = new THREE.Mesh(flameGeo, flameMat);
        fm.position.set(nx, 0, JE.nozZ + 2.0);
        root.add(fm);
        flames.push(fm);
      }
      jetGlow = new THREE.Group();
      for (var fj = 0; fj < flames.length; fj++) jetGlow.add(flames[fj]);
      jetGlowMat = flames[0].material;             // 火焰共用同一个材质
      root.add(jetGlow);
    }

    /* ---------------- 起落架 ---------------- */
    var GE = T.gear;
    var gear = new THREE.Group();
    var wheelGeo = new THREE.CylinderGeometry(GE.wheelR, GE.wheelR, GE.wheelR * 0.58, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    var wheelY = -GE.legDrop;

    function strut(x, y0, y1, z, r) {
      var g = new THREE.CylinderGeometry(r, r, Math.abs(y1 - y0), 8);
      var m = meshOf(g, M.metal);
      m.position.set(x, (y0 + y1) / 2, z);
      return m;
    }
    function wheel(x, y, z) {
      var wm = meshOf(wheelGeo, M.rubber);
      wm.position.set(x, y, z);
      return wm;
    }
    // 前轮 / 尾轮
    gear.add(strut(0, -FUS.rR * 0.5, wheelY, GE.noseZ, 0.09));
    gear.add(wheel(0, wheelY, GE.noseZ));
    // 主轮（滑翔机是单主轮 mainX = 0）
    var mains = GE.mainX > 0.01 ? [-GE.mainX, GE.mainX] : [0];
    for (var mi = 0; mi < mains.length; mi++) {
      gear.add(strut(mains[mi], -FUS.rR * 0.45, wheelY, GE.mainZ, 0.11));
      gear.add(wheel(mains[mi], wheelY, GE.mainZ));
    }
    // 尾轮式：主轮在前、尾轮在后，用同一个 noseZ/mainZ 表达
    if (GE.type === 'taildragger') {
      gear.children.length = 0;
      gear.add(strut(0, -FUS.rR * 0.5, wheelY, GE.mainZ, 0.09));
      gear.add(wheel(0, wheelY, GE.mainZ));
      gear.add(strut(0, -FUS.rR * 0.3, wheelY + GE.wheelR * 0.4, GE.noseZ, 0.07));
      gear.add(wheel(0, wheelY + GE.wheelR * 0.4, GE.noseZ));
    }
    root.add(gear);

    /* 起落架舱门：可收放机型的轮舱盖。
       收起落架时舱门贴着机腹闭合，放起落架时向外张开。
       铰链在舱门的纵向外侧边，所以用 rotation.x 就能表达开合。 */
    var gearDoors = [];
    if (GE.type === 'retract') {
      var doorZ = GE.mainZ, doorY = -FUS.rR * 0.55, doorW = GE.wheelR * 1.5, doorL = GE.wheelR * 3.4;
      for (var di = 0; di < mains.length; di++) {
        var hinge = new THREE.Group();
        var sgnD = mains[di] < 0 ? -1 : 1;
        hinge.position.set(mains[di] + sgnD * doorW * 0.5, doorY, doorZ);
        var panel = meshOf(new THREE.BoxGeometry(doorW, 0.055, doorL), M.body);
        panel.position.set(-sgnD * doorW * 0.5, 0, 0);
        // 舱门内侧的加强筋，闭合时朝外看不见、打开时能看到
        var rib = meshOf(new THREE.BoxGeometry(doorW * 0.9, 0.06, 0.10), M.dark);
        rib.position.set(-sgnD * doorW * 0.5, -0.01, 0);
        hinge.add(panel); hinge.add(rib);
        root.add(hinge);
        gearDoors.push({ pivot: hinge, sign: sgnD });
      }
    }

    /* ---------------- 航行灯 ---------------- */
    function lamp(color, x, y, z, size) {
      var m = new THREE.Mesh(
        new THREE.SphereGeometry(size || 0.10, 8, 6),
        new THREE.MeshBasicMaterial({ color: color })
      );
      m.position.set(x, y, z);
      return m;
    }
    var navL = lamp(0xff2b2b, -(tipX + 0.03), tipY + 0.06, tipChordZ - 0.45, 0.12);
    var navR = lamp(0x2bff5a, tipX + 0.03, tipY + 0.06, tipChordZ - 0.45, 0.12);
    var strobe = lamp(0xffffff, 0, FIN.y + FIN.span + 0.12, FIN.z + FIN.sweep * 0.5, 0.14);
    var beacon = lamp(0xff3020, 0, -FUS.rR * 0.9, FUS.z + 0.9, 0.10);
    root.add(navL); root.add(navR); root.add(strobe); root.add(beacon);

    /* ---------------- 天线 / 空速管 ---------------- */
    // 空速管：机头侧面伸出一根细管，几乎所有真机都有
    var pitot = meshOf(new THREE.CylinderGeometry(0.025, 0.025, FUS.len * 0.16, 6), M.metal);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.set(FUS.rF * 0.75, -FUS.rF * 0.30, noseZ + FUS.len * 0.10);
    root.add(pitot);
    // 垂尾顶上的刀形天线
    if (FIN.span > 0.7) {
      var ant = meshOf(new THREE.BoxGeometry(0.03, 0.34, 0.22), M.dark);
      ant.position.set(FIN.x, FIN.y + FIN.span * 0.86, FIN.z + FIN.sweep * 0.86);
      root.add(ant);
    }
    // 机背天线（螺旋桨机才有，喷气机是刀形天线）
    if (T.engine.type === 'prop' && FUS.len > 4) {
      var wire = meshOf(new THREE.BoxGeometry(0.02, FUS.rF * 0.30, 0.02), M.dark);
      wire.position.set(0, FUS.rF * 0.95 * (FUS.section || 1), FUS.z + FUS.len * 0.10);
      root.add(wire);
    }

    /* ---------------- 参数 ---------------- */
    root.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    /* ---------------- 座舱仪表板（只在座舱视角显示） ---------------- */
    var panel = simple ? null : buildInstrumentPanel();
    if (panel) {
      panel.mesh.visible = false;
      root.add(panel.mesh);
    }

    return {
      group: root,
      spec: T,
      materials: M,
      panel: panel,
      propeller: prop,
      jetGlow: jetGlow,
      jetGlowMat: jetGlowMat,
      canopy: canopy,
      canopyFrame: canopyFrame,
      propBlur: blur,
      propBlurMat: blurMat,
      bladePivots: bladePivots,
      gear: gear,
      gearDoors: gearDoors,
      surfaces: {
        elevator: elevR, elevatorL: elevL,
        aileronR: ailR, aileronL: ailL,
        flapR: flapR, flapL: flapL,
        rudder: rudders[0], rudderR: rudders[1] || null
      },
      lamps: { navL: navL, navR: navR, strobe: strobe, beacon: beacon },
      // 翼尖涡流：世界坐标网格，必须直接挂到 scene 上（不能挂进 root，否则会被变换两次）
      trails: simple ? null : {
        left: new Trail({ max: 54 }),
        right: new Trail({ max: 54 })
      },
      tipL: new THREE.Vector3(-tipX, tipY + 0.04, tipChordZ + 0.4),
      tipR: new THREE.Vector3(tipX, tipY + 0.04, tipChordZ + 0.4),
      gearH: T.gearH,
      bellyH: T.bellyH,
      eye: new THREE.Vector3(T.eye[0], T.eye[1], T.eye[2]),
      wingSpan: tipX * 2,
      length: FUS.len + FUS.noseLen
    };
  }

  return {
    build: build,
    taperedWing: taperedWing,
    Trail: Trail,
    buildInstrumentPanel: buildInstrumentPanel,
    drawPanel: drawPanel,
    FALLBACK: FALLBACK
  };
});
