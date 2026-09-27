/* =========================================================================
 * landmarks.js — 岛屿地标
 *
 * 六处地标：山顶雷达站、海岸灯塔、跨海大桥、山谷大坝（带水库）、
 * 山脊风电场、港口。位置全部在构建时**从地形里搜出来**，而不是写死坐标，
 * 所以换随机种子照样成立。
 *
 * 只依赖 THREE 与传入的 terrain，不碰 DOM。
 * ========================================================================= */
(function (root, factory) {
  var api = factory(root.THREE);
  root.SimLandmarks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (THREE) {
  'use strict';

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };

  /* 复现随机数 */
  function rng(seed) {
    var a = seed | 0;
    return function () {
      a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function mesh(geo, mat, cast) {
    var m = new THREE.Mesh(geo, mat);
    m.castShadow = cast !== false;
    m.receiveShadow = true;
    return m;
  }

  /* 把一批几何体按各自矩阵烘成一个 BufferGeometry。
     公路虚线和输电铁塔零件数量很多，逐个建 mesh 会让绘制调用爆掉。
     这里保留索引直接拼接（不做 toNonIndexed），并用定长 TypedArray 填充，
     否则光是拆索引就能吃掉 200ms 加载时间。 */
  function mergeGeos(parts) {
    var i, k, g;
    var vCount = 0, iCount = 0, hasNormal = true;
    for (i = 0; i < parts.length; i++) {
      g = parts[i].geo;
      vCount += g.attributes.position.count;
      iCount += g.index ? g.index.count : g.attributes.position.count;
      if (!g.attributes.normal) hasNormal = false;
    }
    var pos = new Float32Array(vCount * 3);
    var nor = hasNormal ? new Float32Array(vCount * 3) : null;
    var idx = new Uint32Array(iCount);
    var nm = new THREE.Matrix3(), v = new THREE.Vector3();
    var vo = 0, io = 0, base = 0;

    for (i = 0; i < parts.length; i++) {
      g = parts[i].geo;
      var p = g.attributes.position.array;
      var n = hasNormal ? g.attributes.normal.array : null;
      nm.getNormalMatrix(parts[i].matrix);
      var pn = g.attributes.position.count;
      for (k = 0; k < pn; k++) {
        v.set(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]).applyMatrix4(parts[i].matrix);
        pos[vo] = v.x; pos[vo + 1] = v.y; pos[vo + 2] = v.z;
        if (nor) {
          v.set(n[k * 3], n[k * 3 + 1], n[k * 3 + 2]).applyMatrix3(nm).normalize();
          nor[vo] = v.x; nor[vo + 1] = v.y; nor[vo + 2] = v.z;
        }
        vo += 3;
      }
      if (g.index) {
        var ia = g.index.array;
        for (k = 0; k < ia.length; k++) idx[io++] = base + ia[k];
      } else {
        for (k = 0; k < pn; k++) idx[io++] = base + k;
      }
      base += pn;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    if (!nor) geo.computeVertexNormals();
    return geo;
  }

  function xform(px, py, pz, rx, ry, rz) {
    var m = new THREE.Matrix4();
    if (rx || ry || rz) m.makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
    m.setPosition(px, py, pz);
    return m;
  }

  /* =====================================================================
   * 选址：全部基于地形搜索
   * =================================================================== */
  function findPeak(H) {
    var best = { x: 0, z: 0, h: -1e9 };
    for (var x = -6600; x <= 6600; x += 60) {
      for (var z = -6600; z <= 6600; z += 60) {
        var h = H(x, z);
        if (h > best.h) best = { x: x, z: z, h: h };
      }
    }
    return best;
  }

  /* 窄水道：两侧都有陆地，跨度最小的那个 */
  function findChannel(H) {
    var dirs = [];
    for (var k = 0; k < 16; k++) {
      var a = k * Math.PI / 8;
      dirs.push([Math.sin(a), -Math.cos(a)]);
    }
    function run(x, z, dx, dz, maxD) {
      for (var d = 4; d <= maxD; d += 6) if (H(x + dx * d, z + dz * d) > 3) return d;
      return -1;
    }
    var best = null;
    for (var x = -6200; x <= 6200; x += 50) {
      for (var z = -6200; z <= 6200; z += 50) {
        if (H(x, z) > -2) continue;
        for (var k2 = 0; k2 < 8; k2++) {
          var d1 = dirs[k2], d2 = dirs[k2 + 8];
          var a = run(x, z, d1[0], d1[1], 900);
          var b = run(x, z, d2[0], d2[1], 900);
          if (a > 0 && b > 0) {
            var span = a + b;
            if (!best || span < best.span) best = { x: x, z: z, span: span, a: a, b: b, k: k2 };
          }
        }
      }
    }
    return best;
  }

  /* 坝址：坝轴两侧高、库区低平、下游有明显落差 */
  function findDam(H) {
    var D = 25;
    function grad(x, z) {
      return [(H(x + D, z) - H(x - D, z)) / (2 * D), (H(x, z + D) - H(x, z - D)) / (2 * D)];
    }
    var best = null;
    for (var x = -5400; x <= 5400; x += 35) {
      for (var z = -5400; z <= 5400; z += 35) {
        var r = Math.sqrt(x * x + z * z);
        if (r < 1600 || r > 5200) continue;
        var h = H(x, z);
        if (h < 25 || h > 330) continue;
        var g = grad(x, z);
        var gm = Math.sqrt(g[0] * g[0] + g[1] * g[1]);
        if (gm < 0.04 || gm > 0.55) continue;
        var ux = g[0] / gm, uz = g[1] / gm;
        var px = -uz, pz = ux;
        var w1 = H(x + px * 130, z + pz * 130), w2 = H(x - px * 130, z - pz * 130);
        if (w1 < h + 10 || w2 < h + 10) continue;
        var ok = 0, tot = 0, maxUp = -1e9;
        for (var s = 40; s <= 380; s += 42) {
          var hp = H(x + ux * s, z + uz * s);
          tot++; if (hp < h + 34) ok++;
          if (hp > maxUp) maxUp = hp;
        }
        for (var s2 = 60; s2 <= 360; s2 += 75) {
          for (var sg = -1; sg <= 1; sg += 2) {
            tot++;
            if (H(x + ux * s2 + px * sg * 170, z + uz * s2 + pz * sg * 170) > h + 30) ok++;
          }
        }
        if (ok / tot < 0.88) continue;
        var dn = H(x - ux * 260, z - uz * 260);
        if (dn > h - 14) continue;
        var score = (maxUp - h < 34 ? (h + 30 - maxUp) : 0) + (dn < h - 40 ? 20 : 0)
          + (ok / tot) * 60 - Math.abs(r - 3000) * 0.008;
        if (!best || score > best.score) {
          best = { x: x, z: z, h: h, ux: ux, uz: uz, px: px, pz: pz, dn: dn, score: score };
        }
      }
    }
    return best;
  }

  /* 海岸点：从中心沿方位往外走，地形首次跌破 3m 的地方 */
  function findCoast(H, bearingDeg) {
    var a = bearingDeg * Math.PI / 180;
    var dx = Math.sin(a), dz = -Math.cos(a);
    for (var d = 300; d < 7200; d += 20) {
      var x = dx * d, z = dz * d;
      if (H(x, z) < 3) {
        // 往回退 40m 保证站在陆地上
        return { x: dx * (d - 40), z: dz * (d - 40), h: H(dx * (d - 40), dz * (d - 40)), bearing: bearingDeg };
      }
    }
    return null;
  }

  /* 山脊线：某方位上环形山地里的最高点 */
  function findRidge(H, bearingDeg) {
    var a = bearingDeg * Math.PI / 180;
    var dx = Math.sin(a), dz = -Math.cos(a);
    var best = { x: 0, z: 0, h: -1e9 };
    for (var d = 2600; d < 5200; d += 30) {
      var h = H(dx * d, dz * d);
      if (h > best.h) best = { x: dx * d, z: dz * d, h: h };
    }
    return best;
  }

  /* =====================================================================
   * 地标构建
   * =================================================================== */

  /* --- 山顶雷达站 --- */
  function buildRadar(H, peak, out) {
    var y = H(peak.x, peak.z);
    var g = new THREE.Group();
    g.position.set(peak.x, y, peak.z);

    var conc = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.85 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x2e343a, roughness: 0.6, metalness: 0.4 });
    var glass = new THREE.MeshStandardMaterial({
      color: 0x7fd4ff, roughness: 0.2, metalness: 0.5,
      emissive: 0x2a6a88, emissiveIntensity: 0.6
    });

    var base = mesh(new THREE.CylinderGeometry(9, 12, 7, 12), conc);
    base.position.y = 3.5; g.add(base);
    var hall = mesh(new THREE.BoxGeometry(20, 6, 12), conc);
    hall.position.set(0, 9.5, 0); g.add(hall);
    var win = mesh(new THREE.BoxGeometry(20.4, 1.6, 8), glass, false);
    win.position.set(0, 10.4, 0); g.add(win);

    // 天线罩
    var dome = mesh(new THREE.SphereGeometry(5.2, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), conc);
    dome.position.set(0, 12.5, 0); g.add(dome);

    // 旋转的警戒雷达
    var spin = new THREE.Group();
    spin.position.set(0, 19, 0);
    var mast = mesh(new THREE.CylinderGeometry(0.5, 0.5, 12, 8), dark);
    mast.position.y = 6; spin.add(mast);
    var dish = mesh(new THREE.BoxGeometry(9, 2.6, 0.5), dark);
    dish.position.set(0, 11, 0);
    dish.rotation.x = -0.35;
    spin.add(dish);
    var dish2 = mesh(new THREE.BoxGeometry(0.4, 2.4, 4.4), dark);
    dish2.position.set(0, 11, 0);
    dish2.rotation.x = -0.35;
    spin.add(dish2);
    g.add(spin);

    // 山顶通信塔
    for (var i = 0; i < 3; i++) {
      var a = i * Math.PI * 2 / 3;
      var th = mesh(new THREE.CylinderGeometry(0.25, 0.35, 22, 6), dark);
      th.position.set(Math.cos(a) * 16, 11, Math.sin(a) * 16);
      g.add(th);
    }

    var beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
    var bcn = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), beaconMat);
    bcn.position.set(0, 22.5, 0);
    g.add(bcn);

    out.group.add(g);
    out.anim.push(function (dt, t, env) {
      spin.rotation.y += dt * (0.5 + env.night * 0.3);
      beaconMat.color.setHex((t % 2) < 0.25 ? 0xff6a5a : 0x501510);
    });
    return { name: '雷达站', x: peak.x, z: peak.z, y: y };
  }

  /* --- 海岸灯塔 --- */
  function buildLighthouse(H, site, out) {
    var y = H(site.x, site.z);
    var g = new THREE.Group();
    g.position.set(site.x, y, site.z);

    var white = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.75 });
    var red = new THREE.MeshStandardMaterial({ color: 0xd8392b, roughness: 0.75 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.6 });

    // 红白相间的塔身
    var segs = 6, hgt = 4.2;
    for (var i = 0; i < segs; i++) {
      var r0 = 3.4 - i * 0.42, r1 = 3.4 - (i + 1) * 0.42;
      var s = mesh(new THREE.CylinderGeometry(r1, r0, hgt, 14), i % 2 ? red : white);
      s.position.y = hgt * (i + 0.5) + 1.5;
      g.add(s);
    }
    var baseRing = mesh(new THREE.CylinderGeometry(4.6, 5.4, 1.6, 16), dark);
    baseRing.position.y = 0.8; g.add(baseRing);

    var topY = hgt * segs + 1.5;
    var gallery = mesh(new THREE.CylinderGeometry(3.0, 3.0, 0.6, 14), dark);
    gallery.position.y = topY; g.add(gallery);
    var rail = mesh(new THREE.TorusGeometry(2.9, 0.12, 5, 20), dark, false);
    rail.position.y = topY + 0.9; rail.rotation.x = Math.PI / 2; g.add(rail);

    var lanternMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0 });
    var lantern = mesh(new THREE.CylinderGeometry(1.9, 1.9, 3.0, 12), lanternMat, false);
    lantern.position.y = topY + 1.9; g.add(lantern);
    var roof = mesh(new THREE.ConeGeometry(2.4, 1.8, 12), red);
    roof.position.y = topY + 4.3; g.add(roof);

    // 旋转光束：两条细长的加法混合面片
    var beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff3c0, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    var beamG = new THREE.Group();
    beamG.position.y = topY + 1.9;
    for (var b = 0; b < 2; b++) {
      var bm = new THREE.Mesh(new THREE.PlaneGeometry(150, 7), beamMat);
      bm.position.x = 75;
      bm.rotation.y = b * Math.PI;
      beamG.add(bm);
    }
    g.add(beamG);

    // 附属小屋
    var hut = mesh(new THREE.BoxGeometry(9, 5, 7), white);
    hut.position.set(11, 2.5, 3); g.add(hut);
    var hutRoof = mesh(new THREE.ConeGeometry(6.6, 2.6, 4), red);
    hutRoof.position.set(11, 6.2, 3); hutRoof.rotation.y = Math.PI / 4; g.add(hutRoof);

    out.group.add(g);
    out.anim.push(function (dt, t, env) {
      beamG.rotation.y += dt * 1.1;
      var flash = (t % 3.0) < 0.55 ? 1 : 0.06;      // 周期闪光
      beamMat.opacity = env.night * 0.30 * flash;
      lanternMat.color.setHex(env.night > 0.3 ? 0xfff6cc : 0x8d8f86);
    });
    return { name: '灯塔', x: site.x, z: site.z, y: y };
  }

  /* --- 跨海大桥 --- */
  function buildBridge(H, site, out) {
    var dirs = [];
    for (var k = 0; k < 16; k++) { var a = k * Math.PI / 8; dirs.push([Math.sin(a), -Math.cos(a)]); }
    var d1 = dirs[site.k], d2 = dirs[site.k + 8];

    function land(x, z, dx, dz, maxD) {
      for (var d = 4; d <= maxD; d += 5) { var hh = H(x + dx * d, z + dz * d); if (hh > 3) return { d: d, h: hh }; }
      return null;
    }
    var A = land(site.x, site.z, d1[0], d1[1], 950);
    var B = land(site.x, site.z, d2[0], d2[1], 950);
    if (!A || !B) return null;

    var ax = site.x + d1[0] * A.d, az = site.z + d1[1] * A.d;
    var bx = site.x - d1[0] * B.d, bz = site.z - d1[1] * B.d;
    var span = A.d + B.d;
    var yA = A.h, yB = B.h;
    var deckY = Math.max(yA, yB) + 16;
    var cx = (ax + bx) / 2, cz = (az + bz) / 2;
    var bearing = Math.atan2(bx - ax, -(bz - az));

    var g = new THREE.Group();
    g.position.set(cx, deckY, cz);
    g.rotation.y = -bearing;

    var steel = new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.55, metalness: 0.5 });
    var conc = new THREE.MeshStandardMaterial({ color: 0xa8a49c, roughness: 0.9 });
    var road = new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.95 });

    var half = span / 2 + 30;
    var deck = mesh(new THREE.BoxGeometry(16, 1.8, half * 2), steel);
    g.add(deck);
    var surface = mesh(new THREE.BoxGeometry(14, 0.3, half * 2), road);
    surface.position.y = 1.0; g.add(surface);

    // 桥塔 + 拉索（斜拉桥）
    var towerH = 52;
    for (var s = -1; s <= 1; s += 2) {
      var tz = s * span * 0.22;
      var leg1 = mesh(new THREE.BoxGeometry(2.6, towerH, 2.6), conc);
      leg1.position.set(-6.5, towerH / 2, tz); g.add(leg1);
      var leg2 = mesh(new THREE.BoxGeometry(2.6, towerH, 2.6), conc);
      leg2.position.set(6.5, towerH / 2, tz); g.add(leg2);
      var cross = mesh(new THREE.BoxGeometry(15, 2, 2.4), conc);
      cross.position.set(0, towerH - 6, tz); g.add(cross);
      var cross2 = mesh(new THREE.BoxGeometry(15, 1.6, 2.2), conc);
      cross2.position.set(0, towerH * 0.55, tz); g.add(cross2);

      // 拉索
      for (var c = 1; c <= 7; c++) {
        for (var sd = -1; sd <= 1; sd += 2) {
          var zEnd = tz + sd * (12 + c * 13);
          if (Math.abs(zEnd) > half) continue;
          var top = new THREE.Vector3(sd * 0, towerH - 4, tz);
          var bot = new THREE.Vector3(sd * 7.4, 0.9, zEnd);
          var dir = new THREE.Vector3().subVectors(bot, top);
          var len = dir.length();
          var cable = mesh(new THREE.CylinderGeometry(0.16, 0.16, len, 4), steel, false);
          cable.position.copy(top).addScaledVector(dir, 0.5);
          cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
          g.add(cable);
        }
      }
      // 桥塔横梁上的航空障碍灯
      var obMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
      var ob = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 6), obMat);
      ob.position.set(0, towerH + 2, tz);
      g.add(ob);
    }

    // 桥墩
    var piers = Math.max(2, Math.round(span / 130));
    for (var p = 1; p < piers; p++) {
      var pz2 = -half + (half * 2) * (p / piers);
      var ph = deckY - Math.min(H(cx + Math.sin(bearing) * 0, cz), deckY) + 40;
      var pier = mesh(new THREE.CylinderGeometry(3.2, 4.0, 60, 10), conc);
      pier.position.set(0, -30, pz2);
      g.add(pier);
    }

    out.group.add(g);
    return { name: '大桥', x: cx, z: cz, y: deckY, span: span };
  }

  /* --- 山谷大坝 + 水库 --- */
  function buildDam(H, site, out) {
    var h = site.h;

    /* 蓄水深度必须由实际谷壁高度决定。
       这片程序化地形只有平原 + 环形山脊，没有真正被河流切出来的深谷，
       谷壁一般只高出河床 30m 上下；硬按"30m 深水库"设计，水会正好漫到谷壁顶。 */
    var wallMin = 1e9;
    var ww = [110, 170];
    for (var wi = 0; wi < ww.length; wi++) {
      for (var ws = -1; ws <= 1; ws += 2) {
        wallMin = Math.min(wallMin, H(site.x + site.px * ww[wi] * ws, site.z + site.pz * ww[wi] * ws) - h);
      }
    }
    var depth = clamp(wallMin * 0.55, 8, 30);
    var crest = h + depth + 3;                 // 坝顶高出水面 3m
    var water = crest - 1.2;
    var downstream = site.dn;
    var damH = Math.max(16, crest - downstream + 8);
    var axisBearing = Math.atan2(site.px, -site.pz);

    var conc = new THREE.MeshStandardMaterial({ color: 0xb0aca4, roughness: 0.92 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.8 });

    var g = new THREE.Group();
    g.position.set(site.x, crest, site.z);
    g.rotation.y = -axisBearing;

    // 坝体：略微拱起的几段，做出重力拱坝的弧线
    var segN = 9, segW = 34, bulge = 16;
    for (var i = 0; i < segN; i++) {
      var t = (i - (segN - 1) / 2) / ((segN - 1) / 2);      // -1..1
      var seg = mesh(new THREE.BoxGeometry(segW + 1.5, damH, 13), conc);
      seg.position.set(t * (segN * segW / 2 / 1.0) * 0.98, -damH / 2, Math.abs(t) * bulge * -1);
      seg.rotation.y = -t * 0.20;
      g.add(seg);
    }
    // 坝顶路面与护栏
    var road = mesh(new THREE.BoxGeometry(segN * segW, 1.2, 11), dark);
    road.position.set(0, 0.6, -bulge * 0.4);
    g.add(road);
    // 泄洪闸
    for (var k2 = -1; k2 <= 1; k2++) {
      var gate = mesh(new THREE.BoxGeometry(9, 8, 3), dark);
      gate.position.set(k2 * 40, -8, 8.5);
      g.add(gate);
    }
    // 坝顶灯
    var lampMat = new THREE.MeshBasicMaterial({ color: 0xffd070 });
    for (var l = -2; l <= 2; l++) {
      var lp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 7, 5), lampMat);
      lp.position.set(l * 60, 2.2, -bulge * 0.4);
      g.add(lp);
    }

    // 水电站厂房（下游）
    var house = mesh(new THREE.BoxGeometry(30, 14, 18), conc);
    house.position.set(0, -damH - 4, 46);
    g.add(house);

    out.group.add(g);

    /* 水库：一块只在水位以下可见的平面，沿河谷方向铺开。
       朝向要注意：PlaneGeometry 经 rotateX(-90°) 后，局部 +Y（构造函数的第二个
       参数，也就是"长度"）映射到世界 -Z。要让长度顺着河谷，旋转角必须是
       atan2(-ux, -uz)；原先写成 -atan2(ux,-uz)+90° 会把水面转错 90°，
       长边横跨山谷，水从两侧谷壁穿出去。

       长度不能写死：河谷几百米外就会拐弯，用坝址处的梯度方向做直线近似会失效，
       水面会在远端露出。这里沿河谷实际往前走，走到谷壁兜不住水为止。 */
    var upLen = 70, resW = 110;
    for (var s2 = 70; s2 <= 460; s2 += 20) {
      var lx = site.x + site.ux * s2, lz = site.z + site.uz * s2;
      var wallL = H(lx + site.px * resW, lz + site.pz * resW);
      var wallR = H(lx - site.px * resW, lz - site.pz * resW);
      var bed = H(lx, lz);
      if (wallL < water + 2 || wallR < water + 2) break;   // 谷壁已挡不住
      if (bed > water - 0.5) break;                        // 河床已高出水面，水库到头了
      upLen = s2;
    }

    var resGeo = new THREE.PlaneGeometry(resW * 2, upLen);   // 宽（横谷） × 长（沿谷）
    resGeo.rotateX(-Math.PI / 2);
    var resMat = new THREE.MeshStandardMaterial({
      color: 0x1d4d63, roughness: 0.16, metalness: 0.35,
      transparent: true, opacity: 0.9
    });
    var res = new THREE.Mesh(resGeo, resMat);
    res.position.set(
      site.x + site.ux * upLen / 2, crest - 1.2, site.z + site.uz * upLen / 2);
    res.rotation.y = Math.atan2(-site.ux, -site.uz);
    res.receiveShadow = false;
    out.group.add(res);

    out.anim.push(function (dt, t, env) {
      lampMat.color.setHex(env.night > 0.3 ? 0xffe0a0 : 0x6b6250);
    });
    return { name: '大坝', x: site.x, z: site.z, y: crest, height: damH };
  }

  /* --- 风电场 --- */
  function buildWindFarm(H, ridge, out) {
    var rand = rng(4242);
    var g = new THREE.Group();
    var towerMat = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.6, metalness: 0.2 });
    var bladeMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.5 });
    var nacMat = new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.55 });

    var placed = 0, spins = [];
    var baseA = 0;
    for (var i = 0; i < 26 && placed < 9; i++) {
      var a = baseA + (i - 6) * 0.075;
      var d = 0;
      var x = ridge.x + Math.sin(a + Math.PI / 2) * (i - 6) * 62;
      var z = ridge.z + Math.cos(a + Math.PI / 2) * (i - 6) * 62;
      var y = H(x, z);
      if (y < 120) continue;                       // 只立在高处
      var n1 = H(x + 40, z), n2 = H(x - 40, z), n3 = H(x, z + 40), n4 = H(x, z - 40);
      if (Math.max(Math.abs(n1 - y), Math.abs(n2 - y), Math.abs(n3 - y), Math.abs(n4 - y)) > 14) continue;

      var hubH = 46 + rand() * 10;
      var tw = mesh(new THREE.CylinderGeometry(1.5, 3.2, hubH, 10), towerMat);
      tw.position.set(x, y + hubH / 2, z);
      g.add(tw);
      var nac = mesh(new THREE.BoxGeometry(3.4, 3.4, 9), nacMat);
      nac.position.set(x, y + hubH + 1.4, z);
      g.add(nac);

      var rotor = new THREE.Group();
      rotor.position.set(x, y + hubH + 1.4, z + 4.4);
      for (var b = 0; b < 3; b++) {
        var bl = mesh(new THREE.BoxGeometry(1.5, 30, 0.7), bladeMat);
        bl.position.y = 15;
        var holder = new THREE.Group();
        holder.rotation.z = b * Math.PI * 2 / 3;
        holder.add(bl);
        rotor.add(holder);
      }
      g.add(rotor);
      spins.push({ r: rotor, w: 0.5 + rand() * 0.35, ph: rand() * 6.28 });
      placed++;
    }
    if (!placed) return null;
    out.group.add(g);
    out.anim.push(function (dt, t) {
      for (var i2 = 0; i2 < spins.length; i2++) spins[i2].r.rotation.z += dt * spins[i2].w;
    });
    return { name: '风电场', x: ridge.x, z: ridge.z, y: ridge.h, count: placed };
  }

  /* --- 港口 --- */
  function buildHarbor(H, coast, out) {
    var y = Math.max(2, H(coast.x, coast.z));
    var g = new THREE.Group();
    g.position.set(coast.x, y, coast.z);
    // 朝海的方向 = 从原点指向该点
    var seaBearing = Math.atan2(coast.x, -coast.z);
    g.rotation.y = -seaBearing;

    var conc = new THREE.MeshStandardMaterial({ color: 0x9e9a92, roughness: 0.95 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x3c4247, roughness: 0.7, metalness: 0.3 });
    var metal = new THREE.MeshStandardMaterial({ color: 0xc0603a, roughness: 0.6, metalness: 0.3 });

    // 防波堤（折线）
    for (var i = 0; i < 16; i++) {
      var t = i / 15;
      var bx = -120 + t * 40 + Math.sin(t * 3.4) * 90;
      var bz = 60 + t * 210;
      var blk = mesh(new THREE.BoxGeometry(26, 9 + Math.sin(i) * 2, 26), conc);
      blk.position.set(bx, -3.5, bz);
      blk.rotation.y = Math.sin(t * 3.4) * 0.4;
      g.add(blk);
    }
    // 码头
    for (var p = 0; p < 3; p++) {
      var pier = mesh(new THREE.BoxGeometry(80, 6, 26), conc);
      pier.position.set(-40, -1, 30 + p * 90);
      g.add(pier);
    }
    var quay = mesh(new THREE.BoxGeometry(200, 8, 46), conc);
    quay.position.set(-30, 0, -30);
    g.add(quay);

    // 门式起重机
    for (var cr = 0; cr < 3; cr++) {
      var cg = new THREE.Group();
      cg.position.set(-30 + cr * 55, 4, -14);
      for (var lg = 0; lg < 4; lg++) {
        var lx = (lg % 2 ? 1 : -1) * 9, lz = (lg < 2 ? 1 : -1) * 7;
        var leg = mesh(new THREE.BoxGeometry(2.2, 26, 2.2), metal);
        leg.position.set(lx, 13, lz); cg.add(leg);
      }
      var beam = mesh(new THREE.BoxGeometry(30, 2.6, 18), metal);
      beam.position.set(0, 27, 0); cg.add(beam);
      var jib = mesh(new THREE.BoxGeometry(2.4, 2.4, 34), metal);
      jib.position.set(0, 30, 12); cg.add(jib);
      g.add(cg);
    }

    // 货轮
    for (var s = 0; s < 2; s++) {
      var sh = new THREE.Group();
      sh.position.set(-70 + s * 70, -1.5, 120 + s * 70);
      sh.rotation.y = 0.25 - s * 0.5;
      var hull = mesh(new THREE.BoxGeometry(18, 9, 76), dark);
      sh.add(hull);
      var bow = mesh(new THREE.ConeGeometry(9, 16, 4), dark);
      bow.rotation.x = -Math.PI / 2; bow.rotation.y = Math.PI / 4;
      bow.position.z = -46; sh.add(bow);
      var deck = mesh(new THREE.BoxGeometry(20, 2, 60), metal);
      deck.position.y = 5; sh.add(deck);
      var sup = mesh(new THREE.BoxGeometry(14, 12, 12), new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.7 }));
      sup.position.set(0, 12, 26); sh.add(sup);
      var funnel = mesh(new THREE.CylinderGeometry(2.4, 2.8, 8, 8), dark);
      funnel.position.set(0, 22, 22); sh.add(funnel);
      for (var c2 = 0; c2 < 3; c2++) {
        var cont = mesh(new THREE.BoxGeometry(7, 6, 16),
          new THREE.MeshStandardMaterial({ color: [0x2f6fb5, 0xc0603a, 0x3f9c5a][c2], roughness: 0.8 }));
        cont.position.set(0, 9, -18 + c2 * 18);
        sh.add(cont);
      }
      g.add(sh);
    }

    out.group.add(g);
    return { name: '港口', x: coast.x, z: coast.z, y: y };
  }

  /* =====================================================================
   * 公路：沿控制点铺一条贴合地形的带子
   * 用 Catmull-Rom 平滑路径，每 ~12m 采一个断面；断面取水平法向展开，
   * 两侧用同一高程（真实路面是平的），所以横坡上会自然地"切"进山体一侧。
   * 跨水的地方抬到水面以上，变成堤道。
   * =================================================================== */
  function roadRibbon(H, controlPts, width, lift) {
    var curve = new THREE.CatmullRomCurve3(controlPts);
    var len = curve.getLength();
    var N = Math.max(16, Math.round(len / 12));
    var sp = curve.getSpacedPoints(N);

    var pos = new Float32Array((N + 1) * 2 * 3);
    var idx = [];
    for (var i = 0; i <= N; i++) {
      var p = sp[i];
      var a = sp[i > 0 ? i - 1 : 0];
      var b = sp[i < N ? i + 1 : N];
      var tx = b.x - a.x, tz = b.z - a.z;
      var tl = Math.sqrt(tx * tx + tz * tz) || 1;
      tx /= tl; tz /= tl;
      var nx = -tz, nz = tx;                       // 水平法向
      var hw = width / 2;
      var lx = p.x + nx * hw, lz = p.z + nz * hw;
      var rx = p.x - nx * hw, rz = p.z - nz * hw;
      // 两侧同高；低于水面时抬到水面上，形成堤道
      var y = (Math.max(H(lx, lz), 0.8) + Math.max(H(rx, rz), 0.8)) / 2 + lift;
      pos[i * 6] = lx; pos[i * 6 + 1] = y; pos[i * 6 + 2] = lz;
      pos[i * 6 + 3] = rx; pos[i * 6 + 4] = y; pos[i * 6 + 5] = rz;
      if (i < N) {
        var o = i * 2;
        idx.push(o, o + 1, o + 3, o, o + 3, o + 2);
      }
    }
    return { pos: pos, idx: idx };
  }

  function ribbonMesh(data, color) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    geo.setIndex(data.idx);
    geo.computeVertexNormals();
    var m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: color, roughness: 0.95, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      side: THREE.DoubleSide
    }));
    m.receiveShadow = true;          // 路面贴着地面，不投影
    m.castShadow = false;
    return m;
  }

  /* 一条路 = 路面 + 路肩 + 中线。中线可能有几百段，
     全部拼进一个 BufferGeometry，避免几百次绘制调用。 */
  function buildRoad(H, controlPts, out, opts) {
    opts = opts || {};
    var width = opts.width || 11;
    var g = new THREE.Group();

    g.add(ribbonMesh(roadRibbon(H, controlPts, width + 5, 0.22), 0x6b6558));   // 路肩
    g.add(ribbonMesh(roadRibbon(H, controlPts, width, 0.35), 0x3a3f44));       // 路面

    var curve = new THREE.CatmullRomCurve3(controlPts);
    var len = curve.getLength();
    var segs = Math.max(8, Math.round(len / 46));
    var dashes = [];
    for (var s = 0; s < segs; s++) {
      var t0 = (s + 0.15) / segs, t1 = (s + 0.68) / segs;
      var sub = [];
      for (var k = 0; k <= 3; k++) {
        sub.push(curve.getPointAt(Math.min(0.999, Math.max(0, t0 + (t1 - t0) * (k / 3)))));
      }
      var d = roadRibbon(H, sub, 0.8, 0.42);
      var m = new THREE.Matrix4();          // 已经算好世界坐标，矩阵取单位阵
      dashes.push({ geo: (function () {
        var gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
        gg.setIndex(d.idx);
        return gg;
      })(), matrix: m });
    }
    if (dashes.length) {
      var dm = new THREE.Mesh(mergeGeos(dashes), new THREE.MeshStandardMaterial({
        color: 0xf0efe6, roughness: 0.9,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
      }));
      dm.castShadow = false; dm.receiveShadow = true;
      g.add(dm);
    }

    out.group.add(g);
    return { road: g, length: len };
  }

  /* =====================================================================
   * 高压输电线路：铁塔 + 悬链线下垂
   * =================================================================== */
  function buildPowerLine(H, controlPts, out) {
    var curve = new THREE.CatmullRomCurve3(controlPts);
    var len = curve.getLength();
    var nTower = Math.max(4, Math.round(len / 210));
    var steel = new THREE.MeshStandardMaterial({ color: 0x8d949b, roughness: 0.6, metalness: 0.55 });
    var g = new THREE.Group();

    // 铁塔零件全部烘成一个网格：23 基 × 8 个零件 = 184 次绘制太浪费
    var legGeo = new THREE.CylinderGeometry(0.22, 0.45, 1, 5);
    var armGeo = new THREE.BoxGeometry(1, 0.7, 0.7);
    var barGeo = new THREE.BoxGeometry(0.5, 0.5, 3.2);
    var parts = [];
    var tops = [];

    for (var i = 0; i < nTower; i++) {
      var t = (i + 0.5) / nTower;
      var p = curve.getPointAt(t);
      var y = Math.max(H(p.x, p.z), 1.0);
      if (y < 3) continue;                       // 不往水里立塔
      var H0 = 34;
      for (var lg = 0; lg < 4; lg++) {
        var sx = (lg % 2 ? 1 : -1) * 2.6, sz = (lg < 2 ? 1 : -1) * 2.6;
        var m = xform(p.x + sx * 0.6, y + H0 / 2, p.z + sz * 0.6, sz * 0.045, 0, -sx * 0.045);
        m.multiply(new THREE.Matrix4().makeScale(1, H0, 1));
        parts.push({ geo: legGeo, matrix: m });
      }
      for (var arm = 0; arm < 2; arm++) {
        var ay = y + H0 * (0.72 + arm * 0.16);
        var aw = 9 - arm * 2.4;
        var am = xform(p.x, ay, p.z);
        am.multiply(new THREE.Matrix4().makeScale(aw * 2, 1, 1));
        parts.push({ geo: armGeo, matrix: am });
      }
      var pm = xform(p.x, y + H0 + 1.2, p.z, Math.PI / 2, 0, 0);
      parts.push({ geo: barGeo, matrix: pm });

      var obMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
      var ob = new THREE.Mesh(new THREE.SphereGeometry(0.5, 7, 5), obMat);
      ob.position.set(p.x, y + H0 + 2.2, p.z);
      g.add(ob);
      tops.push({ x: p.x, y: y + H0, z: p.z, obMat: obMat, armW: 9 });
    }
    if (tops.length < 2) { out.group.add(g); return null; }
    g.add(new THREE.Mesh(mergeGeos(parts), steel));

    // 导线：逐档画悬链线，三层（左右各一 + 地线）
    var lineMatW = new THREE.LineBasicMaterial({ color: 0x2b3138, transparent: true, opacity: 0.85 });
    var lineMatG = new THREE.LineBasicMaterial({ color: 0x3a4046, transparent: true, opacity: 0.7 });
    function span(a, b, offX, offY, sag, mat) {
      var pts = [];
      var STEPS = 10;
      for (var s = 0; s <= STEPS; s++) {
        var t = s / STEPS;
        var x = a.x + (b.x - a.x) * t;
        var z = a.z + (b.z - a.z) * t;
        var y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t);
        pts.push(new THREE.Vector3(x + offX, y + offY, z));
      }
      var geo = new THREE.BufferGeometry().setFromPoints(pts);
      return new THREE.Line(geo, mat);
    }
    for (var k = 0; k < tops.length - 1; k++) {
      var A = tops[k], B = tops[k + 1];
      var d = Math.hypot(B.x - A.x, B.z - A.z);
      var sag = clamp(d * 0.045, 1.2, 7);
      // 面向垂直于线路方向偏移横担上的挂点
      var dx = (B.x - A.x) / (d || 1), dz = (B.z - A.z) / (d || 1);
      var px = -dz, pz = dx;
      for (var c = -1; c <= 1; c += 2) {
        g.add(span(A, B, px * 8 * c, -A.armW * 0.06 - 1.0, sag, lineMatW));
      }
      g.add(span(A, B, 0, 1.4, sag * 0.75, lineMatG));
    }

    var first = tops[0];
    out.group.add(g);
    out.anim.push(function (dt, t, env) {
      var on = (t % 2.4) < 0.3;
      for (var i2 = 0; i2 < tops.length; i2++) {
        tops[i2].obMat.color.setHex(on ? 0xff6a5a : 0x501510);
      }
    });
    return { name: '输电线路', x: first.x, z: first.z, y: first.y, towers: tops.length };
  }

  /* =====================================================================
   * 电视塔（山顶，地标性高塔）
   * =================================================================== */
  function buildTvTower(H, site, out) {
    var y = H(site.x, site.z);
    var g = new THREE.Group();
    g.position.set(site.x, y, site.z);

    var conc = new THREE.MeshStandardMaterial({ color: 0xc4c6c9, roughness: 0.8 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x33383e, roughness: 0.6, metalness: 0.4 });
    var glass = new THREE.MeshStandardMaterial({
      color: 0x8fd8ff, roughness: 0.15, metalness: 0.6,
      emissive: 0x2e7ea0, emissiveIntensity: 0.5
    });

    // 混凝土塔身（下粗上细）
    var segN = 7;
    for (var i = 0; i < segN; i++) {
      var r0 = 4.2 - i * 0.42, r1 = 4.2 - (i + 1) * 0.42;
      var s = mesh(new THREE.CylinderGeometry(Math.max(0.9, r1), r0, 9, 12), conc);
      s.position.y = 9 * (i + 0.5);
      g.add(s);
    }
    var topY = 9 * segN;

    // 观景层（玻璃圆盘）
    var pod = mesh(new THREE.CylinderGeometry(7.5, 6.4, 7, 16), conc);
    pod.position.y = topY + 3.5; g.add(pod);
    var podGlass = mesh(new THREE.CylinderGeometry(7.6, 7.6, 4.2, 16), glass, false);
    podGlass.position.y = topY + 3.6; g.add(podGlass);
    var podRoof = mesh(new THREE.CylinderGeometry(7.8, 7.8, 1.0, 16), dark);
    podRoof.position.y = topY + 7.3; g.add(podRoof);

    // 天线桅杆
    var mastH = 34;
    var mast = mesh(new THREE.CylinderGeometry(0.5, 1.2, mastH, 8), dark);
    mast.position.y = topY + 7.8 + mastH / 2; g.add(mast);
    for (var r = 0; r < 4; r++) {
      var ring = mesh(new THREE.TorusGeometry(1.1 - r * 0.16, 0.12, 5, 12), dark, false);
      ring.position.y = topY + 12 + r * 8;
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    }
    var beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
    var bcn = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), beaconMat);
    bcn.position.y = topY + 8.5 + mastH;
    g.add(bcn);

    // 拉线
    for (var c = 0; c < 6; c++) {
      var a = c * Math.PI / 3;
      var ax = Math.cos(a) * 30, az = Math.sin(a) * 30;
      var ay = H(site.x + ax, site.z + az) - y;
      var top = new THREE.Vector3(0, topY * 0.55, 0);
      var bot = new THREE.Vector3(ax, ay, az);
      var dir = new THREE.Vector3().subVectors(bot, top);
      var L = dir.length();
      var cable = mesh(new THREE.CylinderGeometry(0.12, 0.12, L, 4), dark, false);
      cable.position.copy(top).addScaledVector(dir, 0.5);
      cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      g.add(cable);
    }

    // 一层裙房
    var base = mesh(new THREE.BoxGeometry(22, 6, 16), conc);
    base.position.set(15, 3, 6);
    g.add(base);

    out.group.add(g);
    out.anim.push(function (dt, t) {
      beaconMat.color.setHex((t % 1.8) < 0.25 ? 0xff6a5a : 0x501510);
    });
    return { name: '电视塔', x: site.x, z: site.z, y: y, height: topY + 8.5 + mastH };
  }

  /* =====================================================================
   * 主入口
   * =================================================================== */
  function build(terrain) {
    var H = function (x, z) { return terrain.sample(x, z); };
    var out = { group: new THREE.Group(), anim: [], sites: [] };
    out.group.name = 'landmarks';

    var peak = findPeak(H);
    var channel = findChannel(H);
    var dam = findDam(H);

    out.sites.push(buildRadar(H, peak, out));

    // 灯塔放在离机场较远的一段海岸，视野开阔
    var lh = findCoast(H, 118) || findCoast(H, 300);
    if (lh) out.sites.push(buildLighthouse(H, lh, out));

    if (channel) {
      var br = buildBridge(H, channel, out);
      if (br) out.sites.push(br);
    }
    if (dam) out.sites.push(buildDam(H, dam, out));

    var ridge = findRidge(H, 205);
    var wf = buildWindFarm(H, ridge, out);
    if (wf) out.sites.push(wf);

    var harbor = findCoast(H, 62) || findCoast(H, 340);
    if (harbor) out.sites.push(buildHarbor(H, harbor, out));

    /* ---------------- 公路网 ----------------
       把机场、城镇、港口、大坝、风电场串起来。空中看这些路网是最直观的
       目视导航参照；路面本身也顺带把"世界是被设计过的"这件事说清楚了。
       城镇坐标与 world.js 里的 cityX/cityZ 保持一致。 */
    var V = function (x, z) { return new THREE.Vector3(x, 0, z); };
    var AIRPORT = V(175, -60);
    var CITY = V(1800, -1500);
    var routes = [];
    routes.push([AIRPORT, V(700, -560), V(1280, -1080), CITY,
      V(2760, -1980), harbor ? V(harbor.x, harbor.z) : V(3200, -2300)]);
    if (dam) {
      routes.push([V(60, 320), V(-180, 1180), V(-460, 1980),
        V(dam.x, dam.z), V(dam.x - 900, dam.z + 500)]);
    }
    if (wf) {
      routes.push([V(-120, 260), V(-820, 900), V(-1180, 1600),
        V(wf.x, wf.z), V(wf.x - 700, wf.z + 900)]);
    }
    routes.push([CITY, V(2300, -1000), V(2600, -300), V(2500, 600), V(2000, 1300)]);
    var roadTotal = 0;
    for (var ri = 0; ri < routes.length; ri++) {
      var r = buildRoad(H, routes[ri], out, { width: 11 });
      roadTotal += r.length;
    }
    out.sites.push({ name: '公路网', x: AIRPORT.x, z: AIRPORT.z, y: H(AIRPORT.x, AIRPORT.z), km: roadTotal / 1000 });

    /* ---------------- 高压输电线路 ----------------
       从水电站（大坝）拉一条线到城镇，横穿半个岛。 */
    if (dam) {
      var pl = buildPowerLine(H, [
        V(dam.x + 120, dam.z - 180), V(-200, 1500), V(400, 200), V(1150, -820), CITY
      ], out);
      if (pl) out.sites.push(pl);
    }

    /* ---------------- 电视塔 ----------------
       放在城镇附近的一处山头上，塔尖是明显的目视地标。 */
    var tvHill = findRidge(H, 22);
    if (tvHill && tvHill.h > 60) {
      var tv = buildTvTower(H, tvHill, out);
      out.sites.push(tv);
    }

    return out;
  }

  return {
    build: build,
    findPeak: findPeak,
    findChannel: findChannel,
    findDam: findDam,
    findCoast: findCoast,
    findRidge: findRidge,
    buildRoad: buildRoad,
    buildPowerLine: buildPowerLine,
    buildTvTower: buildTvTower
  };
});
