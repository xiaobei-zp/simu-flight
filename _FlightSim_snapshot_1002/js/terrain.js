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

  /* ---- 顶点色：按高度 + 坡度着色 ---- */
  var SAND  = [0.80, 0.72, 0.51];
  var GRASS = [0.26, 0.44, 0.19];
  var GRASS2= [0.37, 0.53, 0.22];
  var ROCK  = [0.41, 0.39, 0.36];
  var SNOW  = [0.93, 0.95, 0.98];
  var DEEP  = [0.05, 0.13, 0.19];

  function mix3(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
  }

  Terrain.prototype.buildColors = function () {
    var n = this.n, cell = this.cell, H = this.heights, C = this.colors;
    var tmp = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
    var self = this;
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

        // 草地 → 岩石 → 雪
        mix3(a, GRASS, GRASS2, smoothstep(6, 90, h));
        mix3(b, a, ROCK, smoothstep(165, 275, h));
        mix3(tmp, b, SNOW, smoothstep(305, 400, h));
        // 低地沙岸
        mix3(a, SAND, tmp, smoothstep(2.5, 16, h));
        // 陡坡露岩
        mix3(tmp, a, ROCK, smoothstep(0.45, 0.85, slope));
        // 水下变暗
        mix3(tmp, tmp, DEEP, smoothstep(0, -28, h));

        // 细微色差，避免大片纯色
        var v = 0.90 + 0.20 * vnoise(ix * 0.37 + self.seed * 0.001, iz * 0.37);
        C[i * 3]     = clamp(tmp[0] * v, 0, 1);
        C[i * 3 + 1] = clamp(tmp[1] * v, 0, 1);
        C[i * 3 + 2] = clamp(tmp[2] * v, 0, 1);
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
