/* =========================================================================
 * hud.js — 平显（Canvas 2D 叠加层）
 * 绘制：俯仰梯 / 天地线 / 坡度指示 / 机头符号 / 速度矢量 / 速度带 /
 *       高度带 / 罗盘带 / 状态读数 / 告警
 * ========================================================================= */
(function (root, factory) {
  var api = factory();
  root.SimHUD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FG = '#7dffa0';
  var FG_DIM = 'rgba(125,255,160,0.40)';
  var FG_FAINT = 'rgba(125,255,160,0.20)';
  var WARN = '#ff5b4a';
  var AMBER = '#ffc44d';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function glow(ctx, on) {
    ctx.shadowColor = on ? 'rgba(125,255,160,0.85)' : 'transparent';
    ctx.shadowBlur = on ? 8 : 0;
  }

  function txt(ctx, s, x, y, align, size, color, bold) {
    ctx.font = (bold ? 'bold ' : '') + size + 'px "Consolas","DejaVu Sans Mono",monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color || FG;
    ctx.fillText(s, x, y);
  }

  /* ---------------- 俯仰梯 + 天地线 ---------------- */
  function drawPitchLadder(ctx, cx, cy, pitch, ppd, W, H) {
    var halfW = Math.min(210, W * 0.22);
    var gap = 58;
    var start = Math.floor((pitch - 34) / 5) * 5;
    var end = Math.ceil((pitch + 34) / 5) * 5;

    ctx.lineWidth = 2;
    ctx.strokeStyle = FG;
    ctx.fillStyle = FG;

    for (var d = start; d <= end; d += 5) {
      var y = cy - (d - pitch) * ppd;
      if (y < cy - H * 0.42 || y > cy + H * 0.42) continue;

      var major = (d % 10 === 0);
      var len = major ? halfW : halfW * 0.55;
      if (d === 0) {
        // 天地线：中间断开，两端带向下的短须
        ctx.beginPath();
        ctx.moveTo(cx - halfW, y); ctx.lineTo(cx - gap, y);
        ctx.moveTo(cx + gap, y); ctx.lineTo(cx + halfW, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - halfW, y); ctx.lineTo(cx - halfW, y + 9);
        ctx.moveTo(cx + halfW, y); ctx.lineTo(cx + halfW, y + 9);
        ctx.stroke();
      } else {
        // 负俯仰画虚线，正俯仰画实线（真实 HUD 惯例）
        ctx.setLineDash(d < 0 ? [12, 8] : []);
        ctx.beginPath();
        ctx.moveTo(cx - len, y);
        ctx.lineTo(cx - gap, y);
        ctx.moveTo(cx + gap, y);
        ctx.lineTo(cx + len, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (major) {
          txt(ctx, String(Math.abs(d)), cx - len - 8, y, 'right', 13, FG);
          txt(ctx, String(Math.abs(d)), cx + len + 8, y, 'left', 13, FG);
        }
      }
    }
  }

  /* ---------------- 坡度指示 ---------------- */
  function drawBank(ctx, cx, cy, roll, size) {
    var r = size * 0.30;
    ctx.lineWidth = 2;
    ctx.strokeStyle = FG;
    var marks = [0, 10, 20, 30, 45, 60];
    ctx.beginPath();
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var sign = m === 0 ? [0] : [m, -m];
      for (var s = 0; s < sign.length; s++) {
        var a = (-90 + sign[s]) * Math.PI / 180;
        var x1 = cx + Math.cos(a) * r, y1 = cy + Math.sin(a) * r;
        var len = (m === 0 || m >= 30) ? 12 : 7;
        var x2 = cx + Math.cos(a) * (r + len), y2 = cy + Math.sin(a) * (r + len);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();

    // 指针（随坡度转动的三角）
    var pa = (-90 + roll) * Math.PI / 180;
    var px = cx + Math.cos(pa) * (r - 12), py = cy + Math.sin(pa) * (r - 12);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(pa + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-8, 14); ctx.lineTo(8, 14);
    ctx.closePath();
    ctx.fillStyle = FG;
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- 机头符号 ---------------- */
  function drawAircraftSymbol(ctx, cx, cy) {
    ctx.strokeStyle = FG;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx - 68, cy); ctx.lineTo(cx - 24, cy);
    ctx.moveTo(cx + 24, cy); ctx.lineTo(cx + 68, cy);
    ctx.moveTo(cx - 24, cy); ctx.lineTo(cx - 12, cy + 12);
    ctx.moveTo(cx + 24, cy); ctx.lineTo(cx + 12, cy + 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = FG;
    ctx.fill();
  }

  /* ---------------- 速度矢量（航迹符号） ---------------- */
  function drawFPM(ctx, x, y) {
    ctx.strokeStyle = FG;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.moveTo(x - 9, y); ctx.lineTo(x - 24, y);
    ctx.moveTo(x + 9, y); ctx.lineTo(x + 24, y);
    ctx.moveTo(x - 24, y); ctx.lineTo(x - 24, y - 8);
    ctx.moveTo(x + 24, y); ctx.lineTo(x + 24, y - 8);
    ctx.stroke();
  }

  /* ---------------- 速度带 ---------------- */
  function drawSpeedTape(ctx, H, cx, val, unitVal, unitLabel, stallKmh) {
    var top = H * 0.22, bot = H * 0.78, mid = (top + bot) / 2;
    var x = cx - 250;
    ctx.strokeStyle = FG_DIM; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 8, top); ctx.lineTo(x - 8, bot);
    ctx.stroke();

    var ppu = (bot - top) / 60;                       // 每单位像素
    var lo = Math.floor(val / 5) * 5 - 30, hi = val + 30;
    ctx.lineWidth = 2;
    for (var v = lo; v <= hi; v += 5) {
      if (v < 0) continue;
      var y = mid - (v - val) * ppu;
      if (y < top || y > bot) continue;
      var major = (v % 20 === 0);
      ctx.strokeStyle = major ? FG : FG_DIM;
      ctx.beginPath();
      ctx.moveTo(x - 8, y); ctx.lineTo(x - 8 + (major ? 14 : 8), y); ctx.stroke();
      if (major) txt(ctx, String(v), x - 16, y, 'right', 12, FG_DIM);
    }

    // 当前值框
    var bw = 72, bh = 30;
    ctx.fillStyle = 'rgba(0,20,10,0.72)';
    ctx.fillRect(x - 8, mid - bh / 2, bw, bh);
    ctx.strokeStyle = FG; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.rect(x - 8, mid - bh / 2, bw, bh);
    ctx.stroke();
    // 读数（km/h）
    txt(ctx, String(Math.round(val)), x + bw / 2 - 8, mid, 'center', 21, FG, true);
    txt(ctx, 'km/h', x + bw / 2 - 8, mid + 22, 'center', 11, FG_DIM);
    txt(ctx, unitVal + ' ' + unitLabel, x - 16, mid + 24, 'right', 11, FG_DIM);
    txt(ctx, '空速', x - 16, mid - 26, 'right', 11, FG_DIM);
    // 失速速度标记
    if (stallKmh > 0) {
      var ys = mid - (stallKmh - val) * ppu;
      if (ys > top && ys < bot) {
        ctx.strokeStyle = WARN; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x - 8, ys); ctx.lineTo(x + 10, ys); ctx.stroke();
      }
    }
  }

  /* ---------------- 高度带 ---------------- */
  function drawAltTape(ctx, H, cx, val, radarAlt, vs) {
    var top = H * 0.22, bot = H * 0.78, mid = (top + bot) / 2;
    var x = cx + 250;
    ctx.strokeStyle = FG_DIM; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 8, top); ctx.lineTo(x + 8, bot);
    ctx.stroke();

    var step = val > 2000 ? 100 : (val > 500 ? 50 : 20);
    var ppu = (bot - top) / (step * 7);
    var lo = Math.floor(val / step) * step - step * 4;
    ctx.lineWidth = 2;
    for (var v = lo; v <= val + step * 4; v += step) {
      var y = mid - (v - val) * ppu;
      if (y < top || y > bot) continue;
      ctx.strokeStyle = FG;
      ctx.beginPath();
      ctx.moveTo(x + 8, y); ctx.lineTo(x + 20, y); ctx.stroke();
      txt(ctx, String(v), x + 26, y, 'left', 12, FG_DIM);
    }

    var bw = 86, bh = 30;
    ctx.fillStyle = 'rgba(0,20,10,0.72)';
    ctx.fillRect(x + 8, mid - bh / 2, bw, bh);
    ctx.strokeStyle = FG; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.rect(x + 8, mid - bh / 2, bw, bh); ctx.stroke();
    txt(ctx, String(Math.round(val)), x + 8 + bw / 2, mid, 'center', 21, FG, true);
    txt(ctx, 'm 海拔', x + 26, mid - 26, 'left', 11, FG_DIM);

    // 无线电高度
    if (radarAlt < 300) {
      txt(ctx, 'RA ' + Math.round(radarAlt) + ' m', x + 8 + bw + 10, mid + 26, 'left', 13, AMBER, true);
    }
    // 升降速度
    var vsTxt = (vs >= 0 ? '+' : '') + vs.toFixed(1) + ' m/s';
    txt(ctx, vsTxt, x + 8 + bw + 10, mid, 'left', 14,
      Math.abs(vs) > 15 ? AMBER : FG_DIM, true);
  }

  /* ---------------- 罗盘带 ---------------- */
  function drawCompass(ctx, W, H, hdg) {
    var y = H * 0.845, cx = W / 2, halfW = Math.min(300, W * 0.30);
    var ppd = halfW / 50;
    ctx.strokeStyle = FG_DIM; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - halfW, y + 12); ctx.lineTo(cx + halfW, y + 12); ctx.stroke();

    for (var d = -60; d <= 60; d += 5) {
      var a = (Math.round(hdg / 5) * 5 + d + 720) % 360;
      var x = cx + d * ppd;
      var major = (a % 30 === 0);
      ctx.strokeStyle = major ? FG : FG_DIM;
      ctx.lineWidth = major ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + 12); ctx.lineTo(x, y + 12 - (major ? 10 : 6));
      ctx.stroke();
      if (major) {
        var lbl = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a);
        txt(ctx, lbl, x, y + 26, 'center', 13, a % 90 === 0 ? FG : FG_DIM, a % 90 === 0);
      }
    }
    // 中心读数
    txt(ctx, pad2(Math.round(hdg / 10) * 10 % 360) + '°', cx, y - 12, 'center', 17, FG, true);
    // 指针
    ctx.beginPath();
    ctx.moveTo(cx, y + 12); ctx.lineTo(cx - 7, y + 22); ctx.lineTo(cx + 7, y + 22);
    ctx.closePath(); ctx.fillStyle = FG; ctx.fill();
  }

  /* ---------------- 状态块 ---------------- */
  function drawStatus(ctx, d) {
    var x = 22, y = 24, lh = 19;
    ctx.fillStyle = 'rgba(0,16,8,0.42)';
    ctx.fillRect(x - 10, y - 14, 232, lh * 10 + 24);
    ctx.strokeStyle = FG_FAINT; ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 10, y - 14, 232, lh * 10 + 24);

    txt(ctx, '油门', x, y, 'left', 13, FG_DIM);
    // 油门条
    ctx.fillStyle = FG_FAINT;
    ctx.fillRect(x + 52, y - 6, 150, 12);
    ctx.fillStyle = d.throttle > 0.95 ? AMBER : FG;
    ctx.fillRect(x + 52, y - 6, 150 * d.throttle, 12);
    txt(ctx, Math.round(d.throttle * 100) + '%', x + 208, y, 'left', 13, FG);

    y += lh;
    txt(ctx, '转速', x, y, 'left', 13, FG_DIM);
    txt(ctx, Math.round(d.rpm) + ' rpm', x + 62, y, 'left', 13, FG);
    y += lh;
    txt(ctx, '襟翼', x, y, 'left', 13, FG_DIM);
    txt(ctx, d.flaps < 0.1 ? '收起' : (d.flaps < 0.75 ? '半放' : '全放'),
      x + 62, y, 'left', 13, d.flaps > 0.1 ? AMBER : FG);
    txt(ctx, '起落架', x + 120, y, 'left', 13, FG_DIM);
    txt(ctx, d.gearPos > 0.95 ? '放下' : (d.gearPos < 0.05 ? '收起' : '收放中'),
      x + 178, y, 'left', 13, d.gearPos < 0.95 ? AMBER : FG);

    y += lh;
    txt(ctx, '过载', x, y, 'left', 13, FG_DIM);
    txt(ctx, d.gForce.toFixed(2) + ' G', x + 62, y, 'left', 13,
      Math.abs(d.gForce) > 4.5 ? WARN : (Math.abs(d.gForce) > 3 ? AMBER : FG), true);
    y += lh;
    txt(ctx, '迎角', x, y, 'left', 13, FG_DIM);
    txt(ctx, d.alphaDeg.toFixed(1) + '°', x + 62, y, 'left', 13, d.stall ? WARN : FG);
    txt(ctx, '侧滑', x + 120, y, 'left', 13, FG_DIM);
    txt(ctx, d.betaDeg.toFixed(1) + '°', x + 178, y, 'left', 13, FG);

    y += lh;
    txt(ctx, '马赫', x, y, 'left', 13, FG_DIM);
    txt(ctx, d.mach.toFixed(3), x + 62, y, 'left', 13, FG);
    txt(ctx, '地速', x + 120, y, 'left', 13, FG_DIM);
    txt(ctx, (d.gs * 3.6).toFixed(0) + ' km/h', x + 178, y, 'left', 13, FG);

    y += lh;
    if (d.windSpeed > 0.5) {
      txt(ctx, '风', x, y, 'left', 13, FG_DIM);
      txt(ctx, pad2(Math.round(d.windFromDeg / 10) * 10 % 360) + '° / ' +
        d.windSpeed.toFixed(0) + ' m/s', x + 62, y, 'left', 13, FG);
      txt(ctx, '偏流', x + 120, y, 'left', 13, FG_DIM);
      txt(ctx, (d.driftDeg >= 0 ? '+' : '') + d.driftDeg.toFixed(0) + '°',
        x + 178, y, 'left', 13, Math.abs(d.driftDeg) > 12 ? AMBER : FG);
    } else {
      txt(ctx, '风', x, y, 'left', 13, FG_DIM);
      txt(ctx, '无风', x + 62, y, 'left', 13, FG_DIM);
    }

    y += lh * 1.2;
    txt(ctx, '时刻', x, y, 'left', 12, FG_DIM);
    txt(ctx, (d.timeLabel || '--:--') + '  ' + (d.phase || ''), x + 52, y, 'left', 12,
      (d.night > 0.35 ? AMBER : FG));
    y += lh;
    txt(ctx, '位置 ' + d.posX.toFixed(0) + ' , ' + d.posZ.toFixed(0), x, y, 'left', 12, FG_DIM);
    y += lh;
    txt(ctx, '距场 ' + (Math.hypot(d.posX, d.posZ) / 1000).toFixed(2) + ' km', x, y, 'left', 12, FG_DIM);
  }

  /* ---------------- 告警 ---------------- */
  function drawWarnings(ctx, W, H, d, time) {
    var list = [];
    if (d.stall) list.push(['失速 STALL', WARN]);
    if (d.terrainWarn) list.push(['近地告警 PULL UP', WARN]);
    if (d.overspeed) list.push(['超速 OVERSPEED', WARN]);
    if (!d.onGround && d.gearPos < 0.9 && d.radarAlt < 400) list.push(['起落架 GEAR', AMBER]);
    if (d.outOfBounds) list.push(['偏离空域', AMBER]);
    if (!list.length) return;
    var blink = (Math.floor(time * 4) % 2) === 0;
    for (var i = 0; i < list.length; i++) {
      var y = H * 0.145 + i * 32;
      var on = blink || list[i][1] === AMBER;
      txt(ctx, list[i][0], W / 2, y, 'center', 22, on ? list[i][1] : 'rgba(255,91,74,0.25)', true);
    }
  }

  /* ---------------- 航路点指示 ---------------- */
  function drawWaypoint(ctx, W, H, wp) {
    if (!wp || !wp.visible) return;
    var col = wp.color || FG;
    var x, y;
    if (wp.onScreen) {
      x = wp.x; y = wp.y;
      ctx.strokeStyle = col; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y - 15); ctx.lineTo(x + 15, y);
      ctx.lineTo(x, y + 15); ctx.lineTo(x - 15, y);
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
    } else {
      x = wp.edgeX; y = wp.edgeY;
      var ang = Math.atan2(y - H / 2, x - W / 2);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(20, 0); ctx.lineTo(-13, -12); ctx.lineTo(-5, 0); ctx.lineTo(-13, 12);
      ctx.closePath(); ctx.fillStyle = col; ctx.fill();
      ctx.restore();
    }
    txt(ctx, (wp.dist / 1000).toFixed(2) + ' km', x, y + 31, 'center', 13, col, true);
    if (wp.label) txt(ctx, wp.label, x, y - 31, 'center', 14, col, true);
  }

  /* ---------------- 任务读数 ---------------- */
  function drawObjective(ctx, W, H, ob) {
    if (!ob) return;
    var lines = ob.lines || [];
    var w = 310, lh = 21, h = 30 + lines.length * lh;
    var x = W / 2 - w / 2, y = 12;
    ctx.fillStyle = 'rgba(0,16,8,0.55)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = ob.accent || FG_FAINT;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    txt(ctx, ob.title, W / 2, y + 16, 'center', 14, ob.accent || FG, true);
    for (var i = 0; i < lines.length; i++) {
      txt(ctx, lines[i], W / 2, y + 34 + i * lh, 'center', 13, FG_DIM);
    }
  }

  /* =====================================================================
   * 主绘制入口
   * =================================================================== */
  function draw(ctx, W, H, d) {
    ctx.clearRect(0, 0, W, H);
    if (!d || d.hidden) return;

    var cx = W / 2, cy = H * 0.46;
    var ppd = H / 58;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    glow(ctx, true);

    // 随坡度旋转的俯仰梯
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(d.rollDeg * Math.PI / 180);
    ctx.translate(-cx, -cy);
    drawPitchLadder(ctx, cx, cy, d.pitchDeg, ppd, W, H);
    ctx.restore();

    drawBank(ctx, cx, cy, d.rollDeg, Math.min(W, H));
    drawAircraftSymbol(ctx, cx, cy);

    if (d.fpm && d.fpm.visible) drawFPM(ctx, d.fpm.x, d.fpm.y);

    drawSpeedTape(ctx, H, cx, d.ias * 3.6, d.ias.toFixed(0), 'm/s', d.stallKmh);
    drawAltTape(ctx, H, cx, d.alt, d.radarAlt, d.vs);
    drawCompass(ctx, W, H, d.headingDeg);
    drawStatus(ctx, d);
    drawWaypoint(ctx, W, H, d.waypoint);
    drawObjective(ctx, W, H, d.objective);
    drawWarnings(ctx, W, H, d, d.time);

    glow(ctx, false);
    ctx.restore();
  }

  return { draw: draw, colors: { FG: FG, WARN: WARN, AMBER: AMBER } };
});
