/* =========================================================================
 * world.js — 场景构建：天空 / 地形 / 海洋 / 机场 / 树木 / 城镇 / 云 / 昼夜 / 地标
 * 依赖 THREE、SimTerrain、SimEnv 与 SimLandmarks
 * ========================================================================= */
(function (root, factory) {
  var api = factory(root.THREE, root.SimTerrain, root.SimEnv, root.SimLandmarks);
  root.SimWorld = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (THREE, SimTerrain, SimEnv, SimLandmarks) {
  'use strict';

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var smoothstep = SimTerrain.smoothstep;

  /* 可复现随机数 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* 默认太阳方向（清晨/上午，西北偏西），运行时由 SimEnv 按时刻覆盖 */
  var SUN_DIR = new THREE.Vector3(-0.56, 0.50, -0.66).normalize();

  /* 柔和径向光斑贴图：星空 / 灯具辉光 / 城市灯火都用它 */
  function makeGlowTexture() {
    var S = 64;
    var c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    var rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    rg.addColorStop(0.55, 'rgba(255,255,255,0.20)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  var glowTex = null;
  function getGlowTex() { if (!glowTex) glowTex = makeGlowTexture(); return glowTex; }

  /* 星空：天球上半球均匀撒点，靠地平线以下的部分自然被地形挡住 */
  function makeStars() {
    var N = 1400, R = 11500;
    var rnd = mulberry32(20250913);
    var pos = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var el = Math.asin(rnd());          // 0..90°，半球内均匀
      var th = rnd() * Math.PI * 2;
      pos[i * 3] = R * Math.cos(el) * Math.cos(th);
      pos[i * 3 + 1] = R * Math.sin(el) + 120;
      pos[i * 3 + 2] = R * Math.cos(el) * Math.sin(th);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var mat = new THREE.PointsMaterial({
      map: getGlowTex(), color: 0xffffff, size: 95, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -950;
    return pts;
  }

  var QUALITY = {
    low:    { trees: 900,  clouds: 110, shadowMap: 1024, antialias: false, px: 1.0 },
    medium: { trees: 2200, clouds: 220, shadowMap: 2048, antialias: true,  px: 1.0 },
    high:   { trees: 3600, clouds: 340, shadowMap: 2048, antialias: true,  px: 1.0 }
  };

  /* =======================================================================
   * 天空穹顶（渐变 + 太阳光晕 + 月面）
   * ===================================================================== */
  function makeSky() {
    var geo = new THREE.SphereGeometry(14000, 32, 20);
    var mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor:    { value: new THREE.Color(0x2b6cc4) },
        midColor:    { value: new THREE.Color(0x8fb8e0) },
        bottomColor: { value: new THREE.Color(0xc3d6e4) },
        sunDir:      { value: SUN_DIR.clone() },
        sunColor:    { value: new THREE.Color(0xfff0cf) },
        moonDir:     { value: new THREE.Vector3(0, -1, 0) },
        moonColor:   { value: new THREE.Color(0xdfe6f2) },
        moonAmount:  { value: 0.0 }
      },
      vertexShader: [
        'varying vec3 vWorld;',
        'void main() {',
        '  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor, midColor, bottomColor, sunColor, sunDir;',
        'uniform vec3 moonColor, moonDir;',
        'uniform float moonAmount;',
        'varying vec3 vWorld;',
        'void main() {',
        '  vec3 d = normalize(vWorld - cameraPosition);',
        '  float h = clamp(d.y, -1.0, 1.0);',
        '  vec3 col = mix(midColor, topColor, pow(clamp(h, 0.0, 1.0), 0.62));',
        '  col = mix(col, bottomColor, smoothstep(0.16, -0.10, h));',
        '  float sd = max(dot(d, normalize(sunDir)), 0.0);',
        '  col += sunColor * pow(sd, 900.0) * 2.2;',      // 太阳本体
        '  col += sunColor * pow(sd, 8.0) * 0.18;',       // 大气辉光
        // 月面：指数比太阳略大 -> 视直径略小；再加一圈很淡的月晕
        '  float md = max(dot(d, normalize(moonDir)), 0.0);',
        '  col += moonColor * pow(md, 1500.0) * 2.6 * moonAmount;',
        '  col += moonColor * pow(md, 90.0) * 0.10 * moonAmount;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
  }

  /* =======================================================================
   * 程序化贴图
   * ===================================================================== */
  function canvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* 跑道贴图：canvas 顶端 = v=1 = 世界 -Z（北端） */
  function makeRunwayTexture() {
    var W = 256, H = 2048;
    var c = canvas(W, H), g = c.getContext('2d');
    var rnd = mulberry32(7);

    g.fillStyle = '#2b2d30'; g.fillRect(0, 0, W, H);
    // 沥青颗粒
    for (var i = 0; i < 26000; i++) {
      var v = 30 + rnd() * 40 | 0;
      g.fillStyle = 'rgba(' + v + ',' + v + ',' + (v + 3) + ',' + (0.25 + rnd() * 0.5).toFixed(2) + ')';
      g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2.4, 1 + rnd() * 2.4);
    }
    // 轮迹（深色带）
    var grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0.00, 'rgba(0,0,0,0)');
    grad.addColorStop(0.30, 'rgba(0,0,0,0.22)');
    grad.addColorStop(0.50, 'rgba(0,0,0,0.05)');
    grad.addColorStop(0.70, 'rgba(0,0,0,0.22)');
    grad.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);

    g.fillStyle = '#e9e9e6';
    // 边线
    g.fillRect(8, 0, 5, H);
    g.fillRect(W - 13, 0, 5, H);
    // 中线虚线（避开两端 12%）
    for (var y = H * 0.13; y < H * 0.87; y += 74) {
      g.fillRect(W / 2 - 3, y, 6, 40);
    }
    // 接地带标记
    function touchdown(y) {
      g.fillRect(W * 0.28, y, 8, 110);
      g.fillRect(W * 0.66, y, 8, 110);
    }
    // 入口条纹（8 条）
    function stripes(y0, dir) {
      for (var k = 0; k < 8; k++) {
        var x = W * 0.10 + k * (W * 0.80 / 8);
        g.fillRect(x, y0, W * 0.80 / 8 - 7, 165 * dir);
      }
    }
    stripes(H * 0.012, 1);
    stripes(H * 0.988 - 165, 1);
    touchdown(H * 0.075);
    touchdown(H * 0.925 - 110);

    // 跑道号 36（北端）/ 18（南端）
    g.save();
    g.fillStyle = '#e9e9e6';
    g.font = 'bold 96px "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('36', W / 2, H * 0.052);
    g.translate(W / 2, H * 0.948);
    g.rotate(Math.PI);
    g.fillText('18', 0, 0);
    g.restore();

    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  /* 云朵贴图 */
  function makeCloudTexture() {
    var S = 128;
    var c = canvas(S, S), g = c.getContext('2d');
    var rnd = mulberry32(31);
    g.clearRect(0, 0, S, S);
    for (var i = 0; i < 16; i++) {
      var cx = S * (0.18 + rnd() * 0.64);
      var cy = S * (0.30 + rnd() * 0.40);
      var r = S * (0.10 + rnd() * 0.20);
      var rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, 'rgba(255,255,255,0.95)');
      rg.addColorStop(0.55, 'rgba(250,252,255,0.55)');
      rg.addColorStop(1, 'rgba(240,246,255,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    }
    // 边缘淡出
    var fade = g.createRadialGradient(S / 2, S / 2, S * 0.25, S / 2, S / 2, S * 0.5);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';

    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  /* 海面波纹 */
  function makeWaterTexture() {
    var S = 256;
    var c = canvas(S, S), g = c.getContext('2d');
    var rnd = mulberry32(97);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
    for (var i = 0; i < 900; i++) {
      var x = rnd() * S, y = rnd() * S;
      var r = 6 + rnd() * 26;
      var rg = g.createRadialGradient(x, y, 0, x, y, r);
      var dark = rnd() > 0.5;
      rg.addColorStop(0, dark ? 'rgba(120,150,170,0.30)' : 'rgba(255,255,255,0.35)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(180, 180);
    return tex;
  }

  /* 混凝土停机坪 */
  function makeApronTexture() {
    var S = 256;
    var c = canvas(S, S), g = c.getContext('2d');
    var rnd = mulberry32(55);
    g.fillStyle = '#6e6f70'; g.fillRect(0, 0, S, S);
    for (var i = 0; i < 9000; i++) {
      var v = 90 + rnd() * 50 | 0;
      g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.4)';
      g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    g.strokeStyle = 'rgba(240,240,230,0.55)'; g.lineWidth = 2;
    for (var k = 0; k <= 4; k++) {
      g.beginPath(); g.moveTo(0, k * S / 4); g.lineTo(S, k * S / 4); g.stroke();
      g.beginPath(); g.moveTo(k * S / 4, 0); g.lineTo(k * S / 4, S); g.stroke();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 5);
    return tex;
  }

  /* =======================================================================
   * 地形网格
   * ===================================================================== */
  function buildTerrainMesh(terrain) {
    var n = terrain.n, seg = terrain.seg, cell = terrain.cell, half = terrain.half;
    var count = n * n;
    var pos = new Float32Array(count * 3);
    var idx = new Uint32Array(seg * seg * 6);
    var i, ix, iz, p = 0;
    for (iz = 0; iz < n; iz++) {
      var z = -half + iz * cell;
      for (ix = 0; ix < n; ix++) {
        pos[p++] = -half + ix * cell;
        pos[p++] = terrain.heights[iz * n + ix];
        pos[p++] = z;
      }
    }
    var q = 0;
    for (iz = 0; iz < seg; iz++) {
      for (ix = 0; ix < seg; ix++) {
        var a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(terrain.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.94, metalness: 0.0, flatShading: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  /* =======================================================================
   * 机场
   * ===================================================================== */
  function buildAirfield(scene, terrain, flatY) {
    var group = new THREE.Group();
    group.name = 'airfield';

    var RUNWAY_LEN = 1100, RUNWAY_W = 46;

    // 跑道
    var rwGeo = new THREE.PlaneGeometry(RUNWAY_W, RUNWAY_LEN, 1, 1);
    rwGeo.rotateX(-Math.PI / 2);
    var rwMat = new THREE.MeshStandardMaterial({
      map: makeRunwayTexture(), roughness: 0.92, metalness: 0.0
    });
    var runway = new THREE.Mesh(rwGeo, rwMat);
    runway.position.set(0, flatY + 0.08, 0);
    runway.receiveShadow = true;
    group.add(runway);

    // 停机坪
    var apronGeo = new THREE.PlaneGeometry(240, 180);
    apronGeo.rotateX(-Math.PI / 2);
    var apron = new THREE.Mesh(apronGeo, new THREE.MeshStandardMaterial({
      map: makeApronTexture(), roughness: 0.95
    }));
    apron.position.set(175, flatY + 0.07, -60);
    apron.receiveShadow = true;
    group.add(apron);

    // 滑行道
    var twGeo = new THREE.PlaneGeometry(80, 14);
    twGeo.rotateX(-Math.PI / 2);
    var tw = new THREE.Mesh(twGeo, new THREE.MeshStandardMaterial({ color: 0x5c5d5e, roughness: 0.95 }));
    tw.position.set(80, flatY + 0.06, -20);
    group.add(tw);

    // 机库
    var hangarMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.62, metalness: 0.35 });
    var roofMat = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.5, metalness: 0.5 });
    for (var i = 0; i < 3; i++) {
      var hx = 150, hz = -120 + i * 70;
      var body = new THREE.Mesh(new THREE.BoxGeometry(46, 12, 34), hangarMat);
      body.position.set(hx, flatY + 6, hz);
      body.castShadow = true; body.receiveShadow = true;
      group.add(body);
      var roof = new THREE.Mesh(
        new THREE.CylinderGeometry(17.5, 17.5, 46, 18, 1, false, 0, Math.PI),
        roofMat
      );
      roof.rotation.z = Math.PI / 2;
      roof.rotation.y = Math.PI / 2;
      roof.position.set(hx, flatY + 12, hz);
      roof.castShadow = true;
      group.add(roof);
    }

    // 塔台
    var towerMat = new THREE.MeshStandardMaterial({ color: 0xd8d5cd, roughness: 0.7 });
    var glassMat = new THREE.MeshStandardMaterial({
      color: 0x2a3b48, roughness: 0.15, metalness: 0.85,
      transparent: true, opacity: 0.85
    });
    var tBase = new THREE.Mesh(new THREE.CylinderGeometry(5, 7, 26, 12), towerMat);
    tBase.position.set(250, flatY + 13, 120);
    tBase.castShadow = true; group.add(tBase);
    var tCab = new THREE.Mesh(new THREE.CylinderGeometry(9, 8, 8, 12), glassMat);
    tCab.position.set(250, flatY + 30, 120);
    tCab.castShadow = true; group.add(tCab);
    var tRoof = new THREE.Mesh(new THREE.CylinderGeometry(9.6, 9.6, 1.4, 12), roofMat);
    tRoof.position.set(250, flatY + 34.7, 120);
    group.add(tRoof);

    // 跑道灯（两端 + 边灯）
    var lightGeo = new THREE.SphereGeometry(0.38, 6, 5);
    var whiteMat = new THREE.MeshBasicMaterial({ color: 0xfff4d0 });
    var greenMat = new THREE.MeshBasicMaterial({ color: 0x35ff70 });
    var redMat = new THREE.MeshBasicMaterial({ color: 0xff4030 });
    var lampCount = 2 * 22;
    var lamps = new THREE.InstancedMesh(lightGeo, whiteMat, lampCount);
    var dummy = new THREE.Object3D();
    var li = 0;
    var glowPos = [];
    for (var s = -1; s <= 1; s += 2) {
      for (var k = 0; k < 22; k++) {
        var lx = s * (RUNWAY_W / 2 + 2);
        var lz = -RUNWAY_LEN / 2 + 25 + k * ((RUNWAY_LEN - 50) / 21);
        dummy.position.set(lx, flatY + 0.6, lz);
        dummy.updateMatrix();
        lamps.setMatrixAt(li++, dummy.matrix);
        glowPos.push(lx, flatY + 0.6, lz);
      }
    }
    lamps.count = li;
    group.add(lamps);

    // 进近灯（南北各 4 个绿色）
    for (var e = 0; e < 2; e++) {
      var zEnd = e === 0 ? -RUNWAY_LEN / 2 - 30 : RUNWAY_LEN / 2 + 30;
      for (var m = 0; m < 4; m++) {
        var lz2 = zEnd + (e === 0 ? -m * 32 : m * 32);
        var lamp = new THREE.Mesh(lightGeo, greenMat);
        lamp.position.set(0, flatY + 0.7, lz2);
        group.add(lamp);
        glowPos.push(0, flatY + 0.7, lz2);
      }
      var endLamp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 6, 5), redMat);
      endLamp.position.set(0, flatY + 0.7, zEnd + (e === 0 ? -140 : 140));
      group.add(endLamp);
    }

    /* 灯具辉光：默认全透明，入夜后淡入。
       用 Points + 加法混合做，比给每盏灯加快捷光便宜得多。 */
    var glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(glowPos), 3));
    var glowMat = new THREE.PointsMaterial({
      map: getGlowTex(), color: 0xfff0c8, size: 13, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var lampGlow = new THREE.Points(glowGeo, glowMat);
    lampGlow.frustumCulled = false;
    lampGlow.renderOrder = 3;
    group.add(lampGlow);

    // 风向标
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    pole.position.set(60, flatY + 4, 90);
    group.add(pole);
    // 风向袋：挂在朝下风的支点上，靠 rotation.y 指风向、rotation.z 表示风力大小
    var sockPivot = new THREE.Group();
    sockPivot.position.set(60, flatY + 7.6, 90);
    group.add(sockPivot);
    var sock = new THREE.Mesh(new THREE.ConeGeometry(0.95, 4, 8, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xff7020, side: THREE.DoubleSide }));
    sock.rotation.z = Math.PI / 2;        // 锥尖指向 +X
    sock.position.set(2.0, 0, 0);
    sockPivot.add(sock);

    scene.add(group);
    return {
      group: group,
      runwayHalf: { w: RUNWAY_W / 2, l: RUNWAY_LEN / 2 },
      sock: sock, sockPivot: sockPivot,
      lampGlow: lampGlow, lampGlowMat: glowMat
    };
  }

  /* =======================================================================
   * 树木（两组 InstancedMesh：树干 + 树冠）
   * ===================================================================== */
  function buildTrees(scene, terrain, count, seed) {
    var rnd = mulberry32(seed || 12345);
    var trunkGeo = new THREE.CylinderGeometry(0.30, 0.46, 3.2, 5);
    trunkGeo.translate(0, 1.6, 0);
    var leafGeo = new THREE.ConeGeometry(2.3, 7.4, 7);
    leafGeo.translate(0, 6.6, 0);

    var trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1.0 });
    // 基色留白：实际颜色由每个实例的 instanceColor 决定
    var leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, flatShading: true });

    var trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    var leaves = new THREE.InstancedMesh(leafGeo, leafMat, count);
    trunks.castShadow = leaves.castShadow = true;
    leaves.receiveShadow = true;

    var dummy = new THREE.Object3D();
    var col = new THREE.Color();
    var placed = 0, tries = 0;
    var norm = { x: 0, y: 1, z: 0 };
    var limit = terrain.half - 300;

    while (placed < count && tries < count * 26) {
      tries++;
      var x = (rnd() * 2 - 1) * limit;
      var z = (rnd() * 2 - 1) * limit;
      var h = terrain.sample(x, z);
      if (h < 14 || h > 210) continue;                       // 不进水、不上雪线
      // 避开机场与跑道
      if (SimTerrain.rectDist(x, z, 320, 780) < 90) continue;
      terrain.normal(x, z, norm);
      if (norm.y < 0.80) continue;                           // 陡坡不长树
      // 成簇分布
      if (SimTerrain.fbm(x * 0.0025, z * 0.0025, 3, 2, 0.5) < 0.46) continue;

      var s = 0.75 + rnd() * 0.95;
      dummy.position.set(x, h - 0.4, z);
      dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
      dummy.scale.set(s, s * (0.8 + rnd() * 0.6), s);
      dummy.updateMatrix();
      trunks.setMatrixAt(placed, dummy.matrix);
      leaves.setMatrixAt(placed, dummy.matrix);
      col.setHSL(0.26 + rnd() * 0.06, 0.42 + rnd() * 0.22, 0.16 + rnd() * 0.13);
      leaves.setColorAt(placed, col);
      placed++;
    }
    trunks.count = placed;
    leaves.count = placed;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    trunks.frustumCulled = false;
    leaves.frustumCulled = false;
    scene.add(trunks); scene.add(leaves);
    return { trunks: trunks, leaves: leaves, count: placed };
  }

  /* =======================================================================
   * 城镇（远处地标，便于空中辨认方向）
   * ===================================================================== */
  function buildCity(scene, terrain, cx, cz, blocks) {
    var rnd = mulberry32(4242);
    var geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    var mat = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.22 });
    var mesh = new THREE.InstancedMesh(geo, mat, blocks);
    mesh.castShadow = true; mesh.receiveShadow = true;
    var dummy = new THREE.Object3D();
    var col = new THREE.Color();
    var n = 0;
    var winPos = [];          // 夜间窗口灯火的位置
    for (var i = 0; i < blocks * 4 && n < blocks; i++) {
      var a = rnd() * Math.PI * 2;
      var r = Math.pow(rnd(), 0.6) * 900;
      var x = cx + Math.cos(a) * r;
      var z = cz + Math.sin(a) * r;
      var h = terrain.sample(x, z);
      if (h < 12) continue;
      var far = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
      var tall = (0.35 + rnd() * 0.65) * (1 - far / 1000) * 92 + 8;
      var w = 14 + rnd() * 24;
      var d = 14 + rnd() * 24;
      dummy.position.set(x, h, z);
      dummy.rotation.set(0, rnd() * Math.PI, 0);
      dummy.scale.set(w, tall, d);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      col.setHSL(0.58 + rnd() * 0.06, 0.05 + rnd() * 0.10, 0.42 + rnd() * 0.30);
      mesh.setColorAt(n, col);
      // 每栋楼随机撒几个窗口灯
      var nw = 2 + (rnd() * 4 | 0);
      for (var q = 0; q < nw; q++) {
        winPos.push(
          x + (rnd() - 0.5) * w * 0.85,
          h + 3 + rnd() * Math.max(4, tall - 4),
          z + (rnd() - 0.5) * d * 0.85
        );
      }
      n++;
    }
    mesh.count = n;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);

    var wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(winPos), 3));
    var wmat = new THREE.PointsMaterial({
      map: getGlowTex(), color: 0xffd08a, size: 6.5, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var lights = new THREE.Points(wgeo, wmat);
    lights.frustumCulled = false;
    lights.renderOrder = 3;
    scene.add(lights);

    return { mesh: mesh, lights: lights, lightMat: wmat };
  }

  /* =======================================================================
   * 云
   * ===================================================================== */
  function buildClouds(scene, count, seed) {
    var rnd = mulberry32(seed || 808);
    var tex = makeCloudTexture();
    var group = new THREE.Group();
    group.name = 'clouds';
    // 共享少量材质，避免每朵云都新建一个（sprite 无法合批，材质越少越好）
    var mats = [];
    for (var m = 0; m < 5; m++) {
      mats.push(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, fog: true,
        opacity: 0.40 + m * 0.10,
        color: new THREE.Color().setHSL(0.60, 0.10 + m * 0.02, 0.86 + m * 0.02)
      }));
    }
    for (var i = 0; i < count; i++) {
      var sp = new THREE.Sprite(mats[i % mats.length]);
      var a = rnd() * Math.PI * 2;
      var r = 600 + Math.pow(rnd(), 0.7) * 9000;
      sp.position.set(Math.cos(a) * r, 420 + rnd() * 900, Math.sin(a) * r);
      var s = 320 + rnd() * 780;
      sp.scale.set(s, s * (0.34 + rnd() * 0.26), 1);
      sp.userData.drift = 1.5 + rnd() * 3.5;
      group.add(sp);
    }
    scene.add(group);
    return group;
  }

  /* =======================================================================
   * 穿环赛道
   * 航线用「地形跟随」自动定高：逐段采样地形，保证圆环之间整条走廊
   * 都有足够净空，玩家不用背地图也飞得下来。
   * ===================================================================== */
  var RING_RADIUS = 44;
  var RING_TUBE = 2.8;
  var RING_ROUTE = [
    [0, -780], [320, -1620], [980, -2200], [1780, -2280],
    [2420, -1520], [2560, -430], [2160, 560], [1480, 1360],
    [560, 2020], [-460, 2160], [-1420, 1460], [-1460, 340]
  ];
  var RING_CLEAR = 125;      // 走廊净空（米）

  function ringRoute(terrain) {
    var n = RING_ROUTE.length;
    var pts = [];
    for (var i = 0; i < n; i++) {
      pts.push({
        x: RING_ROUTE[i][0], z: RING_ROUTE[i][1],
        y: terrain.sample(RING_ROUTE[i][0], RING_ROUTE[i][1]) + 170
      });
    }
    // 逐段检查走廊地形，把两端都抬到净空之上
    for (var k = 0; k < n; k++) {
      var a = pts[k], b = pts[(k + 1) % n];
      var maxT = -1e9;
      for (var s = 0; s <= 24; s++) {
        var t = s / 24;
        maxT = Math.max(maxT, terrain.sample(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
      }
      var need = maxT + RING_CLEAR;
      if (a.y < need) a.y = need;
      if (b.y < need) b.y = need;
    }
    // 平滑两遍：相邻环高度差太大会很难飞
    for (var pass = 0; pass < 2; pass++) {
      var out = pts.map(function (p) { return { x: p.x, z: p.z, y: p.y }; });
      for (var j = 0; j < n; j++) {
        var p0 = pts[(j - 1 + n) % n], p1 = pts[j], p2 = pts[(j + 1) % n];
        out[j].y = p1.y + ((p0.y + p1.y + p2.y) / 3 - p1.y) * 0.55;
      }
      pts = out;
    }
    // 平滑之后可能又贴近地形，再抬一次
    for (var m = 0; m < n; m++) {
      var lo = terrain.sample(pts[m].x, pts[m].z) + 95;
      if (pts[m].y < lo) pts[m].y = lo;
    }
    return pts;
  }

  function buildRings(scene, terrain) {
    var pts = ringRoute(terrain);
    var n = pts.length;
    var geo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 44);
    var rings = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i];
      var prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      var dir = new THREE.Vector3(next.x - prev.x, next.y - prev.y, next.z - prev.z).normalize();
      // torus 默认在 XY 平面、法线 +Z，lookAt 让它对准航线方向
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0x1c3350, emissive: 0x2f6fb5, emissiveIntensity: 0.55,
        roughness: 0.4, metalness: 0.3, transparent: true, opacity: 0.72
      }));
      mesh.position.set(p.x, p.y, p.z);
      mesh.lookAt(p.x + dir.x, p.y + dir.y, p.z + dir.z);
      scene.add(mesh);

      // 环内薄光膜，便于判断朝向
      var film = new THREE.Mesh(
        new THREE.CircleGeometry(RING_RADIUS - RING_TUBE * 1.2, 40),
        new THREE.MeshBasicMaterial({
          color: 0x39ff88, transparent: true, opacity: 0.03,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      film.position.copy(mesh.position);
      film.quaternion.copy(mesh.quaternion);
      scene.add(film);

      rings.push({
        mesh: mesh, film: film,
        pos: mesh.position.clone(),
        normal: dir.clone(),
        radius: RING_RADIUS,
        index: i
      });
    }
    return rings;
  }

  /* 0=未到 1=下一个 2=已通过 */
  function setRingState(ring, state, t) {
    var m = ring.mesh.material, f = ring.film.material;
    if (state === 1) {
      var pulse = 0.65 + 0.35 * Math.sin(t * 5.0);
      m.color.setHex(0x2b6b3a);
      m.emissive.setHex(0x39ff88);
      m.emissiveIntensity = 0.9 + pulse * 1.6;
      m.opacity = 1.0;
      f.opacity = 0.06 + pulse * 0.11;
    } else if (state === 2) {
      m.color.setHex(0x25303a);
      m.emissive.setHex(0x2a4a5a);
      m.emissiveIntensity = 0.35;
      m.opacity = 0.42;
      f.opacity = 0.012;
    } else {
      m.color.setHex(0x1c3350);
      m.emissive.setHex(0x2f6fb5);
      m.emissiveIntensity = 0.55;
      m.opacity = 0.72;
      f.opacity = 0.03;
    }
  }

  /* =======================================================================
   * 定点着陆靶标（画在跑道上）
   * ===================================================================== */
  function makeTargetTexture() {
    var S = 512;
    var c = canvas(S, S), g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    var cx = S / 2, cy = S / 2;
    var bands = [
      [244, 'rgba(255,255,255,0.85)', 12],
      [186, 'rgba(255,255,255,0.85)', 5],
      [128, 'rgba(255,130,40,0.92)', 9],
      [68, 'rgba(255,255,255,0.90)', 5],
      [28, 'rgba(255,130,40,0.95)', 16]
    ];
    for (var i = 0; i < bands.length; i++) {
      g.beginPath();
      g.arc(cx, cy, bands[i][0], 0, Math.PI * 2);
      g.lineWidth = bands[i][2];
      g.strokeStyle = bands[i][1];
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 8;
    g.beginPath();
    g.moveTo(cx - 244, cy); g.lineTo(cx - 150, cy);
    g.moveTo(cx + 150, cy); g.lineTo(cx + 244, cy);
    g.moveTo(cx, cy - 244); g.lineTo(cx, cy - 150);
    g.moveTo(cx, cy + 150); g.lineTo(cx, cy + 244);
    g.stroke();
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    return tex;
  }

  function buildLandingTarget(scene, terrain, x, z) {
    var y = terrain.sample(x, z) + 0.14;
    var geo = new THREE.PlaneGeometry(84, 84);
    geo.rotateX(-Math.PI / 2);
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: makeTargetTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    }));
    mesh.position.set(x, y, z);
    mesh.renderOrder = 2;
    scene.add(mesh);
    // 靶心立柱 + 顶灯：浅角度进场时平铺的靶标会被严重压缩，靠它远距离也能定位
    var mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 20, 6),
      new THREE.MeshBasicMaterial({ color: 0xff7828 })
    );
    mast.position.set(x, y + 10, z);
    scene.add(mast);
    var cap = new THREE.Mesh(
      new THREE.SphereGeometry(1.8, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd24d })
    );
    cap.position.set(x, y + 20.5, z);
    scene.add(cap);
    return { mesh: mesh, mast: mast, cap: cap, x: x, z: z, radius: 42 };
  }

  /* =======================================================================
   * create — 组装整个世界
   * ===================================================================== */
  function create(opts) {
    opts = opts || {};
    var terrain = opts.terrain;
    var quality = QUALITY[opts.quality] || QUALITY.medium;
    var flatY = terrain.flatHeight;

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x9dbdd8, 2600, 13500);

    // 天空
    var sky = makeSky();
    scene.add(sky);
    var stars = makeStars();
    scene.add(stars);

    // 光照：太阳（投影）+ 月亮（不投影）两盏平行光交叉淡入
    var hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4d5a3c, 0.62);
    scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xfff2dd, 1.45);
    sun.position.copy(SUN_DIR).multiplyScalar(900);
    sun.castShadow = true;
    sun.shadow.mapSize.width = sun.shadow.mapSize.height = quality.shadowMap;
    var sc = sun.shadow.camera;
    sc.left = -260; sc.right = 260; sc.top = 260; sc.bottom = -260;
    sc.near = 10; sc.far = 2200;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.6;
    scene.add(sun);
    scene.add(sun.target);
    var moon = new THREE.DirectionalLight(0x9fb4dc, 0.0);
    moon.position.set(300, 600, 300);
    scene.add(moon);
    scene.add(moon.target);
    var ambient = new THREE.AmbientLight(0xffffff, 0.16);
    scene.add(ambient);

    // 地形
    var terrainMesh = buildTerrainMesh(terrain);
    scene.add(terrainMesh);

    // 海洋
    var waterTex = makeWaterTexture();
    var water = new THREE.Mesh(
      new THREE.PlaneGeometry(26000, 26000, 1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x17455e, roughness: 0.14, metalness: 0.42,
        map: waterTex, transparent: true, opacity: 0.93
      })
    );
    water.position.y = 0.0;
    water.receiveShadow = false;
    scene.add(water);

    // 机场
    var airfield = buildAirfield(scene, terrain, flatY);

    // 植被
    var trees = buildTrees(scene, terrain, quality.trees, 20240517);

    // 城镇：放在机场东北方向的山前平原上（空中地标）
    var cityX = 1800, cityZ = -1500;
    var city = buildCity(scene, terrain, cityX, cityZ, 220);

    // 云
    var clouds = buildClouds(scene, quality.clouds, 808);

    // 穿环赛道（默认隐藏，进入挑战模式才显示）
    var rings = buildRings(scene, terrain);
    for (var ri = 0; ri < rings.length; ri++) {
      rings[ri].mesh.visible = false;
      rings[ri].film.visible = false;
    }

    // 定点着陆靶标（默认隐藏）
    var target = buildLandingTarget(scene, terrain, 0, 40);
    target.mesh.visible = false;
    target.mast.visible = false;
    target.cap.visible = false;

    // 岛屿地标：山顶雷达站 / 海岸灯塔 / 跨海大桥 / 山谷大坝 / 风电场 / 港口
    // 位置全部由地形搜出来，不写死坐标
    var landmarks = null;
    if (SimLandmarks && !opts.noLandmarks) {
      landmarks = SimLandmarks.build(terrain);
      scene.add(landmarks.group);
    }

    /* =====================================================================
     * 降水：围绕相机的一柱粒子，落到地面就回到顶部。
     * 雨和雪共用一套 Points，靠速度/尺寸/颜色区分——雨点快而小、发蓝灰，
     * 雪片慢而大、纯白，横向还更吃风。
     * =================================================================== */
    var WEATHER = {
      clear: { speed: 0, size: 0, color: 0xbfd4e8, opacity: 0, drift: 0, fogNear: 1, fogFar: 1 },
      rain: { speed: 11, size: 0.62, color: 0xa8c0d8, opacity: 0.62, drift: 0.55, fogNear: 0.16, fogFar: 0.30 },
      snow: { speed: 2.6, size: 1.70, color: 0xf4f8ff, opacity: 0.90, drift: 1.35, fogNear: 0.10, fogFar: 0.22 }
    };
    function buildWeather() {
      var n = quality === 'high' ? 4200 : (quality === 'medium' ? 2400 : 1200);
      var R = 240, HT = 460;
      var pos = new Float32Array(n * 3);
      var seed = 20240115;
      var rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (var i = 0; i < n; i++) {
        var a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * R;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = rnd() * HT;
        pos[i * 3 + 2] = Math.sin(a) * r;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var mat = new THREE.PointsMaterial({
        color: 0xbfd4e8, size: 0.6, transparent: true, opacity: 0,
        depthWrite: false, sizeAttenuation: true, fog: false
      });
      var pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.visible = false;
      pts.renderOrder = 6;
      scene.add(pts);
      return { pts: pts, mat: mat, pos: pos, n: n, R: R, HT: HT, seed: seed, rnd: rnd };
    }
    var weather = buildWeather();
    var weatherKind = 'clear';
    var weatherAmt = 0;                 // 0..1，平滑过渡，避免切天气时粒子突然出现

    var env = {};                 // SimEnv 输出的当前环境参数
    var curHour = 12.5;
    var tAccum = 0;               // 地标动画用的累计时间
    var _tintWarm = new THREE.Color();
    var _hsl = { h: 0, s: 0, l: 0 };

    var api = {
      scene: scene,
      terrain: terrain,
      terrainMesh: terrainMesh,
      water: water,
      waterTex: waterTex,
      sky: sky,
      stars: stars,
      sun: sun,
      moon: moon,
      hemi: hemi,
      ambient: ambient,
      env: env,
      landmarks: landmarks,
      sunDir: SUN_DIR.clone(),
      airfield: airfield,
      trees: trees,
      city: city,
      clouds: clouds,
      rings: rings,
      target: target,
      flatY: flatY,
      quality: quality,
      cityPos: { x: cityX, z: cityZ },

      /* 天气：clear / rain / snow。只改粒子外观与能见度，
         对飞行的影响（额外阻力）由 physics 那边叠加。 */
      setWeather: function (kind) {
        weatherKind = WEATHER[kind] ? kind : 'clear';
        var w = WEATHER[weatherKind];
        weather.mat.color.setHex(w.color);
        weather.mat.size = w.size;
        weather.targetAmt = w.speed > 0 ? 1 : 0;
        return weatherKind;
      },
      get weather() { return weatherKind; },

      get hour() { return curHour; },

      /* 设置时刻：一次性把太阳/月亮方向、天空渐变、雾色、光照强度、
         星空与灯光亮度全部切到该时刻对应的配色。
         注意两盏平行光始终留在场景里（只调强度不调 visible），
         否则灯光数量变化会触发着色器重编译，切换时刻时会卡一下。 */
      setTime: function (hour) {
        curHour = ((hour % 24) + 24) % 24;
        SimEnv.at(curHour, env);

        sky.material.uniforms.topColor.value.setHex(env.top);
        sky.material.uniforms.midColor.value.setHex(env.mid);
        sky.material.uniforms.bottomColor.value.setHex(env.bottom);
        sky.material.uniforms.sunColor.value.setHex(env.isMoon ? 0x000000 : env.sunColor);
        sky.material.uniforms.sunDir.value.copy(env.sunDir);
        // 月面：月亮在地平线以下时完全不可见
        sky.material.uniforms.moonDir.value.copy(env.moonDir);
        sky.material.uniforms.moonAmount.value =
          clamp((env.moonDir.y - 0.02) / 0.25, 0, 1) * clamp(env.moonLight / 0.26, 0, 1);
        sky.material.uniforms.moonColor.value.setHex(env.moonLightColor);

        scene.fog.color.setHex(env.fog);
        sun.color.setHex(env.sunLightColor);
        sun.intensity = env.sunLight;
        moon.color.setHex(env.moonLightColor);
        moon.intensity = env.moonLight;

        hemi.color.setHex(env.hemiSky);
        hemi.groundColor.setHex(env.hemiGround);
        hemi.intensity = env.hemiIntensity;
        ambient.intensity = env.ambient;

        stars.material.opacity = env.star * 0.95;

        airfield.lampGlowMat.opacity = env.lamp * 0.95;
        city.lightMat.opacity = env.night * 0.85;

        // 云：夜里压暗；只有太阳贴近地平线（日落/日出）时才染暖色。
        // 不能用 lamp 判断——深夜里 lamp 也是 1，会把云染成泥棕色。
        var tint = 0.28 + 0.72 * (1 - env.night);
        var warmF = clamp(1 - Math.abs(env.elevation - 3) / 12, 0, 1);
        for (var ci = 0; ci < clouds.children.length; ci++) {
          var cm = clouds.children[ci].material;
          if (cm.userData.baseL === undefined) {
            cm.color.getHSL(_hsl);
            cm.userData.baseH = _hsl.h;
            cm.userData.baseS = _hsl.s;
            cm.userData.baseL = _hsl.l;
          }
          cm.color.setHSL(cm.userData.baseH, cm.userData.baseS,
            Math.max(0.05, cm.userData.baseL * tint));
          if (warmF > 0.02) {
            cm.color.lerp(_tintWarm.setHex(0xff8a4a), warmF * 0.5);
          }
        }
        return env;
      },

      /* 每帧更新：天空/星空跟随相机、阴影框跟随焦点、云漂移、海面流动、风向袋 */
      update: function (dt, camera, focus, windFromDeg, windSpeed) {
        tAccum += dt;
        sky.position.copy(camera.position);
        stars.position.copy(camera.position);

        /* ---- 降水 ---- */
        var wcfg = WEATHER[weatherKind];
        var wantAmt = wcfg.speed > 0 ? 1 : 0;
        weatherAmt += (wantAmt - weatherAmt) * Math.min(1, dt * 1.4);
        if (weatherAmt < 0.004) weatherAmt = 0;
        weather.pts.visible = weatherAmt > 0;
        weather.mat.opacity = wcfg.opacity * weatherAmt;
        // 能见度必须每帧跟着 weatherAmt 走——只有在 setTime 里设一次的话，
        // 切换天气的渐变过程里雾的距离就不会跟着变
        scene.fog.near = 2600 * (1 + (wcfg.fogNear - 1) * weatherAmt);
        scene.fog.far = 13500 * (1 + (wcfg.fogFar - 1) * weatherAmt);
        if (weather.pts.visible) {
          // 粒子整体跟着相机走，视觉上就是「周围一直在下」
          weather.pts.position.set(camera.position.x, camera.position.y - weather.HT * 0.42, camera.position.z);
          var p = weather.pos, R = weather.R, HT = weather.HT;
          var fall = wcfg.speed * dt;
          // 风把降水吹斜：风速越大横向漂移越快
          var wRad = (windFromDeg || 0) * Math.PI / 180;
          var drift = (windSpeed || 0) * wcfg.drift * dt;
          var dx = -Math.sin(wRad) * drift, dz = Math.cos(wRad) * drift;
          for (var i = 0; i < p.length; i += 3) {
            p[i + 1] -= fall;
            p[i] += dx;
            p[i + 2] += dz;
            if (p[i + 1] < 0) { p[i + 1] += HT; }
            // 出圈就从对面绕回来
            if (p[i] > R) p[i] -= R * 2; else if (p[i] < -R) p[i] += R * 2;
            if (p[i + 2] > R) p[i + 2] -= R * 2; else if (p[i + 2] < -R) p[i + 2] += R * 2;
          }
          weather.pts.geometry.attributes.position.needsUpdate = true;
        }

        sun.position.set(
          focus.x + env.sunDir.x * 700,
          focus.y + env.sunDir.y * 700,
          focus.z + env.sunDir.z * 700);
        sun.target.position.set(focus.x, focus.y, focus.z);
        sun.target.updateMatrixWorld();

        moon.position.set(
          focus.x + env.moonDir.x * 700,
          focus.y + env.moonDir.y * 700,
          focus.z + env.moonDir.z * 700);
        moon.target.position.set(focus.x, focus.y, focus.z);
        moon.target.updateMatrixWorld();

        waterTex.offset.x = (waterTex.offset.x + dt * 0.0016) % 1;
        waterTex.offset.y = (waterTex.offset.y + dt * 0.0011) % 1;
        water.position.x = camera.position.x;
        water.position.z = camera.position.z;

        // 风向袋：指向下风方向，风力越大越水平
        if (windFromDeg != null) {
          var to = (windFromDeg + 180) * Math.PI / 180;
          var wantY = Math.atan2(Math.sin(to), -Math.cos(to));
          var pv = airfield.sockPivot;
          var d = ((wantY - pv.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          pv.rotation.y += d * Math.min(1, dt * 1.5);
          var droop = 1 - clamp((windSpeed || 0) / 9, 0, 1);
          pv.rotation.z = -droop * 1.15;
        }

        if (clouds.children.length) {
          for (var i = 0; i < clouds.children.length; i++) {
            var c = clouds.children[i];
            c.position.x += c.userData.drift * dt;
            if (c.position.x > 9200) c.position.x = -9200;
          }
        }

        // 地标动画：雷达旋转、灯塔闪光、风机叶片
        if (landmarks) {
          for (var li = 0; li < landmarks.anim.length; li++) {
            landmarks.anim[li](dt, tAccum, env);
          }
        }
      }
    };
    api.setTime(opts.hour == null ? 12.5 : opts.hour);
    return api;
  }

  return {
    create: create,
    QUALITY: QUALITY,
    SUN_DIR: SUN_DIR,
    mulberry32: mulberry32,
    makeRunwayTexture: makeRunwayTexture,
    makeGlowTexture: makeGlowTexture,
    ringRoute: ringRoute,
    RING_RADIUS: RING_RADIUS,
    setRingState: setRingState,
    buildRings: buildRings
  };
});
