// Three.js globes: the big Earth explorer and the small Moon/Mars target picker.
/* global THREE */

export function vec3(lat, lon, r = 1) {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}
export function latLonOf(v) {
  const n = v.clone().normalize();
  return { lat: (Math.asin(n.y) * 180) / Math.PI, lon: (Math.atan2(-n.z, n.x) * 180) / Math.PI };
}

function atmosphere(r, color, power = 3.0) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Color(color) }, p: { value: power } },
      vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }",
      fragmentShader: "uniform vec3 c; uniform float p; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), p); gl_FragColor = vec4(c, f*0.9); }",
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
}

function stars(n = 1500, r = 60) {
  let s = 11;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const p = [];
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(r);
    p.push(v.x, v.y, v.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.1, color: 0xaab4cc, sizeAttenuation: false }));
}

const spriteCache = new Map();
function badgeTexture(text, bg, fg = "#08101f", ring = "#ffffff") {
  const key = text + bg + fg + ring;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(32, 32, 27, 0, 7); g.fillStyle = bg; g.fill();
  g.lineWidth = 4; g.strokeStyle = ring; g.stroke();
  g.fillStyle = fg; g.font = "bold 28px Space Grotesk, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 32, 34);
  const t = new THREE.CanvasTexture(c);
  spriteCache.set(key, t);
  return t;
}
function diamondTexture(color) {
  const key = "dia" + color;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.translate(16, 16); g.rotate(Math.PI / 4);
  g.fillStyle = color; g.strokeStyle = "#0a0f1c"; g.lineWidth = 3;
  g.fillRect(-8, -8, 16, 16); g.strokeRect(-8, -8, 16, 16);
  const t = new THREE.CanvasTexture(c);
  spriteCache.set(key, t);
  return t;
}

function makeRenderer(canvas) {
  const R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  return R;
}

function fitRenderer(R, cam, canvas) {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  if (canvas.width !== Math.floor(w * R.getPixelRatio()) || canvas.height !== Math.floor(h * R.getPixelRatio())) {
    R.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
}

// ======================================================================= Earth
export function createEarth(canvas, { texture }) {
  const R = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  cam.position.copy(vec3(20, -20, 3.4));
  const controls = new THREE.OrbitControls(cam, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 1.25, maxDistance: 6, rotateSpeed: 0.55, zoomSpeed: 0.7 });

  scene.add(new THREE.AmbientLight(0xffffff, 0.78));
  const sun = new THREE.DirectionalLight(0xffffff, 0.45);
  scene.add(sun);
  scene.add(stars());

  const loader = new THREE.TextureLoader();
  const earthTex = loader.load(texture);
  earthTex.anisotropy = R.capabilities.getMaxAnisotropy();
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.MeshPhongMaterial({ map: earthTex, shininess: 6, specular: 0x111111 }));
  scene.add(earth);

  const ovCanvas = document.createElement("canvas");
  ovCanvas.width = 1440; ovCanvas.height = 720;
  const ovTex = new THREE.CanvasTexture(ovCanvas);
  ovTex.minFilter = THREE.LinearFilter;
  const overlay = new THREE.Mesh(new THREE.SphereGeometry(1.002, 128, 96), new THREE.MeshBasicMaterial({ map: ovTex, transparent: true, depthWrite: false }));
  scene.add(overlay);
  scene.add(atmosphere(1.12, 0x4f8cff, 3.2));

  // graticule
  const gpts = [];
  for (let la = -60; la <= 60; la += 30) for (let lo = -180; lo < 180; lo += 3) gpts.push(vec3(la, lo, 1.004), vec3(la, lo + 3, 1.004));
  for (let lo = -180; lo < 180; lo += 30) for (let la = -87; la < 87; la += 3) gpts.push(vec3(la, lo, 1.004), vec3(la + 3, lo, 1.004));
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gpts), new THREE.LineBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.07 })));

  const markers = new THREE.Group();
  const known = new THREE.Group();
  scene.add(markers, known);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.026, 40), new THREE.MeshBasicMaterial({ color: 0xffb347, side: THREE.DoubleSide, transparent: true, depthTest: true }));
  ring.visible = false;
  scene.add(ring);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pickCb = null, hoverCb = null, markerCb = null;
  let downAt = null, fly = null, idleSpin = true;

  function pickAt(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const front = (h) => h.object.material.opacity > 0;
    const hm = ray.intersectObjects(markers.children, false).filter(front);
    if (hm.length) return { marker: hm[0].object.userData };
    const hk = known.visible ? ray.intersectObjects(known.children, false).filter(front) : [];
    if (hk.length) return { known: hk[0].object.userData };
    const h = ray.intersectObject(earth, false);
    return h.length ? latLonOf(h[0].point) : null;
  }
  canvas.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; idleSpin = false; fly = null; });
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const p = pickAt(e);
    if (!p) return;
    if (p.marker && markerCb) markerCb(p.marker);
    else if (p.known && pickCb) pickCb(p.known.lat, p.known.lon, p.known);
    else if (pickCb && p.lat != null) pickCb(p.lat, p.lon);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!hoverCb || e.buttons) return;
    const p = pickAt(e);
    const r = canvas.getBoundingClientRect();
    hoverCb(p, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener("pointerleave", () => hoverCb && hoverCb(null));
  canvas.addEventListener("wheel", () => { idleSpin = false; }, { passive: true });

  function setMarkers(list) {
    markers.clear();
    list.forEach((m, k) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(String(k + 1), m.isNew ? "#6fe0b0" : "#ffb347"), depthTest: true }));
      s.position.copy(vec3(m.lat, m.lon, 1.03));
      s.scale.setScalar(0.055);
      s.userData = { ...m, rank: k };
      s.renderOrder = 3;
      markers.add(s);
    });
  }
  function setKnown(list) {
    known.clear();
    for (const a of list) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: diamondTexture(a.facility ? "#8d97ab" : "#ffffff"), depthTest: true }));
      s.position.copy(vec3(a.lat, a.lon, 1.012));
      s.scale.setScalar(0.024);
      s.userData = a;
      known.add(s);
    }
  }
  function select(lat, lon) {
    if (lat == null) { ring.visible = false; return; }
    ring.visible = true;
    const p = vec3(lat, lon, 1.006);
    ring.position.copy(p);
    ring.lookAt(p.clone().multiplyScalar(2));
  }
  function flyTo(lat, lon, dist) {
    idleSpin = false;
    const from = cam.position.clone();
    const d = dist ?? Math.min(from.length(), 2.6);
    const to = vec3(lat, lon, 1).multiplyScalar(d);
    fly = { from, to, t: 0 };
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fitRenderer(R, cam, canvas);
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / 1.1);
      const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
      const a = fly.from.clone().normalize(), b = fly.to.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(a, b);
      const qi = new THREE.Quaternion().slerp(q, e);
      const len = fly.from.length() + (fly.to.length() - fly.from.length()) * e;
      cam.position.copy(a.applyQuaternion(qi).multiplyScalar(len));
      if (fly.t >= 1) fly = null;
    } else if (idleSpin) {
      cam.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.06);
    }
    sun.position.copy(cam.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.5).add(new THREE.Vector3(0, 1.5, 0));
    controls.update();
    // fade markers on the far side
    const cdir = cam.position.clone().normalize();
    for (const g of [markers, known]) for (const s of g.children) s.material.opacity = s.position.clone().normalize().dot(cdir) > 0.05 ? 1 : 0;
    R.render(scene, cam);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    overlayCanvas: ovCanvas,
    refreshOverlay() { ovTex.needsUpdate = true; },
    setMarkers, setKnown, select, flyTo,
    showKnown(v) { known.visible = v; },
    onPick(cb) { pickCb = cb; }, onHover(cb) { hoverCb = cb; }, onMarker(cb) { markerCb = cb; },
    stopSpin() { idleSpin = false; },
    snapshot() { return canvas.toDataURL("image/png"); },
  };
}

// ======================================================================= Moon / Mars picker
export function createMiniBody(canvas, { textures }) {
  const R = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  cam.position.set(0, 0, 3.6);
  const controls = new THREE.OrbitControls(cam, canvas);
  Object.assign(controls, { enableDamping: true, enablePan: false, enableZoom: false, rotateSpeed: 0.6 });
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  scene.add(sun);
  const loader = new THREE.TextureLoader();
  const tex = Object.fromEntries(Object.entries(textures).map(([k, u]) => [k, loader.load(u)]));
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshStandardMaterial({ map: tex.moon, roughness: 1, metalness: 0 }));
  scene.add(body);
  const glow = atmosphere(1.06, 0xffffff, 4);
  scene.add(glow);
  const pins = new THREE.Group();
  scene.add(pins);
  let pickCb = null, downAt = null, fly = null, current = "moon";

  function setBody(name, targets, selectedId) {
    current = name;
    body.material.map = tex[name];
    body.material.needsUpdate = true;
    glow.material.uniforms.c.value.set(name === "mars" ? 0xff9a6a : 0x9aa7c0);
    glow.material.uniforms.p.value = name === "mars" ? 3 : 6;
    pins.clear();
    for (const t of targets) {
      const sel = t.id === selectedId;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: diamondTexture(sel ? "#ffb347" : name === "mars" ? "#ffd2bd" : "#ffffff"), depthTest: true }));
      s.position.copy(vec3(t.lat, t.lon, 1.02));
      s.scale.setScalar(sel ? 0.13 : 0.08);
      s.userData = t;
      pins.add(s);
    }
  }
  function focus(lat, lon) {
    const from = cam.position.clone();
    const to = vec3(Math.max(-70, Math.min(70, lat)) * 1.0, lon, 3.6);
    if (Math.abs(lat) > 70) to.copy(vec3(Math.sign(lat) * 62, lon, 3.6));
    fly = { from, to, t: 0 };
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; fly = null; });
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    // tolerant pick: nearest visible pin in screen space
    let best = null, bd = 0.09;
    for (const s of pins.children) {
      if (s.position.clone().normalize().dot(cam.position.clone().normalize()) < 0.1) continue;
      const p = s.position.clone().project(cam);
      const d = Math.hypot(p.x - ndc.x, p.y - ndc.y);
      if (d < bd) { bd = d; best = s.userData; }
    }
    if (best && pickCb) pickCb(best);
  });
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fitRenderer(R, cam, canvas);
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / 0.9);
      const e = 1 - (1 - fly.t) ** 3;
      const a = fly.from.clone().normalize(), b = fly.to.clone().normalize();
      const q = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(a, b), e);
      cam.position.copy(a.applyQuaternion(q).multiplyScalar(3.6));
      if (fly.t >= 1) fly = null;
    }
    sun.position.copy(cam.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), current === "moon" ? 0.9 : 0.6);
    controls.update();
    R.render(scene, cam);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { setBody, focus, onPick(cb) { pickCb = cb; } };
}
