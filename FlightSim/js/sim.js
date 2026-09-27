/* =========================================================================
 * sim.js — 主程序：渲染循环 / 输入 / 相机 / 音效 / UI
 * ========================================================================= */
(function () {
  'use strict';

  var THREE = window.THREE;
  var SimTerrain = window.SimTerrain;
  var SimWorld = window.SimWorld;
  var SimAircraft = window.SimAircraft;
  var SimAircraftTypes = window.SimAircraftTypes;
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
    camMode: 0, camNames: ['追尾', '座舱', '环绕', '塔台', '自由'],
    fovBase: 62,
    // 追尾视角按住右键环视（松开回中）
    lookFree: { x: 0, y: 0, active: false },
    // 自由视角相机
    free: { pos: new THREE.Vector3(), yaw: 0, pitch: 0, speed: 45 },
    // 自由视角下接管飞机的自动平飞目标
    stab: { alt: 300, hdg: 0, spd: 60, on: false },
    showHUD: true, quality: 'medium', invertPitch: false, airStart: false,
    aircraftKey: 'trainer',
    lights: { landing: true, nav: true },
    weather: 'clear',
    mode: 'free',                 // free | rings | landing
    challenge: null,
    prevPos: null,
    windKey: 'calm',
    hour: 12.5,                   // 时刻（0..24）
    resultShown: false,
    time: 0, last: 0, acc: 0,
    shake: 0, muted: false,
    orbit: { theta: 2.4, phi: 0.35, dist: 26, tx: 0, ty: 0, dragging: false, lx: 0, ly: 0 },
    look: { x: 0, y: 0 },
    keys: {}, gamepad: null,
    audio: null,
    smoke: null,
    dust: []
  };

  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion(), _e1 = new THREE.Euler();
  var _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();
  var _qd = new THREE.Quaternion(), _axX = new THREE.Vector3(1, 0, 0);

  /* 操纵面绕自身铰链线偏转。枢轴上存着铰链方向的基准四元数，
     乘一个绕局部 X 轴的旋转就等于绕铰链转——上反角、垂直铰链都适用。 */
  function deflect(pivot, ang) {
    if (!pivot) return;
    pivot.quaternion.copy(pivot.userData.base)
      .multiply(_qd.setFromAxisAngle(_axX, ang));
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return 1 - Math.exp(-t); }

  /* ================================================================== */
  /* 输入                                                                */
  /* ================================================================== */
  function bindInput() {
    window.addEventListener('keydown', function (e) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
        'PageUp', 'PageDown'].indexOf(e.code) >= 0) e.preventDefault();
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

    window.addEventListener('mouseup', function (e) {
      G.orbit.dragging = false;
      if (e.button === 2) G.lookFree.active = false;
    });
    window.addEventListener('mousemove', function (e) {
      if (G.orbit.dragging) {
        if (e.buttons & 4) {
          // 右键拖拽：平移观察点（把镜头挪到飞机旁边看细节）
          G.orbit.tx = clamp(G.orbit.tx - e.movementX * G.orbit.dist * 0.0016, -260, 260);
          G.orbit.ty = clamp(G.orbit.ty + e.movementY * G.orbit.dist * 0.0016, -160, 260);
        } else {
          G.orbit.theta -= (e.clientX - G.orbit.lx) * 0.006;
          G.orbit.phi = clamp(G.orbit.phi + (e.clientY - G.orbit.ly) * 0.005, -1.52, 1.52);
          G.orbit.lx = e.clientX; G.orbit.ly = e.clientY;
        }
      }
      if (G.lookFree.active) {
        G.lookFree.x = clamp(G.lookFree.x - e.movementX * 0.0028, -Math.PI, Math.PI);
        G.lookFree.y = clamp(G.lookFree.y - e.movementY * 0.0028, -1.35, 1.45);
      }
      if (document.pointerLockElement && G.camMode === 4) {
        G.free.yaw -= e.movementX * 0.0022;
        G.free.pitch = clamp(G.free.pitch - e.movementY * 0.0022, -1.45, 1.45);
      } else if (G.renderer && document.pointerLockElement === G.renderer.domElement) {
        G.look.x = clamp(G.look.x - e.movementX * 0.0022, -Math.PI, Math.PI);
        G.look.y = clamp(G.look.y - e.movementY * 0.0022, -1.45, 1.45);
      }
    });
  }

  /* 只在渲染器创建之后调用：鼠标 / 指针锁定 / 滚轮都绑定在画布上 */
  function bindCanvasInput(cv) {
    // 右键要用来环视，屏蔽浏览器菜单
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    cv.addEventListener('mousedown', function (e) {
      if (e.button === 2) {
        // 右键：任何视角下都可以自由环视
        G.lookFree.active = true;
        G.lookFree.x = G.lookFree.x || 0;
        G.lookFree.y = G.lookFree.y || 0;
        return;
      }
      if (G.camMode === 1 && document.pointerLockElement !== cv) {
        cv.requestPointerLock();
      } else if (G.camMode === 4 && document.pointerLockElement !== cv) {
        cv.requestPointerLock();
      } else if (G.camMode === 2) {
        G.orbit.dragging = true; G.orbit.lx = e.clientX; G.orbit.ly = e.clientY;
      }
    });

    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (G.camMode === 2) {
        // 环绕视角：滚轮拉近推远，范围放到 3~600 米
        G.orbit.dist = clamp(G.orbit.dist * (1 + e.deltaY * 0.0012), 3, 600);
      } else if (G.camMode === 4) {
        G.free.speed = clamp(G.free.speed * (1 - e.deltaY * 0.0012), 4, 400);
      } else {
        // 其他视角：滚轮调视场角（长焦/广角）
        G.fovBase = clamp(G.fovBase + e.deltaY * 0.03, 30, 110);
      }
    }, { passive: false });
  }

  function onKeyPress(code) {
    switch (code) {
      case 'KeyC': setCamMode(G.camMode + 1); break;
      case 'Digit1': setCamMode(0); break;
      case 'Digit2': setCamMode(1); break;
      case 'Digit3': setCamMode(2); break;
      case 'Digit4': setCamMode(3); break;
      case 'Digit5': setCamMode(4); break;
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
      case 'KeyO': {
        var wxOrder = ['clear', 'rain', 'snow'];
        var wi = wxOrder.indexOf(G.weather);
        G.weather = wxOrder[(wi + 1) % wxOrder.length];
        if (G.world) G.world.setWeather(G.weather);
        var wxName = { clear: '晴', rain: '雨', snow: '雪' }[G.weather];
        setHint('天气：' + wxName);
        break;
      }
      case 'KeyB': {
        var mag = G.model.magneto;
        G.model.magneto = mag === 2 ? 1 : (mag === 1 ? 0 : 2);
        var magName = ['关', '左磁电机', '双磁电机'][G.model.magneto];
        setHint('磁电机：' + magName + (G.model.magneto === 0 ? '（停车）' : ''));
        break;
      }
      case 'KeyL':
        G.lights.landing = !G.lights.landing;
        G.lights.nav = G.lights.landing;
        applyLights();
        setHint('灯光：' + (G.lights.landing ? '开' : '关'));
        break;
      case 'KeyY': {
        // 循环换机型（会复位到跑道）
        var list = SimAircraftTypes.TYPES;
        var ci2 = 0;
        for (var ai2 = 0; ai2 < list.length; ai2++) if (list[ai2].key === G.aircraftKey) ci2 = ai2;
        setAircraft(list[(ci2 + 1) % list.length].key);
        break;
      }
      case 'Escape': if (document.pointerLockElement) document.exitPointerLock(); break;
    }
  }

  /* ================================================================== */
  /* 机型：装配 / 更换                                                    */
  /* ================================================================== */
  /* 按当前机型建模，并挂上涡流、着陆灯、光锥。
     更换机型时把旧的一整套（含挂在 scene 上的涡流网格）都摘干净。 */
  function spawnAircraft() {
    if (G.plane) {
      G.scene.remove(G.plane.group);
      if (G.plane.trails) {
        G.scene.remove(G.plane.trails.left.mesh);
        G.scene.remove(G.plane.trails.right.mesh);
      }
    }
    var spec = SimAircraftTypes.get(G.aircraftKey);
    G.plane = SimAircraft.build({ spec: spec });
    G.scene.add(G.plane.group);
    // 涡流是世界坐标网格，必须挂到 scene 而不是飞机节点上
    if (G.plane.trails) {
      G.scene.add(G.plane.trails.left.mesh);
      G.scene.add(G.plane.trails.right.mesh);
    }

    var halfLen = G.plane.length / 2;

    /* 机载着陆灯：始终留在场景里（只调强度），避免增删灯光触发着色器重编译 */
    var spot = new THREE.SpotLight(0xfff6d0, 0, 520, 0.40, 0.55, 1.1);
    spot.position.set(0, -0.25, -halfLen + 0.6);
    spot.target.position.set(0, -14, -halfLen - 90);
    G.plane.group.add(spot);
    G.plane.group.add(spot.target);
    G.landingLight = spot;

    var noseLamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x8a8f96 })
    );
    noseLamp.position.set(spec.fuselage.rF * 0.9, -0.18, -halfLen + 0.55);
    G.plane.group.add(noseLamp);
    G.noseLightMat = noseLamp.material;

    // 着陆灯光锥：夜里能看见一道光束（加法混合，白天透明度为 0）
    G.beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0d0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    var beam = new THREE.Mesh(new THREE.ConeGeometry(8, 130, 18, 1, true), G.beamMat);
    beam.rotation.x = Math.PI / 2;          // 锥尖朝机头方向
    beam.position.set(0, -7, -halfLen - 60);
    beam.renderOrder = 7;
    G.plane.group.add(beam);

    if (G.audio) G.audio.setEngine(spec.engine.type);
    setHour(G.hour);
    applyLights();
  }

  /* 换机型：重建模型 + 换掉气动参数 + 复位 */
  function setAircraft(key) {
    G.aircraftKey = SimAircraftTypes.get(key).key;
    if (!G.scene) return;
    spawnAircraft();
    G.model.cfg = SimAircraftTypes.physicsFor(G.aircraftKey, SimPhysics.DEFAULTS);
    respawn();
    var t = SimAircraftTypes.get(G.aircraftKey);
    var pf = SimAircraftTypes.perf(t, SimPhysics.DEFAULTS);
    setHint('机型：' + t.name + '（' + t.tag + '）失速 ' + (pf.vs * 3.6).toFixed(0) + ' km/h');
  }

  /* ================================================================== */
  /* 相机模式切换                                                        */
  /* ================================================================== */
  function setCamMode(n) {
    n = ((n % 5) + 5) % 5;
    G.camMode = n;
    G.look.x = 0; G.look.y = 0;
    G.lookFree.x = 0; G.lookFree.y = 0;
    if (n === 4) {
      startFreeCam();
    } else {
      G.stab.on = false;
      if (document.pointerLockElement) document.exitPointerLock();
    }
    var tips = {
      0: '追尾视角（按住右键可环视，滚轮调视场角）',
      1: '座舱视角（点击画面锁定鼠标环视，滚轮调视场角）',
      2: '环绕视角（左键转动、右键平移、滚轮缩放 3~600m）',
      3: '塔台视角',
      4: '自由视角：鼠标转视角，WASD 平移 / QE 升降 / Shift 加速，飞机自动平飞'
    };
    setHint(tips[n]);
  }

  /* 进入自由视角：相机放到飞机后上方，同时给飞机定好自动平飞目标 */
  function startFreeCam() {
    var m = G.model;
    var back = _v1.set(0, 6, 26).applyQuaternion(m.quat);
    G.free.pos.copy(m.pos).add(back);
    var gh = G.terrain.sample(G.free.pos.x, G.free.pos.z);
    if (G.free.pos.y < gh + 3) G.free.pos.y = gh + 3;
    var dir = _v2.copy(m.pos).sub(G.free.pos);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    G.free.yaw = Math.atan2(-dir.x, -dir.z);
    G.free.pitch = Math.asin(clamp(dir.y, -1, 1));

    var s = G.stab;
    s.on = true;
    s.hdg = m.headingDeg;
    s.spd = clamp(m.tas, 45, 85);
    // 离地时就保持当前高度；地面上就原地刹住，别自己滑跑起飞
    s.alt = m.onGround ? m.pos.y : Math.max(m.pos.y, G.terrain.sample(m.pos.x, m.pos.z) + 200);
  }

  /* 自由视角下接管飞机的自动平飞：航向保持 + 高度保持 + 速度保持 */
  function stabilizerInput() {
    var m = G.model, s = G.stab;
    if (m.onGround) {
      return { pitch: 0, roll: 0, yaw: 0, brakes: true, throttleUp: false, throttleDown: true };
    }
    var targetVs = clamp((s.alt - m.pos.y) * 0.30, -7, 7);
    var err = ((s.hdg - m.headingDeg + 540) % 360) - 180;
    var bankT = clamp(err * 1.3, -28, 28);
    return {
      pitch: clamp((targetVs - m.vs) * 0.10, -0.65, 0.55),
      roll: clamp((bankT - m.rollDeg) * 0.06, -1, 1),
      yaw: clamp(m.betaDeg * 0.06, -1, 1),
      throttleUp: m.tas < s.spd - 3,
      throttleDown: m.tas > s.spd + 3
    };
  }

  /* 汇总当前输入 -> 物理模型 */
  function readInput() {
    // 自由视角下飞机自己飞，键盘让给相机
    if (G.camMode === 4 && G.stab.on) return stabilizerInput();

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

    /* 俯仰配平：,/. 连续可调（. 向后 = 抬头，, 向前 = 低头）。
       配平是叠在杆位上的偏置，松杆后飞机就稳定在配平对应的速度上。 */
    if (k.Comma) G.model.trim = clamp(G.model.trim - G.dt * 0.32, -0.5, 0.5);
    if (k.Period) G.model.trim = clamp(G.model.trim + G.dt * 0.32, -0.5, 0.5);

    /* 混合比：PgUp 加浓 / PgDn 收稀。地面上用全富油，
       爬高以后空气稀薄，要往稀里收才能保持功率——收过头会掉功率甚至停车。 */
    if (k.PageUp) G.model.mixture = clamp(G.model.mixture + G.dt * 0.45, 0, 1);
    if (k.PageDown) G.model.mixture = clamp(G.model.mixture - G.dt * 0.45, 0, 1);

    // 起动机：按住才转，转够约 1.2 秒点着
    G.model.starter = !!k.KeyX;

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
    var mode = 'prop';

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
      setEngine: function (type) { mode = (type === 'jet') ? 'jet' : 'prop'; },
      update: function (m, dt, time) {
        if (mode === 'jet') {
          // 涡扇：基频随油门与空速上升，叠一层高频啸叫，本底噪声也更大
          var fj = 78 + m.throttle * 300 + m.ias * 0.85;
          o1.frequency.value = fj;
          o2.frequency.value = fj * 2.98;
          lp.frequency.value = 1500 + m.throttle * 5600;
          engGain.gain.value = 0.030 + m.throttle * 0.105;
          windGain.gain.value = Math.min(0.42, (m.ias / 150) * 0.42) * (m.onGround ? 0.45 : 1);
        } else {
          var f = 46 + m.rpm * 0.062;
          o1.frequency.value = f;
          o2.frequency.value = f * 2.02;
          lp.frequency.value = 500 + m.throttle * 2200;
          engGain.gain.value = 0.035 + m.throttle * 0.085;
          windGain.gain.value = Math.min(0.30, m.ias / 130 * 0.30) * (m.onGround ? 0.4 : 1);
        }
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

    // 右键环视松手后缓慢回中
    if (!G.lookFree.active) {
      var decay = Math.exp(-dt * 3.2);
      G.lookFree.x *= decay;
      G.lookFree.y *= decay;
      if (Math.abs(G.lookFree.x) < 1e-3) G.lookFree.x = 0;
      if (Math.abs(G.lookFree.y) < 1e-3) G.lookFree.y = 0;
    }

    if (G.camMode === 0) {
      // 追尾：只跟随部分俯仰/滚转，保留速度感
      _e1.setFromQuaternion(m.quat, 'YXZ');
      var fq = _q1.setFromEuler(new THREE.Euler(_e1.x * 0.55, _e1.y, _e1.z * 0.75, 'YXZ'));
      var back = _v2.set(0, 3.6, 16 + Math.min(9, m.tas * 0.12)).applyQuaternion(fq);
      // 右键环视：把镜头绕着飞机转，松手自己转回去
      var la = G.lookFree.x;
      if (la) {
        var ca = Math.cos(la), sa = Math.sin(la);
        back.set(back.x * ca + back.z * sa, back.y + G.lookFree.y * 12, -back.x * sa + back.z * ca);
      }
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
      // 环绕：距离 3~600m、俯仰 ±87°，还可以平移观察点
      var o = G.orbit;
      var cp = Math.cos(o.phi);
      var x = Math.sin(o.theta) * cp * o.dist;
      var y = Math.sin(o.phi) * o.dist;
      var z = Math.cos(o.theta) * cp * o.dist;
      // 平移方向跟着方位角走，转视角时偏移才不会错位
      var rx = -Math.cos(o.theta), rz = Math.sin(o.theta);
      var tx = m.pos.x + rx * o.tx, ty = m.pos.y + o.ty, tz = m.pos.z + rz * o.tx;
      cam.position.set(tx + x, ty + y, tz + z);
      var g2 = G.terrain.sample(cam.position.x, cam.position.z);
      if (cam.position.y < g2 + 2) cam.position.y = g2 + 2;
      cam.up.set(0, 1, 0);
      cam.lookAt(tx, ty, tz);
      applyShake(dt, 0.4);

    } else if (G.camMode === 4) {
      // 自由视角：完全由鼠标 + WASD 驱动，地形只做软性托底
      var f = G.free, kk = G.keys;
      var spd = f.speed * ((kk.ShiftLeft || kk.ShiftRight) ? 4 : 1) * dt;
      var cy = Math.cos(f.yaw), sy = Math.sin(f.yaw);
      var cpi = Math.cos(f.pitch), spi = Math.sin(f.pitch);
      var fx = -sy * cpi, fy = spi, fz = -cy * cpi;
      var rxx = cy, rzz = -sy;
      if (kk.KeyW) { f.pos.x += fx * spd; f.pos.y += fy * spd; f.pos.z += fz * spd; }
      if (kk.KeyS) { f.pos.x -= fx * spd; f.pos.y -= fy * spd; f.pos.z -= fz * spd; }
      if (kk.KeyD) { f.pos.x += rxx * spd; f.pos.z += rzz * spd; }
      if (kk.KeyA) { f.pos.x -= rxx * spd; f.pos.z -= rzz * spd; }
      if (kk.KeyE || kk.Space) f.pos.y += spd;
      if (kk.KeyQ) f.pos.y -= spd;
      var g3 = G.terrain.sample(f.pos.x, f.pos.z);
      if (f.pos.y < g3 + 1.5) f.pos.y = g3 + 1.5;
      cam.position.copy(f.pos);
      cam.up.set(0, 1, 0);
      cam.quaternion.setFromEuler(_e1.set(f.pitch, f.yaw, 0, 'YXZ'));

    } else {
      // 塔台
      cam.position.set(250, G.world.flatY + 30, 120);
      cam.up.set(0, 1, 0);
      cam.lookAt(m.pos);
      applyShake(dt, 0.5);
    }

    // 视场角：滚轮可调，速度快的视角再补一点速度感
    var speedFov = (G.camMode === 4) ? 0 : Math.min(14, m.tas * 0.14);
    var targetFov = G.fovBase + (G.camMode === 1 ? 4 : 0) + speedFov;
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

    if (a.propeller) {
      a.propeller.rotation.z = m.propAngle;
      a.propBlurMat.opacity = clamp((m.rpm - 700) / 2000, 0, 0.34);
      // 变距桨：桨叶角随工况变化（恒速桨低速大功率时变粗）
      for (var bi = 0; bi < a.bladePivots.length; bi++) {
        a.bladePivots[bi].rotation.y = m.bladePitch;
      }
    }
    if (a.jetGlowMat) {
      // 加力焰：大油门时亮起，带一点高频脉动；双发时每根焰都拉长
      var heat = clamp((m.throttle - 0.55) / 0.45, 0, 1);
      var pulse = 0.85 + 0.15 * Math.sin(G.time * 37);
      a.jetGlowMat.opacity = heat * 0.55 * pulse;
      var fk = 0.75 + heat * 0.55;
      for (var gi = 0; gi < a.jetGlow.children.length; gi++) {
        a.jetGlow.children[gi].scale.set(1, 1, fk);
      }
    }

    // 座舱视角：隐藏挡住视线的实体桨叶、座舱罩与其骨架，只保留桨盘虚影
    var inCockpit = (G.camMode === 1);
    if (a.propeller) {
      a.propeller.visible = !inCockpit;
      a.propBlurMat.opacity *= inCockpit ? 0.5 : 1;
    }
    a.canopy.visible = !inCockpit;
    a.canopyFrame.visible = !inCockpit;

    // 操纵面偏转：绕各自真实的铰链线旋转（基准四元数 × 偏转量）
    deflect(a.surfaces.elevator, -m.ctl.pitch * 0.34);
    deflect(a.surfaces.elevatorL, -m.ctl.pitch * 0.34);
    deflect(a.surfaces.aileronR, -m.ctl.roll * 0.42);
    deflect(a.surfaces.aileronL, m.ctl.roll * 0.42);
    deflect(a.surfaces.rudder, m.ctl.yaw * 0.42);
    deflect(a.surfaces.rudderR, m.ctl.yaw * 0.42);
    // 襟翼：只向下偏转，不差动。符号和升降舵一致——正值 = 后缘向下
    if (a.surfaces.flapR) {
      deflect(a.surfaces.flapR, m.flaps * 0.62);
      deflect(a.surfaces.flapL, m.flaps * 0.62);
    }

    // 起落架舱门：放轮时张开，收轮时贴着机腹闭合
    for (var gd = 0; gd < a.gearDoors.length; gd++) {
      a.gearDoors[gd].pivot.rotation.x = a.gearDoors[gd].sign * m.gearPos * 1.45;
    }

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

    // 当前构型失速速度：必须按机型的气动参数算，不能写死教练机的数字
    var cfg = m.cfg;
    var CLmax = cfg.CL0 + cfg.CLalpha * cfg.alphaStall + m.flaps * 0.62;
    var vsMs = Math.sqrt(2 * cfg.mass * 9.80665 / (1.225 * cfg.wingArea * CLmax));

    var d = {
      ias: m.ias, mach: m.mach, alt: m.pos.y, radarAlt: m.radarAlt,
      vs: m.vs, gs: m.gs,
      headingDeg: m.headingDeg, pitchDeg: m.pitchDeg, rollDeg: m.rollDeg,
      alphaDeg: m.alphaDeg, betaDeg: m.betaDeg, gForce: m.gForce,
      throttle: m.throttle, rpm: m.rpm, flaps: m.flaps, gearPos: m.gearPos,
      onGround: m.onGround, stall: m.stall, overspeed: m.overspeed,
      terrainWarn: m.terrainWarn, outOfBounds: m.outOfBounds,
      trim: m.trim, spin: m.spin, spinDir: m.spinDir,
      mixture: m.mixture, bestMix: m.bestMix, mixPower: m.mixPower,
      engineOn: m.engineOn, magneto: m.magneto, starter: m.starter,
      weather: G.weather,
      visibility: (G.world && G.world.scene && G.world.scene.fog) ? G.world.scene.fog.far : 0,
      bladePitch: m.bladePitch,
      oat: m.oat, densityAlt: m.densityAlt, rho: m.rho, lights: G.lights,
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
    applyLights();
    if (G.model) {
      // 海平面气温：14℃ 基准，15 点前后最热、凌晨最冷。
      // 热天的空气稀薄（密度高度高），同样标高下起飞距离更长、爬升更差、功率更低。
      G.model.oat = 14 + 10 * Math.sin((G.hour - 9) * Math.PI / 12);
    }
    return env;
  }

  /* 灯光开关：着陆灯（含光锥）、航行灯、频闪。航行灯与频闪只在灯开着时闪。 */
  function applyLights() {
    if (!G.world) return;
    var night = G.world.env.night;
    var want = G.lights && G.lights.landing;
    // 天越黑灯越亮；白天开着也只是聊胜于无
    var li = want ? 2.6 * clamp(0.25 + night, 0, 1) : 0;
    if (G.landingLight) {
      G.landingLight.intensity = li;
      if (G.noseLightMat) G.noseLightMat.color.setHex(li > 0.05 ? 0xfff6d0 : 0x8a8f96);
      if (G.beamMat) G.beamMat.opacity = clamp(li / 2.6, 0, 1) * 0.055;
    }
    if (G.plane && G.plane.lamps) {
      var nav = G.lights && G.lights.nav;
      G.plane.lamps.navL.visible = nav;
      G.plane.lamps.navR.visible = nav;
      if (!nav) { G.plane.lamps.strobe.visible = false; G.plane.lamps.beacon.visible = false; }
    }
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
  var AI_CAPTURE = 750;    // 航点捕获半径（必须大于最小转弯半径，否则会绕着航点转圈）
  var AI_WP_TIMEOUT = 100; // 单个航点最长飞行时间，超时强制切下一个（兜底）

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
      var tgt = AI_ROUTE[wp];
      // 初始航向直接对准第一个目标航点，否则起步就要掉头
      var hdg = ((Math.atan2(tgt.x - start.x, -(tgt.z - start.z)) * R2D) + 360) % 360;
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
  function aiInput(ai, dt) {
    var m = ai.model;
    var t = AI_ROUTE[ai.wp];
    var dx = t.x - m.pos.x, dz = t.z - m.pos.z;
    // 捕获半径必须大于最小转弯半径（56 m/s、30° 坡度时约 550m），
    // 否则飞机会稳定地绕着航点外侧打转，永远"到不了"。
    if (Math.hypot(dx, dz) < AI_CAPTURE || ai.wpT > AI_WP_TIMEOUT) {
      ai.wpT = 0;
      ai.wp = (ai.wp + 1) % AI_ROUTE.length;
      t = AI_ROUTE[ai.wp];
      dx = t.x - m.pos.x; dz = t.z - m.pos.z;
    }
    ai.wpT = (ai.wpT || 0) + (dt || 0);
    var bearing = ((Math.atan2(dx, -dz) * R2D) + 360) % 360;
    var trk = ((Math.atan2(m.vel.x, -m.vel.z) * R2D) + 360) % 360;
    var err = ((bearing - trk + 540) % 360) - 180;

    var bankT = clamp(err * 1.3, -30, 30);
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
      deflect(a.surfaces.elevator, -m.ctl.pitch * 0.34);
      deflect(a.surfaces.elevatorL, -m.ctl.pitch * 0.34);
      deflect(a.surfaces.aileronR, -m.ctl.roll * 0.42);
      deflect(a.surfaces.aileronL, m.ctl.roll * 0.42);
      deflect(a.surfaces.rudder, m.ctl.yaw * 0.42);
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
      // 空中起始：机场西北 1.3km，420m 高，航向 020。
      // 速度必须按机型算——写死 62 m/s 的话喷气机（失速 195 km/h）一出生就在掉高度
      var x = -450, z = 1250, hdg = 20;
      var gh = G.terrain.sample(x, z);
      var c0 = m.cfg;
      var clMax = c0.CL0 + c0.CLalpha * c0.alphaStall;
      var vsAir = Math.sqrt(2 * c0.mass * 9.80665 / (1.225 * c0.wingArea * clMax));
      var spd = Math.max(62, vsAir * 1.55);
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

    /* ?at=x,z,离地高度[,航向] —— 直接把飞机摆到指定位置，
       用来巡查地标或者分享某个视角。 */
    var ma = /[?&]at=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?/.exec(location.search);
    if (ma) {
      var ax = parseFloat(ma[1]), az = parseFloat(ma[2]), aalt = parseFloat(ma[3]);
      var ahdg = ma[4] != null ? parseFloat(ma[4]) : 0;
      var agh = G.terrain.sample(ax, az);
      m.reset(ax, az, ahdg, G.terrain);
      m.pos.set(ax, agh + aalt, az);
      var ahr = ahdg * Math.PI / 180;
      m.quat.setFromEuler(new THREE.Euler(0, -ahr, 0, 'YXZ'));
      m.vel.set(Math.sin(ahr) * 58, 0, -Math.cos(ahr) * 58);
      m.onGround = false;
      m.throttleCmd = 0.6; m.throttle = 0.6;
      m.gearCmd = false; m.gearPos = 0;
      G.airStart = true;
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
    if (G.camMode === 4) startFreeCam();
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
      G.dt = dt;                 // 配平这类连续量需要按帧积分
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
          ai.model.step(FIXED, aiInput(ai, FIXED), G.terrain);
          if (ai.model.crashed) {          // AI 万一撞了就直接复位，别影响玩家
            ai.model.reset(AI_ROUTE[ai.wp].x, AI_ROUTE[ai.wp].z, 0, G.terrain);
            ai.model.pos.y = AI_ROUTE[ai.wp].y;
            ai.model.onGround = false;
            ai.wpT = 0;
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
    // 降水强度喂给物理模型（雨 0.6 / 雪 0.9，晴 0），用于叠加额外阻力
    var wxKind = G.world.weather;
    m.precip = wxKind === 'rain' ? 0.6 : (wxKind === 'snow' ? 0.9 : 0);
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

        G.world.setWeather(G.weather);
        spawnAircraft();
        // AI 交通飞机（可关：?traffic=0）
        G.traffic = [];
        if (!/[?&]traffic=0/.test(location.search)) createTraffic();

        G.model = new SimPhysics.FlightModel(
          SimAircraftTypes.physicsFor(G.aircraftKey, SimPhysics.DEFAULTS));
        G.model.reset(0, 430, 0, terrain);
        setWind(G.windKey);
        setMode(G.mode);
        setHour(G.hour);
        setCamMode(G.camMode);       // 初始化视角（自由视角需要相机与平飞目标）
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
    document.querySelectorAll('#start [data-ac]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-ac]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        G.aircraftKey = b.getAttribute('data-ac');
        var acEl = document.getElementById('acDesc');
        if (acEl) {
          var t = SimAircraftTypes.get(G.aircraftKey);
          var b2 = t.bench, pf = SimAircraftTypes.perf(t, SimPhysics.DEFAULTS);
          acEl.innerHTML = t.desc + '<br><span style="color:#6f8698">' +
            b2.note + '：' + b2.power + ' ｜ 翼展 ' + b2.span + ' m ｜ 重量 ' + b2.mass + ' kg ｜ ' +
            '失速 ' + b2.vsKmh + ' km/h' +
            (b2.cruiseKmh ? ' ｜ 巡航 ' + b2.cruiseKmh + ' km/h' : '') +
            (b2.vneKmh ? ' ｜ Vne ' + b2.vneKmh + ' km/h' : '') +
            (b2.glide ? ' ｜ 滑翔比 ' + b2.glide + ':1' : '') +
            (b2.climb ? ' ｜ 爬升 ' + b2.climb + ' m/s' : '') + '<br>' +
            '本模拟器实测：失速 ' + (pf.vs * 3.6).toFixed(0) + ' km/h ｜ 最大平飞 ' +
            (pf.vmax * 3.6).toFixed(0) + ' km/h ｜ 爬升 ' + pf.climb.toFixed(1) + ' m/s' +
            (pf.glide > 15 ? ' ｜ 滑翔比 ' + pf.glide.toFixed(1) + ':1' : '') + '</span>';
        }
      });
    });

    document.querySelectorAll('#start [data-wx]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#start [data-wx]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        G.weather = b.getAttribute('data-wx');
        if (G.world) G.world.setWeather(G.weather);
      });
    });

    var mq = /[?&]quality=(low|medium|high)/.exec(location.search);    var mc = /[?&]cam=(\d)/.exec(location.search);
    var mm = /[?&]mode=(free|rings|landing)/.exec(location.search);
    var mw = /[?&]wind=(calm|light|breezy|storm)/.exec(location.search);
    var mh = /[?&]hour=([0-9.]+)/.exec(location.search);
    var mhn = /[?&]time=(dawn|noon|sunset|night)/.exec(location.search);
    var mod = /[?&]od=([0-9.]+)/.exec(location.search);
    var mw = /[?&]weather=(clear|rain|snow)/.exec(location.search);
    if (mw) G.weather = mw[1];
    var mac = /[?&]ac=(\w+)/.exec(location.search);
    if (mac) G.aircraftKey = SimAircraftTypes.get(mac[1]).key;

    /* 把开始界面上的机型按钮与说明同步到当前选择
       （走 URL 参数进来时按钮默认高亮的是 PA-28，会和实际机型对不上） */
    var wxBtn = document.querySelector('#start [data-wx="' + G.weather + '"]');
    if (wxBtn) {
      document.querySelectorAll('#start [data-wx]').forEach(function (x) { x.classList.remove('on'); });
      wxBtn.classList.add('on');
    }
    var acBtn = document.querySelector('#start [data-ac="' + G.aircraftKey + '"]');
    if (acBtn) acBtn.dispatchEvent(new Event('click'));
    if (mod) {
      G.orbit.dist = clamp(parseFloat(mod[1]) || 26, 3, 600);
      G.camMode = 2;
    }
    if (/[?&]start=air/.test(location.search)) G.airStart = true;
    if (/[?&]at=/.test(location.search)) G.airStart = true;   // ?at= 也走空中起始分支
    if (mm) G.mode = mm[1];
    if (mw) G.windKey = mw[1];
    if (mh) G.hour = parseFloat(mh[1]) || 0;
    if (mhn) {
      var pk = { dawn: 6.4, noon: 12.5, sunset: 17.9, night: 22 };
      G.hour = pk[mhn[1]];
    }
    if (/[?&]auto=1/.test(location.search)) {
      if (mc) G.camMode = Math.min(4, parseInt(mc[1], 10));
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
