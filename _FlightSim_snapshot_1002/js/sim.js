/* =========================================================================
 * sim.js — 主程序：渲染循环 / 输入 / 相机 / 音效 / UI
 * ========================================================================= */
(function () {
  'use strict';

  var THREE = window.THREE;
  var SimTerrain = window.SimTerrain;
  var SimWorld = window.SimWorld;
  var SimAircraft = window.SimAircraft;
  var SimPhysics = window.SimPhysics;
  var SimHUD = window.SimHUD;
  var SimEnv = window.SimEnv;

  var FIXED = 1 / 200;
  var R2D = 180 / Math.PI;

  /* ------------------------------------------------------------------ */
  /* 全局状态                                                            */
  /* ------------------------------------------------------------------ */
  var G = {
    renderer: null, scene: null, camera: null, world: null, terrain: null,
    model: null, plane: null, hudCtx: null,
    running: false, paused: false, crashed: false, crashTime: 0,
    camMode: 0, camNames: ['追尾', '座舱', '环绕', '塔台'],
    showHUD: true, quality: 'medium', invertPitch: false, airStart: false,
    mode: 'free',                 // free | rings | landing
    challenge: null,
    prevPos: null,
    windKey: 'calm',
    hour: 12.5,                   // 时刻（0..24）
    resultShown: false,
    time: 0, last: 0, acc: 0,
    shake: 0, muted: false,
    orbit: { theta: 2.4, phi: 0.35, dist: 26, dragging: false, lx: 0, ly: 0 },
    look: { x: 0, y: 0 },
    keys: {}, gamepad: null,
    audio: null,
    smoke: null,
    dust: []
  };

  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion(), _e1 = new THREE.Euler();
  var _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return 1 - Math.exp(-t); }

  /* ================================================================== */
  /* 输入                                                                */
  /* ================================================================== */
  function bindInput() {
    window.addEventListener('keydown', function (e) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) >= 0) e.preventDefault();
      if (G.keys[e.code]) return;
      G.keys[e.code] = true;
      onKeyPress(e.code);
    });
    window.addEventListener('keyup', function (e) { G.keys[e.code] = false; });
    window.addEventListener('blur', function () { G.keys = {}; });

    window.addEventListener('gamepadconnected', function (e) {
      G.gamepad = e.gamepad.index;
      setHint('手柄已连接：' + e.gamepad.id.slice(0, 40));
    });
    window.addEventListener('gamepaddisconnected', function () { G.gamepad = null; });

    window.addEventListener('mouseup', function () { G.orbit.dragging = false; });
    window.addEventListener('mousemove', function (e) {
      if (G.orbit.dragging) {
        G.orbit.theta -= (e.clientX - G.orbit.lx) * 0.006;
        G.orbit.phi = clamp(G.orbit.phi + (e.clientY - G.orbit.ly) * 0.005, -1.3, 1.35);
        G.orbit.lx = e.clientX; G.orbit.ly = e.clientY;
      }
      if (G.renderer && document.pointerLockElement === G.renderer.domElement) {
        G.look.x = clamp(G.look.x - e.movementX * 0.0022, -2.4, 2.4);
        G.look.y = clamp(G.look.y - e.movementY * 0.0022, -1.2, 1.2);
      }
    });
  }

  /* 只在渲染器创建之后调用：鼠标 / 指针锁定 / 滚轮都绑定在画布上 */
  function bindCanvasInput(cv) {
    cv.addEventListener('mousedown', function (e) {
      if (G.camMode === 1 && document.pointerLockElement !== cv) {
        cv.requestPointerLock();
      } else if (G.camMode === 2) {
        G.orbit.dragging = true; G.orbit.lx = e.clientX; G.orbit.ly = e.clientY;
      }
    });
    cv.addEventListener('wheel', function (e) {
      if (G.camMode === 2) G.orbit.dist = clamp(G.orbit.dist * (1 + e.deltaY * 0.0012), 8, 160);
    }, { passive: true });
  }

  function onKeyPress(code) {
    switch (code) {
      case 'KeyC': G.camMode = (G.camMode + 1) % 4; G.look.x = G.look.y = 0;
        if (document.pointerLockElement) document.exitPointerLock();
        setHint('视角：' + G.camNames[G.camMode]); break;
      case 'KeyR': respawn(); break;
      case 'KeyP': togglePause(); break;
      case 'KeyH': toggleHelp(); break;
      case 'KeyV': G.showHUD = !G.showHUD; break;
      case 'KeyM': G.muted = !G.muted; if (G.audio) G.audio.setMute(G.muted);
        setHint(G.muted ? '静音' : '声音开'); break;
      case 'KeyG': if (!G.crashed) G.model.toggleGear(); break;
      case 'KeyF': if (!G.crashed) G.model.toggleFlaps(); break;
      case 'KeyI': G.invertPitch = !G.invertPitch;
        setHint('俯仰反转：' + (G.invertPitch ? '开' : '关')); break;
      case 'KeyK': {
        var order = ['calm', 'light', 'breezy', 'storm'];
        var i = (order.indexOf(G.windKey) + 1) % order.length;
        setWind(order[i]);
        setHint('风况：' + WIND_PRESETS[order[i]].label);
        break;
      }
      case 'KeyN': setMode(G.mode === 'rings' ? 'free' : 'rings');
        setHint(G.mode === 'rings' ? '穿环计时：按 N 返回自由飞行' : '已返回自由飞行'); break;
      case 'KeyT': {
        // 循环预设时刻；再按同一键就跳到下一个
        var ps = SimEnv.PRESETS;
        var ci = 0, best = 1e9;
        for (var pi = 0; pi < ps.length; pi++) {
          var dd = Math.abs(ps[pi].hour - G.hour);
          if (dd < best) { best = dd; ci = pi; }
        }
        setHour(ps[(ci + 1) % ps.length].hour);
        break;
      }
      case 'BracketLeft': setHour(G.hour - 0.5); break;
      case 'BracketRight': setHour(G.hour + 0.5); break;
      case 'Escape': if (document.pointerLockElement) document.exitPointerLock(); break;
    }
  }

  /* 汇总当前输入 -> 物理模型 */
  function readInput() {
    var k = G.keys;
    var up = k.ArrowUp || k.KeyW;
    var dn = k.ArrowDown || k.KeyS;
    var lf = k.ArrowLeft || k.KeyA;
    var rt = k.ArrowRight || k.KeyD;
    var yl = k.KeyQ, yr = k.KeyE;

    // 拉杆（↓/S）= 抬头
    var pitch = (dn ? 1 : 0) - (up ? 1 : 0);
    if (G.invertPitch) pitch = -pitch;
    var roll = (rt ? 1 : 0) - (lf ? 1 : 0);
    var yaw = (yr ? 1 : 0) - (yl ? 1 : 0);

    var inp = {
      pitch: pitch, roll: roll, yaw: yaw,
      throttleUp: !!(k.ShiftLeft || k.ShiftRight),
      throttleDown: !!(k.ControlLeft || k.ControlRight),
      brakes: !!k.Space
    };

    // 手柄
    if (G.gamepad != null && navigator.getGamepads) {
      var gp = navigator.getGamepads()[G.gamepad];
      if (gp) {
        var dz = function (v) { return Math.abs(v) < 0.12 ? 0 : v; };
        var ax = dz(gp.axes[0] || 0), ay = dz(gp.axes[1] || 0);
        if (ax || ay) {
          inp.roll = clamp(inp.roll + ax, -1, 1);
          var p2 = ay;                    // 手柄下推 = 拉杆抬头
          if (G.invertPitch) p2 = -p2;
          inp.pitch = clamp(inp.pitch + p2, -1, 1);
        }
        var ry = dz(gp.axes[2] || 0);
        if (ry) inp.yaw = clamp(inp.yaw + ry, -1, 1);
        if (gp.buttons[7] && gp.buttons[7].value > 0.05) inp.throttleUp = true;
        if (gp.buttons[6] && gp.buttons[6].value > 0.05) inp.throttleDown = true;
        if (gp.buttons[0] && gp.buttons[0].pressed) inp.brakes = true;
        // 边沿触发按键
        gpEdge(gp, 3, 'KeyF'); gpEdge(gp, 2, 'KeyG'); gpEdge(gp, 1, 'KeyC'); gpEdge(gp, 9, 'KeyR');
      }
    }
    return inp;
  }

  var gpPrev = {};
  function gpEdge(gp, idx, code) {
    var b = gp.buttons[idx];
    if (!b) return;
    var now = b.pressed;
    if (now && !gpPrev[idx]) onKeyPress(code);
    gpPrev[idx] = now;
  }

  /* ================================================================== */
  /* 音效（纯程序合成，无需素材）                                          */
  /* ================================================================== */
  function Audio() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    var actx = new Ctx();
    var master = actx.createGain();
    master.gain.value = 0.55;
    master.connect(actx.destination);

    // 引擎：两个锯齿波 + 低通
    var engGain = actx.createGain(); engGain.gain.value = 0;
    var lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 4;
    var o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 60;
    var o2 = actx.createOscillator(); o2.type = 'square'; o2.frequency.value = 121;
    var o2g = actx.createGain(); o2g.gain.value = 0.35;
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp);
    lp.connect(engGain); engGain.connect(master);
    o1.start(); o2.start();

    // 风噪
    var len = actx.sampleRate * 2;
    var buf = actx.createBuffer(1, len, actx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var noise = actx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    var bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.7;
    var windGain = actx.createGain(); windGain.gain.value = 0;
    noise.connect(bp); bp.connect(windGain); windGain.connect(master);
    noise.start();

    // 失速警告
    var beepOsc = actx.createOscillator(); beepOsc.type = 'square'; beepOsc.frequency.value = 980;
    var beepGain = actx.createGain(); beepGain.gain.value = 0;
    beepOsc.connect(beepGain); beepGain.connect(master); beepOsc.start();

    return {
      ctx: actx,
      resume: function () { if (actx.state === 'suspended') actx.resume(); },
      setMute: function (m) { master.gain.value = m ? 0 : 0.55; },
      update: function (m, dt, time) {
        var f = 46 + m.rpm * 0.062;
        o1.frequency.value = f;
        o2.frequency.value = f * 2.02;
        lp.frequency.value = 500 + m.throttle * 2200;
        engGain.gain.value = 0.035 + m.throttle * 0.085;
        windGain.gain.value = Math.min(0.30, m.ias / 130 * 0.30) * (m.onGround ? 0.4 : 1);
        var s = m.stall && (Math.floor(time * 5) % 2 === 0);
        beepGain.gain.value = s ? 0.035 : 0;
      },
      thud: function (power) {
        var g = actx.createGain();
        var src = actx.createBufferSource(); src.buffer = buf;
        var f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 260;
        src.connect(f); f.connect(g); g.connect(master);
        g.gain.setValueAtTime(Math.min(0.9, 0.25 + power * 0.12), actx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.45);
        src.start(); src.stop(actx.currentTime + 0.5);
      },
      boom: function () {
        var g = actx.createGain();
        var src = actx.createBufferSource(); src.buffer = buf;
        var f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
        src.connect(f); f.connect(g); g.connect(master);
        g.gain.setValueAtTime(1.0, actx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 1.6);
        src.start(); src.stop(actx.currentTime + 1.8);
      }
    };
  }

  /* ================================================================== */
  /* 爆炸效果                                                            */
  /* ================================================================== */
  function makeExplosion(pos) {
    var grp = new THREE.Group();
    var ball = new THREE.Mesh(
      new THREE.SphereGeometry(2, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0.95 })
    );
    ball.position.copy(pos);
    grp.add(ball);
    var parts = [];
    for (var i = 0; i < 26; i++) {
      var m = new THREE.Mesh(
        new THREE.SphereGeometry(0.35 + Math.random() * 0.7, 6, 5),
        new THREE.MeshBasicMaterial({
          color: [0xffcc55, 0xff7722, 0x8a8a8a][i % 3],
          transparent: true, opacity: 1
        })
      );
      m.position.copy(pos);
      var dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.7, Math.random() - 0.5).normalize();
      var sp = 6 + Math.random() * 18;
      m.userData.v = dir.multiplyScalar(sp);
      m.userData.life = 1;
      grp.add(m); parts.push(m);
    }
    G.scene.add(grp);
    G.smoke = { grp: grp, ball: ball, parts: parts, t: 0 };
    G.shake = 1.2;
    if (G.audio) G.audio.boom();
  }

  function updateExplosion(dt) {
    var s = G.smoke;
    if (!s) return;
    s.t += dt;
    var k = Math.min(1, s.t / 0.45);
    s.ball.scale.setScalar(1 + k * 7);
    s.ball.material.opacity = Math.max(0, 0.95 - k * 0.95);
    for (var i = 0; i < s.parts.length; i++) {
      var p = s.parts[i];
      p.userData.v.y -= 16 * dt;
      p.position.addScaledVector(p.userData.v, dt);
      p.userData.life -= dt * 0.6;
      p.material.opacity = Math.max(0, p.userData.life);
      p.scale.setScalar(Math.max(0.05, p.userData.life));
    }
    if (s.t > 5) { G.scene.remove(s.grp); G.smoke = null; }
  }

  /* 接地扬尘：机轮触地瞬间弹出一团随时间扩散变淡的尘雾 */
  function makeDust(pos, strength) {
    if (!G.dustTex) G.dustTex = SimWorld.makeGlowTexture();
    var n = Math.min(16, 5 + Math.round(strength * 2));
    var alpha = clamp(0.18 + strength * 0.07, 0.15, 0.55);
    for (var i = 0; i < n; i++) {
      var mat = new THREE.SpriteMaterial({
        map: G.dustTex, transparent: true, depthWrite: false,
        opacity: alpha, color: 0xcfc8ba
      });
      var s = new THREE.Sprite(mat);
      s.position.set(
        pos.x + (Math.random() - 0.5) * 4,
        pos.y + Math.random() * 0.6,
        pos.z + (Math.random() - 0.5) * 4
      );
      var sc = 1.6 + Math.random() * 2.4;
      s.scale.set(sc, sc, 1);
      s.userData.v = new THREE.Vector3(
        (Math.random() - 0.5) * 4, 0.5 + Math.random() * 1.4, (Math.random() - 0.5) * 4);
      s.userData.life = 1;
      G.scene.add(s);
      G.dust.push(s);
    }
  }

  function updateDust(dt) {
    for (var i = G.dust.length - 1; i >= 0; i--) {
      var d = G.dust[i];
      d.position.addScaledVector(d.userData.v, dt);
      d.userData.v.multiplyScalar(Math.max(0, 1 - dt * 1.7));
      d.userData.life -= dt / 1.4;
      var k = Math.max(0, d.userData.life);
      d.material.opacity = 0.5 * k * k;
      d.scale.multiplyScalar(1 + dt * 1.7);
      if (k <= 0) {
        G.scene.remove(d);
        d.material.dispose();
        G.dust.splice(i, 1);
      }
    }
  }

  /* ================================================================== */
  /* 相机                                                                */
  /* ================================================================== */
  function updateCamera(dt) {
    var m = G.model, cam = G.camera;
    var fwd = _v1.set(0, 0, -1).applyQuaternion(m.quat);

    if (G.camMode === 0) {
      // 追尾：只跟随部分俯仰/滚转，保留速度感
      _e1.setFromQuaternion(m.quat, 'YXZ');
      var fq = _q1.setFromEuler(new THREE.Euler(_e1.x * 0.55, _e1.y, _e1.z * 0.75, 'YXZ'));
      var back = _v2.set(0, 3.6, 16 + Math.min(9, m.tas * 0.12)).applyQuaternion(fq);
      var desired = _v3.copy(m.pos).add(back);
      var gh = G.terrain.sample(desired.x, desired.z);
      if (desired.y < gh + 2.5) desired.y = gh + 2.5;
      // 防止摄像机穿地
      var ghSelf = G.terrain.sample(cam.position.x, cam.position.z);
      if (cam.position.y < ghSelf + 2) cam.position.y = ghSelf + 2;

      var k = ease(dt * 7);
      cam.position.lerp(desired, k);
      _camLook.lerp(_v2.copy(m.pos).addScaledVector(fwd, 24).setY(m.pos.y + 2.2), ease(dt * 9));
      cam.up.set(0, 1, 0);
      cam.lookAt(_camLook);
      // 抖振 / 硬着陆震动
      applyShake(dt);

    } else if (G.camMode === 1) {
      // 座舱
      var eye = _v2.copy(G.plane.eye).applyQuaternion(m.quat).add(m.pos);
      cam.position.copy(eye);
      var lookQ = _q1.copy(m.quat).multiply(
        _q1.setFromEuler(new THREE.Euler(G.look.y, G.look.x, 0, 'YXZ'))
      );
      cam.quaternion.copy(lookQ);
      applyShake(dt, 0.45);

    } else if (G.camMode === 2) {
      // 环绕
      var o = G.orbit;
      var x = Math.sin(o.theta) * Math.cos(o.phi) * o.dist;
      var y = Math.sin(o.phi) * o.dist + 4;
      var z = Math.cos(o.theta) * Math.cos(o.phi) * o.dist;
      cam.position.set(m.pos.x + x, m.pos.y + y, m.pos.z + z);
      var g2 = G.terrain.sample(cam.position.x, cam.position.z);
      if (cam.position.y < g2 + 2) cam.position.y = g2 + 2;
      cam.up.set(0, 1, 0);
      cam.lookAt(m.pos);
      applyShake(dt, 0.4);

    } else {
      // 塔台
      var t = G.world.airfield;
      cam.position.set(250, G.world.flatY + 30, 120);
      cam.up.set(0, 1, 0);
      cam.lookAt(m.pos);
      applyShake(dt, 0.5);
    }

    // 速度感 FOV
    var targetFov = 62 + (G.camMode === 1 ? 4 : 0) + Math.min(14, m.tas * 0.14);
    cam.fov += (targetFov - cam.fov) * ease(dt * 3);
    cam.updateProjectionMatrix();
  }

  function applyShake(dt, scale) {
    scale = scale == null ? 1 : scale;
    var amt = G.shake + G.model.buffet * 0.35 + (G.model.onGround ? 0 : 0);
    if (amt <= 0.001) return;
    var cam = G.camera;
    var s = Math.min(1.6, amt) * 0.24 * scale;
    cam.position.x += (Math.random() - 0.5) * s;
    cam.position.y += (Math.random() - 0.5) * s;
    cam.position.z += (Math.random() - 0.5) * s;
    G.shake = Math.max(0, G.shake - dt * 2.2);
  }

  /* ================================================================== */
  /* 飞行器可视化                                                        */
  /* ================================================================== */
  function syncAircraft(dt) {
    var m = G.model, a = G.plane;
    a.group.position.copy(m.pos);
    a.group.quaternion.copy(m.quat);

    a.propeller.rotation.z = m.propAngle;
    a.propBlurMat.opacity = clamp((m.rpm - 700) / 2000, 0, 0.34);

    // 座舱视角：隐藏挡住视线的实体桨叶、座舱罩与其骨架，只保留桨盘虚影
    var inCockpit = (G.camMode === 1);
    a.propeller.visible = !inCockpit;
    a.canopy.visible = !inCockpit;
    a.canopyFrame.visible = !inCockpit;
    a.propBlurMat.opacity *= inCockpit ? 0.5 : 1;

    var s = a.surfaces;
    s.elevator.rotation.x = -m.ctl.pitch * 0.34;
    s.aileronR.rotation.x = -m.ctl.roll * 0.42;
    s.aileronL.rotation.x = m.ctl.roll * 0.42;
    s.rudder.rotation.y = m.ctl.yaw * 0.42;

    // 起落架收放
    a.gear.visible = m.gearPos > 0.02;
    a.gear.scale.set(1, Math.max(0.04, m.gearPos), 1);
    a.gear.position.y = (1 - m.gearPos) * 0.5;

    // 航行灯闪烁
    var strobe = (G.time % 1.1) < 0.07;
    a.lamps.strobe.visible = strobe;
    a.lamps.beacon.visible = (G.time % 1.6) < 0.14;
  }

  /* ================================================================== */
  /* HUD                                                                 */
  /* ================================================================== */
  function updateHUD() {
    var m = G.model;
    var ctx = G.hudCtx;
    var W = G.cssW || ctx.canvas.width, H = G.cssH || ctx.canvas.height;

    if (!G.showHUD || G.crashed) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
      return;
    }

    // 速度矢量（航迹符号）投影
    var fpm = { visible: false, x: 0, y: 0 };
    if (m.tas > 5) {
      _v1.copy(m.vel).normalize().multiplyScalar(900).add(m.pos);
      _v1.project(G.camera);
      if (_v1.z < 1) {
        fpm.visible = true;
        fpm.x = (_v1.x * 0.5 + 0.5) * W;
        fpm.y = (-_v1.y * 0.5 + 0.5) * H;
      }
    }

    // 当前构型失速速度
    var CLmax = 0.28 + 5.2 * 0.26 + m.flaps * 0.62;
    var vsMs = Math.sqrt(2 * 1150 * 9.80665 / (1.225 * 16.4 * CLmax));

    var d = {
      ias: m.ias, mach: m.mach, alt: m.pos.y, radarAlt: m.radarAlt,
      vs: m.vs, gs: m.gs,
      headingDeg: m.headingDeg, pitchDeg: m.pitchDeg, rollDeg: m.rollDeg,
      alphaDeg: m.alphaDeg, betaDeg: m.betaDeg, gForce: m.gForce,
      throttle: m.throttle, rpm: m.rpm, flaps: m.flaps, gearPos: m.gearPos,
      onGround: m.onGround, stall: m.stall, overspeed: m.overspeed,
      terrainWarn: m.terrainWarn, outOfBounds: m.outOfBounds,
      windSpeed: m.windSpeed, windFromDeg: m.windFromDeg, driftDeg: m.driftDeg,
      posX: m.pos.x, posZ: m.pos.z,
      stallKmh: vsMs * 3.6, fpm: fpm, time: G.time,
      hour: G.hour, timeLabel: SimEnv.label(G.hour), phase: SimEnv.phaseName(G.hour),
      night: G.world ? G.world.env.night : 0,
      waypoint: computeWaypoint(),
      objective: buildObjective()
    };
    G.hudData = d;
    SimHUD.draw(ctx, W, H, d);
  }

  /* ================================================================== */
  /* 挑战模式：穿环计时 / 定点着陆                                        */
  /* ================================================================== */
  var WIND_PRESETS = {
    calm:   { speed: 0,  turb: 0.00, label: '无风' },
    light:  { speed: 5,  turb: 0.12, label: '微风 5 m/s' },
    breezy: { speed: 9,  turb: 0.32, label: '有风 9 m/s' },
    storm:  { speed: 13, turb: 0.60, label: '大风 13 m/s' }
  };
  var WIND_FROM_DEG = 260;      // 风来向（正西偏南一点）

  function setWind(key) {
    var p = WIND_PRESETS[key] || WIND_PRESETS.calm;
    G.windKey = key;
    var m = G.model;
    if (!m) return;
    // 风的"来向"换算成气流运动方向：北 = -Z
    var mv = (WIND_FROM_DEG + 180) * Math.PI / 180;
    m.wind.set(Math.sin(mv) * p.speed, 0, -Math.cos(mv) * p.speed);
    m.turbulence = p.turb;
  }

  /* 设定时刻：环境配色 + 机载着陆灯亮度 */
  function setHour(hour) {
    G.hour = ((hour % 24) + 24) % 24;
    if (!G.world) return;
    var env = G.world.setTime(G.hour);
    if (G.landingLight) {
      // 天越黑灯越亮；白天完全关掉
      G.landingLight.intensity = 2.6 * clamp((G.world.env.night - 0.08) / 0.6, 0, 1);
      if (G.noseLightMat) {
        G.noseLightMat.color.setHex(G.landingLight.intensity > 0.05 ? 0xfff6d0 : 0x8a8f96);
      }
    }
    if (G.plane && G.plane.lamps) {
      G.plane.lamps.navL.visible = true;      // 航行灯常亮
      G.plane.lamps.beacon.visible = true;
    }
    return env;
  }

  function fmtTime(s) {
    if (!isFinite(s)) return '--:--';
    var mm = Math.floor(s / 60), ss = s - mm * 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1);
  }

  function bestKey(mode) { return 'flightsim.best.' + mode; }
  function loadBest(mode) {
    try { var v = parseFloat(localStorage.getItem(bestKey(mode))); return isFinite(v) ? v : null; }
    catch (e) { return null; }
  }
  function saveBest(mode, v) {
    try {
      var old = loadBest(mode);
      if (old === null || v < old) { localStorage.setItem(bestKey(mode), String(v)); return true; }
    } catch (e) { }
    return false;
  }

  function setMode(mode) {
    G.mode = mode;
    var rings = G.world ? G.world.rings : [];
    var tg = G.world ? G.world.target : null;
    var showRings = (mode === 'rings');
    var showTarget = (mode === 'landing');
    for (var i = 0; i < rings.length; i++) {
      rings[i].mesh.visible = showRings;
      rings[i].film.visible = showRings;
    }
    if (tg) { tg.mesh.visible = showTarget; tg.mast.visible = showTarget; tg.cap.visible = showTarget; }
    resetChallenge();
  }

  function resetChallenge() {
    G.resultShown = false;
    document.getElementById('result').classList.remove('show');
    if (G.mode === 'rings') {
      G.challenge = {
        mode: 'rings', idx: 0, t: 0, started: false, finished: false,
        misses: 0, best: loadBest('rings')
      };
      paintRings(true);
    } else if (G.mode === 'landing') {
      G.challenge = { mode: 'landing', t: 0, done: false, best: loadBest('landing') };
    } else {
      G.challenge = null;
    }
  }

  function paintRings(force) {
    var rings = G.world ? G.world.rings : [];
    var ch = G.challenge;
    if (!ch || ch.mode !== 'rings') return;
    for (var i = 0; i < rings.length; i++) {
      var st = (i < ch.idx) ? 2 : (i === ch.idx ? 1 : 0);
      if (rings[i]._st !== st || force) {
        rings[i]._st = st;
        SimWorld.setRingState(rings[i], st, G.time);
      } else if (st === 1) {
        SimWorld.setRingState(rings[i], 1, G.time);   // 当前环做呼吸效果
      }
    }
  }

  /* 圆环穿越判定：判断本帧位移是否穿过了圆环所在平面且在半径内 */
  function checkRings(dt) {
    var ch = G.challenge;
    if (!ch || ch.mode !== 'rings' || ch.finished || G.crashed) return;
    var rings = G.world.rings;
    var ring = rings[ch.idx];
    if (!ring) return;

    var a = G.prevPos, b = G.model.pos;
    var d0 = _v1.copy(a).sub(ring.pos).dot(ring.normal);
    var d1 = _v2.copy(b).sub(ring.pos).dot(ring.normal);
    if (d0 < 0 && d1 >= 0) {
      var t = d0 / (d0 - d1);
      _v3.copy(a).lerp(b, t).sub(ring.pos);
      var r = _v3.length();
      if (r <= ring.radius) {
        ch.idx++;
        if (a.distanceTo(b) > 0) ch.started = true;
        if (ch.idx >= rings.length) {
          ch.finished = true;
          var isBest = saveBest('rings', ch.t);
          ch.best = loadBest('rings');
          paintRings(true);
          showResult('穿 环 完 成', [
            '用时 ' + fmtTime(ch.t),
            (ch.misses ? '漏环 ' + ch.misses + ' 次' : '一次通过，零失误'),
            (isBest ? '★ 新纪录！' : '最佳 ' + fmtTime(ch.best))
          ], isBest ? '#7dffa0' : null);
          G.resultShown = true;
          if (G.audio) G.audio.thud(1);
        } else {
          paintRings(false);
          setHint('第 ' + (ch.idx) + ' 环通过 · 用时 ' + fmtTime(ch.t));
        }
      } else {
        ch.misses++;
        setHint('未穿过圆环（偏离 ' + (r - ring.radius).toFixed(0) + ' m），请绕回');
      }
    }
  }

  function checkLanding() {
    var ch = G.challenge;
    if (!ch || ch.mode !== 'landing' || ch.done || G.crashed) return;
    var m = G.model;
    if (!m.justLanded) return;
    var tg = G.world.target;
    var d = Math.hypot(m.pos.x - tg.x, m.pos.z - tg.z);
    var onRwy = Math.abs(m.pos.x) <= 23 && Math.abs(m.pos.z) <= 550;
    var scoreD = Math.max(0, 60 - d * 0.8);
    var scoreV = Math.max(0, 40 - m.landingImpact * 6);
    var score = Math.round(onRwy ? scoreD + scoreV : Math.min(35, scoreD + scoreV));
    ch.done = true;
    ch.result = { d: d, vs: m.landingImpact, score: score, onRwy: onRwy };
    var grade = score >= 90 ? '优秀 ★★★' : score >= 75 ? '良好 ★★' : score >= 55 ? '及格 ★' : '还需练习';
    var isBest = saveBest('landing', -score);   // 越大越好 -> 存负数便于复用"越小越好"
    ch.best = -loadBest('landing');
    showResult('着 陆 结 果', [
      '距靶心 ' + d.toFixed(1) + ' m ｜ 接地率 ' + m.landingImpact.toFixed(2) + ' m/s',
      (onRwy ? '落在跑道上' : '⚠ 未落在跑道上'),
      '得分 ' + score + ' / 100 ｜ ' + grade
    ], score >= 75 ? '#7dffa0' : '#ffc44d');
    G.resultShown = true;
  }

  function showResult(title, lines, color) {
    document.getElementById('resultTitle').textContent = title;
    document.getElementById('resultTitle').style.color = color || '#7dffa0';
    var body = document.getElementById('resultLines');
    body.innerHTML = '';
    for (var i = 0; i < lines.length; i++) {
      var d = document.createElement('div');
      d.textContent = lines[i];
      body.appendChild(d);
    }
    document.getElementById('result').classList.add('show');
  }

  /* 计算 HUD 航路点：下一个环 / 着陆靶心 */
  function computeWaypoint() {
    var target = null, label = null, color = null;
    if (G.mode === 'rings' && G.world && G.challenge && !G.challenge.finished) {
      var ring = G.world.rings[G.challenge.idx];
      if (ring) { target = ring.pos; label = '第 ' + (G.challenge.idx + 1) + ' 环'; color = '#7dffa0'; }
    } else if (G.mode === 'landing' && G.world && !(G.challenge && G.challenge.done)) {
      target = _v3.set(G.world.target.x, G.world.flatY + 1, G.world.target.z);
      label = '靶心'; color = '#ffa24d';
    }
    if (!target) return null;

    var cam = G.camera;
    var W = G.cssW, H = G.cssH;
    var dist = G.model.pos.distanceTo(target);
    var p = _v1.copy(target).applyMatrix4(cam.matrixWorldInverse);
    var behind = p.z > -0.1;
    var out = { visible: true, dist: dist, label: label, color: color, onScreen: false };

    if (!behind) {
      var n = _v2.copy(target).project(cam);
      if (Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1) {
        out.onScreen = true;
        out.x = (n.x * 0.5 + 0.5) * W;
        out.y = (-n.y * 0.5 + 0.5) * H;
        return out;
      }
    }
    // 屏幕外：沿相机空间方向放到画面边缘
    var dx = p.x, dy = p.y;
    if (behind) { dx = -dx; dy = -dy; }
    var len = Math.hypot(dx, dy);
    if (len < 1e-4) { dx = 0; dy = 1; len = 1; }
    var ux = dx / len, uy = dy / len;
    var mx = W / 2 - 78, my = H / 2 - 78;
    var t = Math.min(mx / Math.max(1e-4, Math.abs(ux)), my / Math.max(1e-4, Math.abs(uy)));
    out.edgeX = W / 2 + ux * t;
    out.edgeY = H / 2 - uy * t;
    return out;
  }

  function buildObjective() {
    var ch = G.challenge;
    if (!ch) return null;
    if (ch.mode === 'rings') {
      var total = G.world.rings.length;
      if (ch.finished) {
        return { title: '穿环计时 · 完成', accent: '#7dffa0',
          lines: ['用时 ' + fmtTime(ch.t), '最佳 ' + fmtTime(ch.best)] };
      }
      return { title: '穿环计时', accent: '#7dffa0', lines: [
        '第 ' + (ch.idx + 1) + ' / ' + total + ' 环',
        '用时 ' + (ch.started ? fmtTime(ch.t) : '等待起飞'),
        '最佳 ' + (ch.best != null ? fmtTime(ch.best) : '暂无记录')
      ] };
    }
    if (ch.mode === 'landing') {
      var tg = G.world.target;
      var d = Math.hypot(G.model.pos.x - tg.x, G.model.pos.z - tg.z);
      return { title: '定点着陆', accent: '#ffa24d', lines: [
        ch.done ? ('得分 ' + ch.result.score + ' / 100') : '对准跑道靶心接地',
        '距靶心 ' + d.toFixed(0) + ' m',
        ch.done ? ('距靶心 ' + ch.result.d.toFixed(1) + ' m ｜ ' + ch.result.vs.toFixed(2) + ' m/s')
                : ('最佳得分 ' + (ch.best != null && ch.best > 0 ? ch.best : '暂无记录'))
      ] };
    }
    return null;
  }

  /* ================================================================== */
  /* 翼尖涡流 + 座舱仪表板                                                */
  /* ================================================================== */
  var panelAcc = 0;

  function updateVortex(dt) {
    var m = G.model, a = G.plane;
    var g = Math.abs(m.gForce);
    // 2G 以上或迎角超过 10° 才拉出涡流：大坡度盘旋、筋斗、失速时最明显
    var strength = clamp((g - 2.0) / 2.2, 0, 1) + clamp((m.alphaDeg - 10) / 8, 0, 1);
    strength = clamp(strength, 0, 1);
    var emit = !m.onGround && m.ias > 22 && strength > 0.04 && G.camMode !== 1 && !G.crashed;

    _v1.copy(a.tipL).applyQuaternion(m.quat).add(m.pos);
    a.trails.left.update(dt, G.camera.position, _v1, emit, strength);
    _v2.copy(a.tipR).applyQuaternion(m.quat).add(m.pos);
    a.trails.right.update(dt, G.camera.position, _v2, emit, strength);
  }

  function updatePanel(dt) {
    var a = G.plane;
    var on = (G.camMode === 1) && !G.crashed;
    a.panel.mesh.visible = on;
    if (!on) return;
    panelAcc += dt;
    if (panelAcc < 1 / 28) return;
    panelAcc = 0;
    SimAircraft.drawPanel(a.panel, G.model);
  }

  /* ================================================================== */
  /* AI 交通：两架飞机在机场左航线绕场                                  */
  /* ================================================================== */
  var AI_ROUTE = [
    { x: 0, z: -1500, y: 420 },
    { x: -1300, z: -1500, y: 420 },
    { x: -2000, z: -300, y: 420 },
    { x: -1700, z: 1100, y: 400 },
    { x: -800, z: 1900, y: 360 },
    { x: 0, z: 1250, y: 260 },
    { x: 0, z: 200, y: 240 },
    { x: 0, z: -700, y: 320 }
  ];
  var AI_CLEAR = 220;      // 航线相对地形的最小净空

  function createTraffic() {
    G.traffic = [];
    // 按地形抬高航线，保证不会撞山
    for (var q = 0; q < AI_ROUTE.length; q++) {
      var lo = G.terrain.sample(AI_ROUTE[q].x, AI_ROUTE[q].z) + AI_CLEAR;
      if (AI_ROUTE[q].y < lo) AI_ROUTE[q].y = lo;
    }
    for (var i = 0; i < 2; i++) {
      var plane = SimAircraft.build({ simple: true });
      G.scene.add(plane.group);
      var model = new SimPhysics.FlightModel();
      // 两架错开半个航线，一前一后
      var wp = Math.round(i * AI_ROUTE.length / 2);
      var start = AI_ROUTE[(wp + 5) % AI_ROUTE.length];
      var hdg = (i === 0) ? 350 : 170;
      model.reset(start.x, start.z, hdg, G.terrain);
      model.pos.y = start.y;
      model.quat.setFromEuler(new THREE.Euler(0, -hdg * Math.PI / 180, 0, 'YXZ'));
      var hr = hdg * Math.PI / 180;
      model.vel.set(Math.sin(hr) * 56, 0, -Math.cos(hr) * 56);
      model.onGround = false;
      model.throttleCmd = 0.62; model.throttle = 0.62;
      model.gearCmd = false; model.gearPos = 0;
      G.traffic.push({
        plane: plane, model: model, wp: wp, vTarget: 56,
        callsign: i === 0 ? 'TRAFFIC-1' : 'TRAFFIC-2'
      });
    }
  }

  /* AI 飞行员控制律与已验证的自动驾驶一致：
     航迹误差 -> 目标坡度 -> 压杆；高度误差 -> 目标升降率 -> 杆量。
     杆量上限 0.55 对应迎角约 0.19 rad，安全低于 0.26 的失速迎角——
     这一步很关键：早期版本没有上限，高度差一大就满拉杆直接拉失速。 */
  function aiInput(ai) {
    var m = ai.model;
    var t = AI_ROUTE[ai.wp];
    var dx = t.x - m.pos.x, dz = t.z - m.pos.z;
    if (Math.hypot(dx, dz) < 300) {
      ai.wp = (ai.wp + 1) % AI_ROUTE.length;
      t = AI_ROUTE[ai.wp];
      dx = t.x - m.pos.x; dz = t.z - m.pos.z;
    }
    var bearing = ((Math.atan2(dx, -dz) * R2D) + 360) % 360;
    var trk = ((Math.atan2(m.vel.x, -m.vel.z) * R2D) + 360) % 360;
    var err = ((bearing - trk + 540) % 360) - 180;

    var bankT = clamp(err * 1.3, -25, 25);
    var targetVs = clamp((t.y - m.pos.y) * 0.30, -6, 6);
    return {
      pitch: clamp((targetVs - m.vs) * 0.10, -0.65, 0.55),
      roll: clamp((bankT - m.rollDeg) * 0.06, -1, 1),
      yaw: clamp(m.betaDeg * 0.06, -1, 1),
      throttleUp: m.tas < ai.vTarget - 3,
      throttleDown: m.tas > ai.vTarget + 3
    };
  }

  function syncTraffic(dt) {
    if (!G.traffic) return;
    for (var i = 0; i < G.traffic.length; i++) {
      var ai = G.traffic[i];
      var m = ai.model, a = ai.plane;
      a.group.position.copy(m.pos);
      a.group.quaternion.copy(m.quat);
      a.propeller.rotation.z = m.propAngle;
      a.propBlurMat.opacity = clamp((m.rpm - 700) / 2000, 0, 0.30);
      a.surfaces.elevator.rotation.x = -m.ctl.pitch * 0.34;
      a.surfaces.aileronR.rotation.x = -m.ctl.roll * 0.42;
      a.surfaces.aileronL.rotation.x = m.ctl.roll * 0.42;
      a.surfaces.rudder.rotation.y = m.ctl.yaw * 0.42;
      a.gear.visible = m.gearPos > 0.02;
      // 夜间打开航行灯与频闪
      var night = G.world.env.night;
      a.lamps.strobe.visible = night > 0.3 ? ((G.time % 1.1) < 0.09) : ((G.time % 1.1) < 0.05);
    }
  }

  /* ================================================================== */
  /* UI 辅助                                                             */
  /* ================================================================== */
  var hintTimer = 0;
  function setHint(s) {
    var el = document.getElementById('hint');
    el.textContent = s;
    el.style.opacity = '1';
    hintTimer = 2.2;
  }

  function togglePause() {
    if (document.getElementById('help').classList.contains('show')) { toggleHelp(); return; }
    G.paused = !G.paused;
    document.getElementById('paused').classList.toggle('show', G.paused);
  }

  /* 打开帮助时自动暂停，否则玩家看说明的工夫飞机就撞地了 */
  function toggleHelp() {
    var h = document.getElementById('help');
    h.classList.toggle('show');
    G.paused = h.classList.contains('show');
    document.getElementById('paused').classList.remove('show');
  }

  function respawn() {
    var m = G.model;
    if (G.airStart) {
      // 空中起始：机场西北 1.3km，420m 高，航向 020，已巡航速度
      var x = -450, z = 1250, hdg = 20, spd = 62;
      var gh = G.terrain.sample(x, z);
      m.reset(x, z, hdg, G.terrain);
      var hr = hdg * Math.PI / 180;
      m.pos.set(x, gh + 420, z);
      m.quat.setFromEuler(new THREE.Euler(0, -hr, 0, 'YXZ'));
      m.vel.set(Math.sin(hr) * spd, 0, -Math.cos(hr) * spd);
      m.onGround = false;
      m.throttleCmd = 0.62; m.throttle = 0.62;
      m.gearCmd = false; m.gearPos = 0;
    } else {
      m.reset(0, 430, 0, G.terrain);
      m.gearCmd = true; m.gearPos = 1;
    }
    G.crashed = false; G.paused = false;
    G.acc = 0; G.shake = 0;
    if (G.smoke) { G.scene.remove(G.smoke.grp); G.smoke = null; }
    if (G.plane) { G.plane.trails.left.clear(); G.plane.trails.right.clear(); }
    G.prevPos = G.model.pos.clone();
    document.getElementById('crash').classList.remove('show');
    document.getElementById('paused').classList.remove('show');
    resetChallenge();
    if (G.airStart) {
      G.camera.position.copy(m.pos).add(new THREE.Vector3(0, 16, 40));
    } else {
      G.camera.position.set(0, 16, 460);
    }
    _camLook.copy(m.pos);
    setHint(G.airStart ? '空中起始：先把飞机配平，注意别失速' : '已复位到跑道 36 南端');
  }

  function showCrash(reason) {
    G.crashed = true; G.crashTime = G.time;
    document.getElementById('crashReason').textContent = reason;
    document.getElementById('crash').classList.add('show');
  }

  /* ================================================================== */
  /* 主循环                                                              */
  /* ================================================================== */
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - G.last) / 1000);
    if (!isFinite(dt) || dt <= 0) dt = 0.016;
    G.last = now;
    G.time += dt;

    var m = G.model;
    if (!G.prevPos) G.prevPos = m.pos.clone();

    if (!G.paused && !G.crashed) {
      var inp = readInput();
      G.prevPos.copy(m.pos);
      G.acc += dt;
      var steps = 0;
      while (G.acc >= FIXED && steps < 30) {
        m.step(FIXED, inp, G.terrain);
        G.acc -= FIXED; steps++;
        if (m.crashed) break;
      }
      if (m.crashed) {
        makeExplosion(m.pos.clone());
        showCrash(m.crashReason);
      }
      if (m.justLanded) {
        if (G.audio) G.audio.thud(m.landingImpact);
        _v1.set(m.pos.x, m.pos.y - 1.2, m.pos.z);
        makeDust(_v1, m.landingImpact);
      }

      // AI 交通：用同一套物理模型和 200Hz 定步长推进
      if (G.traffic) {
        for (var ti = 0; ti < G.traffic.length; ti++) {
          var ai = G.traffic[ti];
          ai.model.step(FIXED, aiInput(ai), G.terrain);
          if (ai.model.crashed) {          // AI 万一撞了就直接复位，别影响玩家
            ai.model.reset(AI_ROUTE[ai.wp].x, AI_ROUTE[ai.wp].z, 0, G.terrain);
            ai.model.pos.y = AI_ROUTE[ai.wp].y;
            ai.model.onGround = false;
          }
        }
      }

      // 挑战逻辑
      var ch = G.challenge;
      if (ch) {
        if (!ch.started && ch.mode === 'rings' && (!m.onGround || m.gs > 5)) ch.started = true;
        if (ch.started && !ch.finished && !ch.done) ch.t += dt;
        if (ch.mode === 'rings') { checkRings(dt); paintRings(false); }
        else checkLanding();
      }
    }

    syncAircraft(dt);
    syncTraffic(dt);
    updateVortex(dt);
    updatePanel(dt);
    updateExplosion(dt);
    updateDust(dt);
    G.world.update(dt, G.camera, m.pos, m.windFromDeg, m.windSpeed);
    updateCamera(dt);
    G.renderer.render(G.scene, G.camera);
    updateHUD();

    if (G.audio) G.audio.update(m, dt, G.time);
    if (hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) document.getElementById('hint').style.opacity = '0';
    }
  }

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */
  function build(quality) {
    var canvas = document.getElementById('gl');
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: quality !== 'low' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 不做 sRGB 输出编码：材质/顶点色都是按显示空间给的，
    // 一旦做一次 gamma 编码整幅画面会明显发灰过曝。
    G.renderer = renderer;
    bindCanvasInput(canvas);

    G.scene = new THREE.Scene();   // 占位；世界构建完成后替换为 world.scene
    G.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.4, 30000);
    G.camera.position.set(0, 16, 460);

    var terrain = new SimTerrain.Terrain({});
    G.terrain = terrain;

    var hudCanvas = document.getElementById('hud');
    G.hudCtx = hudCanvas.getContext('2d');
    resize();

    var progressEl = document.getElementById('bar');
    var statusEl = document.getElementById('loadText');
    statusEl.textContent = '正在生成地形…';

    terrain.generateChunked(function (p) {
      progressEl.style.width = (p * 70).toFixed(0) + '%';
    }, function () {
      statusEl.textContent = '正在构建场景…';
      progressEl.style.width = '80%';
      setTimeout(function () {
        G.world = SimWorld.create({ terrain: terrain, quality: quality, hour: G.hour });
        // 世界自带一个 Scene（天空/地形/机场/植被都在里面），必须用它来渲染
        G.scene = G.world.scene;

        G.plane = SimAircraft.build();
        G.scene.add(G.plane.group);
        // 涡流是世界坐标网格，必须挂到 scene 而不是飞机节点上
        G.scene.add(G.plane.trails.left.mesh);
        G.scene.add(G.plane.trails.right.mesh);

        /* 机载着陆灯：始终留在场景里（只调强度），避免增删灯光触发着色器重编译 */
        var spot = new THREE.SpotLight(0xfff6d0, 0, 460, 0.40, 0.55, 1.1);
        spot.position.set(0, -0.25, -2.5);
        spot.target.position.set(0, -14, -90);
        G.plane.group.add(spot);
        G.plane.group.add(spot.target);
        G.landingLight = spot;
        var noseLamp = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x8a8f96 })
        );
        noseLamp.position.set(0.42, -0.18, -2.55);
        G.plane.group.add(noseLamp);
        G.noseLightMat = noseLamp.material;

        // AI 交通飞机（可关：?traffic=0）
        G.traffic = [];
        if (!/[?&]traffic=0/.test(location.search)) createTraffic();

        G.model = new SimPhysics.FlightModel();
        G.model.reset(0, 430, 0, terrain);
        setWind(G.windKey);
        setMode(G.mode);
        setHour(G.hour);
        G.prevPos = G.model.pos.clone();
        if (G.airStart) respawn();

        progressEl.style.width = '100%';
        setTimeout(function () {
          document.getElementById('loading').classList.remove('show');
          G.running = true;
          G.last = performance.now();
          requestAnimationFrame(frame);
        }, 120);
      }, 40);
    });
  }

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    G.cssW = w; G.cssH = h;
    if (!G.renderer) return;
    G.renderer.setSize(w, h);
    G.camera.aspect = w / h;
    G.camera.updateProjectionMatrix();
    var c = document.getElementById('hud');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    // 之后所有 HUD 绘制都用 CSS 像素坐标
    G.hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */
  function boot() {
    // 错误处理器最先注册，避免启动阶段的异常被吞掉
    window.addEventListener('error', function (e) {
      showFatal((e.message || '未知错误') + '\n' + (e.filename || '') + ':' + (e.lineno || 0));
    });
    bindInput();
    window.addEventListener('resize', resize);

    var q = 'medium';
    document.querySelectorAll('#start [data-q]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-q]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        q = b.getAttribute('data-q');
      });
    });

    function launch(quality) {
      document.getElementById('start').classList.remove('show');
      document.getElementById('loading').classList.add('show');
      if (!G.audio) G.audio = Audio();
      if (G.audio) G.audio.resume();
      if (G.mode === 'rings') setHint('穿环计时：起飞后依次穿过绿色圆环，计时自动开始');
      else if (G.mode === 'landing') setHint('定点着陆：把飞机稳稳停在跑道靶心的圆圈里');
      else setHint(G.airStart
        ? '空中起始：俯仰控速度，油门控高度'
        : '地面滑跑：Shift 加满油门，速度 27 m/s 后拉杆（↓）抬前轮');
      build(quality);
    }

    document.querySelectorAll('#start [data-start]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-start]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        G.airStart = b.getAttribute('data-start') === 'air';
      });
    });

    document.querySelectorAll('#start [data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-mode]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        G.mode = b.getAttribute('data-mode');
      });
    });

    document.querySelectorAll('#start [data-wind]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-wind]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        G.windKey = b.getAttribute('data-wind');
      });
    });

    document.querySelectorAll('#start [data-hour]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-hour]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        G.hour = parseFloat(b.getAttribute('data-hour'));
      });
    });

    document.getElementById('btnStart').addEventListener('click', function () { launch(q); });

    document.getElementById('btnCloseHelp').addEventListener('click', toggleHelp);
    document.getElementById('btnRespawn').addEventListener('click', respawn);
    document.getElementById('btnResultRetry').addEventListener('click', function () {
      document.getElementById('result').classList.remove('show');
      respawn();
    });
    document.getElementById('btnResultFree').addEventListener('click', function () {
      document.getElementById('result').classList.remove('show');
      setMode('free');
      respawn();
      setHint('已切换到自由飞行');
    });

    // URL 参数：?auto=1 跳过开始界面，&start=air 空中起始，&cam=0..3 指定视角，
    //           &mode=rings|landing，&wind=calm|light|breezy|storm
    var mq = /[?&]quality=(low|medium|high)/.exec(location.search);
    var mc = /[?&]cam=(\d)/.exec(location.search);
    var mm = /[?&]mode=(free|rings|landing)/.exec(location.search);
    var mw = /[?&]wind=(calm|light|breezy|storm)/.exec(location.search);
    var mh = /[?&]hour=([0-9.]+)/.exec(location.search);
    var mhn = /[?&]time=(dawn|noon|sunset|night)/.exec(location.search);
    if (/[?&]start=air/.test(location.search)) G.airStart = true;
    if (mm) G.mode = mm[1];
    if (mw) G.windKey = mw[1];
    if (mh) G.hour = parseFloat(mh[1]) || 0;
    if (mhn) {
      var pk = { dawn: 6.4, noon: 12.5, sunset: 17.9, night: 22 };
      G.hour = pk[mhn[1]];
    }
    if (/[?&]auto=1/.test(location.search)) {
      if (mc) G.camMode = Math.min(3, parseInt(mc[1], 10));
      launch(mq ? mq[1] : 'medium');
    }
  }

  function showFatal(msg) {
    var el = document.getElementById('fatal');
    if (!el) return;
    document.getElementById('fatalMsg').textContent = msg;
    el.style.display = 'flex';
    el.classList.add('show');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
