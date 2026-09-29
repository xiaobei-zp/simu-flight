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
   * rootChord/tipChord 为弦长，thick 为厚度，sweep 为翼尖前后掠（负=前掠）
   * ------------------------------------------------------------------- */
  function taperedWing(rootChord, tipChord, span, thick, sweep, dihedral, mirror) {
    var c0 = rootChord, c1 = tipChord;
    var t0 = thick, t1 = thick * 0.62;
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
  function build(opts) {
    opts = opts || {};
    var simple = !!opts.simple;      // AI 飞机不需要涡流拖带与座舱仪表板
    var root = new THREE.Group();
    root.name = 'aircraft';

    var M = {
      body:   new THREE.MeshStandardMaterial({ color: 0xf3f5f7, roughness: 0.34, metalness: 0.18 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x1d4f96, roughness: 0.38, metalness: 0.22 }),
      accent2:new THREE.MeshStandardMaterial({ color: 0xd23b2e, roughness: 0.38, metalness: 0.20 }),
      dark:   new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.62, metalness: 0.42 }),
      metal:  new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.30, metalness: 0.85 }),
      glass:  new THREE.MeshStandardMaterial({
        color: 0x9ecdf2, roughness: 0.05, metalness: 0.30,
        transparent: true, opacity: 0.40, side: THREE.DoubleSide
      }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.95 })
    };

    /* ---------------- 机身 ---------------- */
    var fusGeo = new THREE.CylinderGeometry(0.46, 0.63, 5.3, 16, 1, false);
    fusGeo.rotateX(-Math.PI / 2);            // 轴线对准 Z，+Y 端 -> -Z（机头）
    var fus = meshOf(fusGeo, M.body);
    fus.position.z = -0.30;
    root.add(fus);

    // 机头整流罩
    var noseGeo = new THREE.SphereGeometry(0.46, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    noseGeo.rotateX(-Math.PI / 2);
    var nose = meshOf(noseGeo, M.body);
    nose.position.z = -2.95;
    root.add(nose);

    // 机身蓝色腰线
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var stripe = meshOf(new THREE.BoxGeometry(0.07, 0.20, 3.9), M.accent);
      stripe.position.set(sgn * 0.50, 0.02, 0.15);
      root.add(stripe);
    }
    var belly = meshOf(new THREE.BoxGeometry(0.75, 0.05, 4.2), M.accent2);
    belly.position.set(0, -0.52, 0.05);
    root.add(belly);

    /* ---------------- 座舱 ---------------- */
    var canopyGeo = new THREE.SphereGeometry(1, 16, 12);
    canopyGeo.scale(0.44, 0.42, 1.05);
    var canopy = meshOf(canopyGeo, M.glass);
    canopy.position.set(0, 0.46, -0.85);
    root.add(canopy);

    var canopyFrame = meshOf(new THREE.TorusGeometry(0.40, 0.035, 6, 18), M.dark);
    canopyFrame.position.set(0, 0.46, -0.42);
    root.add(canopyFrame);

    /* ---------------- 主翼 ---------------- */
    var WING = { chord0: 2.05, chord1: 1.10, span: 5.15, thick: 0.30, sweep: -0.28, dihedral: 5 };
    var wingR = meshOf(
      taperedWing(WING.chord0, WING.chord1, WING.span, WING.thick, WING.sweep, WING.dihedral, false),
      M.body
    );
    wingR.position.set(0.42, 0.00, 0.20);
    root.add(wingR);

    var wingL = meshOf(
      taperedWing(WING.chord0, WING.chord1, WING.span, WING.thick, WING.sweep, WING.dihedral, true),
      M.body
    );
    wingL.position.set(-0.42, 0.00, 0.20);
    root.add(wingL);

    // 翼尖小翼
    for (var w = -1; w <= 1; w += 2) {
      var tip = meshOf(new THREE.BoxGeometry(0.10, 0.72, 0.85), M.accent2);
      tip.position.set(w * 5.55, 0.42, 0.42);
      tip.rotation.z = -w * 0.10;
      root.add(tip);
    }

    /* ---------------- 尾翼 ---------------- */
    var stabR = meshOf(taperedWing(1.20, 0.66, 2.05, 0.20, -0.10, 0, false), M.body);
    stabR.position.set(0.14, 0.26, 1.95);
    root.add(stabR);
    var stabL = meshOf(taperedWing(1.20, 0.66, 2.05, 0.20, -0.10, 0, true), M.body);
    stabL.position.set(-0.14, 0.26, 1.95);
    root.add(stabL);

    var finGeo = taperedWing(1.62, 0.86, 1.48, 0.17, -0.55, 0, false);
    finGeo.rotateZ(Math.PI / 2);                      // 立起来（+X -> +Y）
    var fin = meshOf(finGeo, M.accent);
    fin.position.set(0, 0.42, 1.90);
    root.add(fin);

    /* ---------------- 操纵面（可动） ---------------- */
    // 升降舵：铰链在平尾后缘
    var elevPivot = new THREE.Group();
    elevPivot.position.set(0, 0.26, 2.42);
    var elev = meshOf(new THREE.BoxGeometry(4.05, 0.11, 0.62), M.accent2);
    elev.position.z = 0.31;
    elevPivot.add(elev);
    root.add(elevPivot);

    // 副翼：铰链在主翼后缘
    function makeAileron(sign) {
      var g = new THREE.Group();
      g.position.set(sign * 2.95, 0.02, 0.92);
      var a = meshOf(new THREE.BoxGeometry(3.7, 0.11, 0.42), M.accent2);
      a.position.z = 0.21;
      g.add(a);
      root.add(g);
      return g;
    }
    var ailR = makeAileron(1), ailL = makeAileron(-1);

    // 方向舵：铰链在垂尾后缘，绕 Y 轴偏转
    var rudPivot = new THREE.Group();
    rudPivot.position.set(0, 0.95, 2.36);
    var rud = meshOf(new THREE.BoxGeometry(0.10, 0.95, 0.56), M.accent2);
    rud.position.set(0, 0.10, 0.28);
    rudPivot.add(rud);
    root.add(rudPivot);

    /* ---------------- 螺旋桨 ---------------- */
    var prop = new THREE.Group();
    prop.position.set(0, 0, -3.18);
    var spinnerGeo = new THREE.ConeGeometry(0.34, 0.82, 12);
    spinnerGeo.rotateX(-Math.PI / 2);          // 锥尖指向 -Z
    var spinner = meshOf(spinnerGeo, M.metal);
    spinner.position.z = -0.18;
    prop.add(spinner);
    for (var b = 0; b < 3; b++) {
      var blade = meshOf(new THREE.BoxGeometry(0.16, 2.55, 0.055), M.dark);
      blade.rotation.z = b * (Math.PI * 2 / 3);
      blade.rotation.y = 0.22;
      prop.add(blade);
    }
    // 高速旋转时的桨盘虚影（挂在根节点上，座舱视角隐藏实体桨叶后仍保留）
    var blurGeo = new THREE.CircleGeometry(1.32, 32);
    var blurMat = new THREE.MeshBasicMaterial({
      color: 0xdfe6ee, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false
    });
    var blur = new THREE.Mesh(blurGeo, blurMat);
    blur.position.set(0, 0, -3.18);
    root.add(blur);
    root.add(prop);

    /* ---------------- 起落架 ---------------- */
    var gear = new THREE.Group();
    var wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.20, 12);
    wheelGeo.rotateZ(Math.PI / 2);

    function strut(x, y0, y1, z, r) {
      var g = new THREE.CylinderGeometry(r, r, Math.abs(y1 - y0), 8);
      var m = meshOf(g, M.metal);
      m.position.set(x, (y0 + y1) / 2, z);
      return m;
    }
    function wheel(x, y, z) {
      var w = meshOf(wheelGeo, M.rubber);
      w.position.set(x, y, z);
      return w;
    }
    // 前起落架
    gear.add(strut(0, -0.42, -1.16, -2.15, 0.09));
    gear.add(wheel(0, -1.16, -2.15));
    // 主起落架
    for (var gs = -1; gs <= 1; gs += 2) {
      gear.add(strut(gs * 1.28, -0.38, -1.16, -0.05, 0.11));
      gear.add(wheel(gs * 1.28, -1.16, -0.05));
    }
    root.add(gear);

    /* ---------------- 航行灯 ---------------- */
    function lamp(color, x, y, z, size) {
      var m = new THREE.Mesh(
        new THREE.SphereGeometry(size || 0.10, 8, 6),
        new THREE.MeshBasicMaterial({ color: color })
      );
      m.position.set(x, y, z);
      return m;
    }
    var navL = lamp(0xff2b2b, -5.62, 0.08, 0.35, 0.12);
    var navR = lamp(0x2bff5a, 5.62, 0.08, 0.35, 0.12);
    var strobe = lamp(0xffffff, 0, 1.02, 2.60, 0.14);
    var beacon = lamp(0xff3020, 0, -0.56, 0.60, 0.10);
    root.add(navL); root.add(navR); root.add(strobe); root.add(beacon);

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
      materials: M,
      panel: panel,
      propeller: prop,
      canopy: canopy,
      canopyFrame: canopyFrame,
      propBlur: blur,
      propBlurMat: blurMat,
      gear: gear,
      surfaces: { elevator: elevPivot, aileronR: ailR, aileronL: ailL, rudder: rudPivot },
      lamps: { navL: navL, navR: navR, strobe: strobe, beacon: beacon },
      // 翼尖涡流：世界坐标网格，必须直接挂到 scene 上（不能挂进 root，否则会被变换两次）
      trails: simple ? null : {
        left: new Trail({ max: 54 }),
        right: new Trail({ max: 54 })
      },
      tipL: new THREE.Vector3(-5.52, 0.38, 0.30),
      tipR: new THREE.Vector3(5.52, 0.38, 0.30),
      gearH: 1.50,                       // 重心到轮胎底部的距离（米）
      bellyH: 0.62,                      // 收起落架时的离地间隙
      // 座舱视点：坐在机身上方、座舱罩内，视线越过机头与主翼前缘
      eye: new THREE.Vector3(0, 0.80, -0.35),
      wingSpan: 11.3,
      length: 6.8
    };
  }

  return {
    build: build,
    taperedWing: taperedWing,
    Trail: Trail,
    buildInstrumentPanel: buildInstrumentPanel,
    drawPanel: drawPanel
  };
});
