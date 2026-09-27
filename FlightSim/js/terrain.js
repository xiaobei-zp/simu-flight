/* =========================================================================
 * terrain.js — 程序化地形高度场
 * 纯计算模块：不依赖 THREE / DOM，可直接在 Node 中做单元测试。
 * 对外暴露：SimTerrain.Terrain / .fbm / .vnoise / .smoothstep
 * ========================================================================= */
(function (root, factory) {
  var api = factory();
  root.SimTerrain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };

  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ---------- 确定性哈希噪声（无外部依赖、跨平台一致） ---------- */
  function hash2(x, y) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  function vnoise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi), b = hash2(xi + 1, yi);
    var c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    var ab = a + (b - a) * u;
    var cd = c + (d - c) * u;
    return ab + (cd - ab) * v;             // 0..1
  }

  function fbm(x, y, oct, lac, gain) {
    var f = 1, a = 1, s = 0, n = 0;
    for (var i = 0; i < oct; i++) {
      s += a * vnoise(x * f, y * f);
      n += a;
      a *= gain; f *= lac;
    }
    return s / n;                          // 0..1，均值约 0.5
  }

  function ridged(x, y, oct) {
    var f = 1, a = 1, s = 0, n = 0;
    for (var i = 0; i < oct; i++) {
      var v = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1);
      v *= v;
      s += a * v; n += a;
      a *= 0.5; f *= 2.07;
    }
    return s / n;                          // 0..1，山脊状
  }

  /* 点到轴对齐矩形的距离（内部为 0） */
  function rectDist(x, z, hx, hz) {
    var dx = Math.max(0, Math.abs(x) - hx);
    var dz = Math.max(0, Math.abs(z) - hz);
    return Math.sqrt(dx * dx + dz * dz);
  }

  /* =======================================================================
   * Terrain
   * ===================================================================== */
  function Terrain(opts) {
    opts = opts || {};
    this.size = opts.size || 14000;        // 世界边长（米）
    this.seg = opts.seg || 300;            // 网格分段
    this.cell = this.size / this.seg;
    this.n = this.seg + 1;
    this.half = this.size / 2;
    this.seed = (opts.seed == null ? 20240517 : opts.seed) | 0;

    this.flatHeight = (opts.flatHeight == null ? 9 : opts.flatHeight); // 机场标高
    this.flatRadius = opts.flatRadius || 700;                          // 完全平坦半径
    this.runwayHalfLen = opts.runwayHalfLen || 560;
    this.runwayHalfWid = opts.runwayHalfWid || 150;

    this.heights = new Float32Array(this.n * this.n);
    this.colors = new Float32Array(this.n * this.n * 3);

    this.minH = 0; this.maxH = 0;
    // 由 seed 偏移，保证不同种子得到不同地貌
    this.ox = (hash2(this.seed, 11) - 0.5) * 8000;
    this.oz = (hash2(this.seed, 29) - 0.5) * 8000;
  }

  /* ---- 基础地貌（未做机场平整） ----
   * 用「径向剖面 + 噪声扰动」而不是纯噪声：这样任何种子下都保证
   * 机场周围有一大片陆地平原、2~5km 处有环形山地、更远处是海。 */
  Terrain.prototype.baseHeight = function (x, z) {
    var px = x + this.ox, pz = z + this.oz;
    var r = Math.sqrt(x * x + z * z);
    // 海岸线扰动，让岛形不规则
    r += (fbm(px * 0.00042, pz * 0.00042, 3, 2.0, 0.5) - 0.5) * 2100;

    var land = 1 - smoothstep(5400, 7200, r);       // 1=陆地 0=海

    var h = this.flatHeight;
    // 环状山地：距机场 2~5km 隆起，中间留出平坦的起降区
    var ring = Math.exp(-Math.pow((r - 3700) / 1550, 2));
    if (ring > 0.002) h += ring * (70 + ridged(px * 0.00062, pz * 0.00062, 5) * 460);
    // 中尺度起伏
    h += (fbm(px * 0.0017, pz * 0.0017, 4, 2.0, 0.5) - 0.5) * 34;
    // 细节
    h += (fbm(px * 0.0092, pz * 0.0092, 3, 2.0, 0.5) - 0.5) * 6.0;

    // 出岛沉入海面
    return h * land - 160 * (1 - land);
  };

  /* ---- 最终高度：机场附近强制平整，保证绝对水平的起降场 ---- */
  Terrain.prototype.rawHeight = function (x, z) {
    var d = Math.sqrt(x * x + z * z);
    var t = smoothstep(this.flatRadius, this.flatRadius * 2.0, d);
    return this.baseHeight(x, z) * t + this.flatHeight * (1 - t);
  };

  /* ---- 分帧生成，便于显示进度条 ----
   * 用 setTimeout 而不是 requestAnimationFrame：rAF 在标签页不可见时会被暂停，
   * 会让加载在切后台时卡死。 */
  Terrain.prototype.generateChunked = function (onProgress, onDone, rowsPerChunk) {
    var self = this;
    var n = this.n, cell = this.cell, half = this.half;
    var iz = 0, step = rowsPerChunk || 14;
    var minH = Infinity, maxH = -Infinity;

    function chunk() {
      var end = Math.min(n, iz + step);
      for (; iz < end; iz++) {
        var z = -half + iz * cell;
        var base = iz * n;
        for (var ix = 0; ix < n; ix++) {
          var hh = self.rawHeight(-half + ix * cell, z);
          self.heights[base + ix] = hh;
          if (hh < minH) minH = hh;
          if (hh > maxH) maxH = hh;
        }
      }
      if (onProgress) onProgress(iz / n);
      if (iz < n) { setTimeout(chunk, 0); }
      else {
        self.minH = minH; self.maxH = maxH;
        self.buildColors();
        if (onDone) onDone();
      }
    }
    setTimeout(chunk, 0);
  };

  /* 同步生成（Node 测试用） */
  Terrain.prototype.generate = function () {
    var n = this.n, cell = this.cell, half = this.half;
    var minH = Infinity, maxH = -Infinity;
    for (var iz = 0; iz < n; iz++) {
      var z = -half + iz * cell, base = iz * n;
      for (var ix = 0; ix < n; ix++) {
        var hh = this.rawHeight(-half + ix * cell, z);
        this.heights[base + ix] = hh;
        if (hh < minH) minH = hh;
        if (hh > maxH) maxH = hh;
      }
    }
    this.minH = minH; this.maxH = maxH;
    this.buildColors();
    return this;
  };

  /* ---- 顶点色：生物群系着色 ----
   * 旧的实现是「草地→岩石→雪」三条线性渐变加一点噪声，结果就是大片纯色、
   * 像塑料。真实地表的观感主要来自四件事，这里逐个建模：
   *   1. 湿度场（低频噪声）——湿润谷地深绿、干燥山脊黄褐
   *   2. 坡度露岩，但要斑驳（坡度 × 中频噪声），不能是一条整齐的带
   *   3. 坡向——北坡背阴更湿更暗，这是最容易被忽略但最"像真的"的一条
   *   4. 雪只挂在平缓高处，陡壁挂不住雪，这是雪山真实感的关键
   * 颜色仍然是「显示空间」的，和渲染管线不做 sRGB 编码保持一致。
   * ------------------------------------------------------------------- */
  var C_DEEP   = [0.040, 0.085, 0.115];   // 深水底
  var C_SHALLOW= [0.130, 0.210, 0.205];   // 浅水底
  var C_WETSAND= [0.520, 0.470, 0.360];   // 湿沙
  var C_DRYSAND= [0.790, 0.730, 0.560];   // 干沙
  var C_GRASS_W= [0.130, 0.275, 0.095];   // 湿润草地（深绿）
  var C_GRASS_D= [0.400, 0.415, 0.185];   // 干燥草地（黄绿）
  var C_CANOPY = [0.095, 0.185, 0.080];   // 林地冠层（最暗的一档，撑开明暗层次）
  var C_SHRUB  = [0.255, 0.320, 0.170];   // 高山灌木
  var C_SOIL   = [0.400, 0.320, 0.230];   // 裸土
  var C_ROCK_W = [0.380, 0.340, 0.300];   // 暖色岩
  var C_ROCK_C = [0.320, 0.330, 0.350];   // 冷色岩
  var C_SNOW   = [0.900, 0.930, 0.975];

  /* 林地噪声：必须与 world.js 的 buildTrees 用同一个场，
     否则地面上的深绿和林木位置对不上，反而更假。 */
  function forestField(x, z) {
    return fbm(x * 0.0025, z * 0.0025, 2, 2.0, 0.5);
  }
  var FOREST_T = 0.46;                    // 与 buildTrees 的阈值一致

  function mix3(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
  }

  Terrain.prototype.buildColors = function () {
    var n = this.n, cell = this.cell, H = this.heights, C = this.colors;
    var tmp = [0, 0, 0], g = [0, 0, 0], r = [0, 0, 0];
    var ox = this.ox, oz = this.oz;

    for (var iz = 0; iz < n; iz++) {
      for (var ix = 0; ix < n; ix++) {
        var i = iz * n + ix;
        var h = H[i];
        var hl = H[iz * n + Math.max(0, ix - 1)];
        var hr = H[iz * n + Math.min(n - 1, ix + 1)];
        var hu = H[Math.max(0, iz - 1) * n + ix];
        var hd = H[Math.min(n - 1, iz + 1) * n + ix];
        var gx = (hr - hl) / (2 * cell), gz = (hd - hu) / (2 * cell);
        var slope = Math.sqrt(gx * gx + gz * gz);        // 0 平地，1 ≈ 45°
        var nl = slope || 1e-6;

        // 世界坐标（用来取噪声，保证与网格分辨率无关）
        var wx = -this.half + ix * cell + ox;
        var wz = -this.half + iz * cell + oz;

        // 四个尺度的场。
        // 低频场只用 2 个倍频——它们的波长在 400~2400m，第三次倍频的贡献
        // 全被后面的插值和平滑吃掉了，白花 30% 的生成时间。
        var moist = fbm(wx * 0.00042, wz * 0.00042, 2, 2.0, 0.5);        // 湿度（大尺度）
        var patch = fbm(wx * 0.0026, wz * 0.0026, 2, 2.0, 0.5);          // 斑块（中尺度）
        var grain = vnoise(wx * 0.035, wz * 0.035);                      // 细粒
        // 岛屿四面环海，整体偏湿，所以把湿度场往上偏
        moist = clamp((moist - 0.22) / 0.42, 0, 1);
        patch = clamp((patch - 0.28) / 0.46, 0, 1);

        // 坡向：北坡（-Z 方向）更湿更暗
        var northness = clamp(gz / nl, -1, 1);          // >0 = 朝北

        // 1) 草地：干 ↔ 湿，再按坡向偏一点
        mix3(tmp, C_GRASS_D, C_GRASS_W, clamp(moist * 0.85 + northness * 0.14 + 0.08, 0, 1));

        // 2) 林地：与 buildTrees 同一个噪声场，林区压成深绿冠层。
        //    这一条撑开了整片地表的明暗对比，是从空中看"像不像真的"的关键。
        var forest = smoothstep(FOREST_T, FOREST_T + 0.13, forestField(wx, wz));
        forest *= (1 - smoothstep(145, 215, h));        // 高处不长林
        forest *= (1 - smoothstep(0.42, 0.82, slope));  // 陡坡不长林
        forest *= (0.55 + 0.70 * patch);                // 林缘参差
        mix3(tmp, tmp, C_CANOPY, clamp(forest, 0, 1) * 0.82);

        // 3) 海拔抬升：草地 → 灌木 → 裸土 → 岩石
        mix3(g, tmp, C_SHRUB, smoothstep(85, 165, h));
        mix3(g, g, C_SOIL, smoothstep(150, 245, h));
        // 岩性冷暖由斑块决定，避免整座山一个颜色
        mix3(r, C_ROCK_W, C_ROCK_C, patch);
        mix3(g, g, r, smoothstep(215, 330, h));

        // 3) 坡度露岩：带斑块，边缘参差
        var rockAmt = smoothstep(0.34, 0.80, slope) * (0.45 + 0.80 * patch);
        mix3(g, g, r, clamp(rockAmt, 0, 1));

        // 4) 雪：高、缓、且成片。陡壁挂不住雪 —— 少这一条雪山就很假。
        //    雪线必须按本岛的实际高差来定：全岛最高才 520m，原来写成
        //    295~385m 等于把 330m 以上的山全刷白，远看就是一大块白斑。
        //    改成 330~430m，只有最高的那批山头戴雪帽，中间是过渡带。
        var snowAmt = smoothstep(330, 430, h)
          * (1 - smoothstep(0.40, 0.95, slope))
          * (0.55 + 0.70 * patch);
        // 阴坡积雪线更低
        snowAmt *= (1 + 0.22 * northness);
        mix3(g, g, C_SNOW, clamp(snowAmt, 0, 1));

        // 5) 海岸：沙滩宽度随噪声变化
        var beachTop = 3.0 + 4.5 * patch;
        var beach = 1 - smoothstep(0.5, beachTop, h);
        mix3(r, C_WETSAND, C_DRYSAND, clamp(h / Math.max(1, beachTop), 0, 1));
        mix3(g, g, r, beach);

        // 6) 水下：浅水底 → 深水底
        mix3(g, g, C_SHALLOW, smoothstep(0, -8, h));
        mix3(g, g, C_DEEP, smoothstep(-8, -34, h));

        // 7) 多尺度明暗：斑块给大起伏，细粒给"颗粒感"
        var v = (0.88 + 0.22 * patch) * (0.955 + 0.090 * grain);
        // 朝北背阴再压一点
        v *= (1 - 0.06 * northness);

        C[i * 3]     = clamp(g[0] * v, 0, 1);
        C[i * 3 + 1] = clamp(g[1] * v, 0, 1);
        C[i * 3 + 2] = clamp(g[2] * v, 0, 1);
      }
    }
  };

  /* ---- 双线性采样：与渲染网格严格一致，保证起降不穿模 ---- */
  Terrain.prototype.sample = function (x, z) {
    var n = this.n, cell = this.cell, half = this.half;
    var gx = (x + half) / cell, gz = (z + half) / cell;
    gx = clamp(gx, 0, n - 1.0001);
    gz = clamp(gz, 0, n - 1.0001);
    var ix = gx | 0, iz = gz | 0;
    var fx = gx - ix, fz = gz - iz;
    var H = this.heights;
    var i0 = iz * n + ix, i1 = i0 + n;
    var p = H[i0] + (H[i0 + 1] - H[i0]) * fx;
    var q = H[i1] + (H[i1 + 1] - H[i1]) * fx;
    return p + (q - p) * fz;
  };

  /* 地表法线（有限差分） */
  Terrain.prototype.normal = function (x, z, out) {
    var d = this.cell;
    var hx = this.sample(x + d, z) - this.sample(x - d, z);
    var hz = this.sample(x, z + d) - this.sample(x, z - d);
    var nx = -hx, ny = 2 * d, nz = -hz;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out = out || { x: 0, y: 1, z: 0 };
    out.x = nx / len; out.y = ny / len; out.z = nz / len;
    return out;
  };

  Terrain.prototype.inBounds = function (x, z) {
    var h = this.half - 20;
    return x > -h && x < h && z > -h && z < h;
  };

  return {
    Terrain: Terrain,
    vnoise: vnoise,
    fbm: fbm,
    ridged: ridged,
    smoothstep: smoothstep,
    clamp: clamp,
    rectDist: rectDist
  };
});
