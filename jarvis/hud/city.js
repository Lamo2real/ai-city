// The City View: a procedural voxel city of the agents, drawn by three.js from city-state.js.
// Everything here is original blocky art built from boxes; nothing is copied from any game.
import * as THREE from "./vendor/three.module.js";
import { CORE, MODEL_COLOR, MODEL_NAME, agentPanel, agentStatus, applySnapshot, deptColor, deptOf, departmentPanel, fmt, initialState, layout, propFor, reduce, topBar } from "./city-state.js";

const REACTIONS = ["On it!", "Five more minutes...", "I swear it compiled locally", "Have you tried turning it off and on?", "Coffee first.", "Shipping it. Probably.", "Who touched my branch?", "Reviewing my own code. Bold.", "The tests pass on my machine", "Ask the manager."];
const PROP_COLOR = { laptop: 0xbfc7d5, camera: 0x222222, chart: 0x3bd36b, wrench: 0x9a9a9a, ticket: 0xffd21e, clipboard: 0xf4e4c1, coffee: 0x6b3e26, notebook: 0xe8d9b5, magnifier: 0x88ccff, baton: 0xffffff };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };
const rand = (seed) => { let x = Math.floor(hash(seed) * 1e9) || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; }; };

// Stockholm time decides day and night: 0 at midnight, 1 at noon.
export function daylight(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour").value) + Number(parts.find((p) => p.type === "minute").value) / 60;
  const light = Math.max(0, Math.min(1, (Math.cos(((h - 13) / 24) * Math.PI * 2) + 0.35) / 1.35));
  return { hour: h, light, text: new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" }).format(date) };
}

const box = (() => { const cache = new Map(); return (w, h, d) => { const k = `${w},${h},${d}`; if (!cache.has(k)) cache.set(k, new THREE.BoxGeometry(w, h, d)); return cache.get(k); }; })();
const mat = (() => { const cache = new Map(); return (color, extra = {}) => { const k = `${color},${JSON.stringify(extra)}`; if (!cache.has(k)) cache.set(k, new THREE.MeshLambertMaterial({ color, ...extra })); return cache.get(k); }; })();
const part = (w, h, d, color, x = 0, y = 0, z = 0, extra) => { const m = new THREE.Mesh(box(w, h, d), mat(color, extra)); m.position.set(x, y, z); return m; };

function textSprite(text, { fg = "#fff", bg = "rgba(10,6,4,.85)", size = 28, scale = 1 } = {}) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `${size}px "Share Tech Mono", monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w; c.height = size + 20;
  ctx.font = `${size}px "Share Tech Mono", monospace`;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.fillText(text, 12, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set((c.width / c.height) * 0.9 * scale, 0.9 * scale, 1);
  return s;
}

// A building: a stack of floors with lit windows, a door, a sign, built from instanced blocks.
function makeBuilding(name, color, isHq) {
  const g = new THREE.Group();
  const r = rand(name);
  const floors = isHq ? 7 : 2 + Math.floor(r() * 3);
  const w = isHq ? 6 : 4 + Math.floor(r() * 2), d = isHq ? 6 : 4 + Math.floor(r() * 2);
  const body = new THREE.Color(isHq ? 0x1b2a44 : 0x2a2f3a).lerp(new THREE.Color(color), 0.25);
  const blocks = [];
  for (let f = 0; f < floors; f++) blocks.push([0, f + 0.5, 0, w, 1, d]);
  const inst = new THREE.InstancedMesh(box(1, 1, 1), mat(0xffffff), blocks.length);
  const m = new THREE.Matrix4();
  blocks.forEach(([x, y, z, sx, sy, sz], i) => { m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)); inst.setMatrixAt(i, m); inst.setColorAt(i, body); });
  g.add(inst);
  // Windows: small emissive blocks on the two visible faces, lit at night.
  const windows = [];
  for (let f = 0; f < floors; f++) for (let i = 0; i < w - 1; i++) { windows.push([-w / 2 + 1 + i, f + 0.55, d / 2 + 0.02]); windows.push([w / 2 + 0.02, f + 0.55, -d / 2 + 1 + i]); }
  const winMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a, emissive: 0xffc46b, emissiveIntensity: 0.9 });
  const win = new THREE.InstancedMesh(box(0.5, 0.5, 0.08), winMat, windows.length);
  windows.forEach(([x, y, z], i) => { const rot = z > 0 ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); m.compose(new THREE.Vector3(x, y, z), rot, new THREE.Vector3(1, 1, 1)); win.setMatrixAt(i, m); });
  g.add(win);
  g.add(part(1.2, 1.6, 0.2, 0x3a2a1a, 0, 0.8, d / 2 + 0.1)); // door
  g.add(part(w + 0.6, 0.3, d + 0.6, color, 0, floors + 0.15, 0)); // roof trim in the department colour
  const lamp = part(0.5, 0.5, 0.5, 0x330000, w / 2 - 0.4, floors + 0.6, d / 2 - 0.4, { emissive: 0xff2020, emissiveIntensity: 0 });
  g.add(lamp);
  if (isHq) {
    const fountain = new THREE.Group();
    fountain.add(part(3, 0.4, 3, 0x30405a, 0, 0.2, 0));
    fountain.add(part(2.2, 0.3, 2.2, 0x2fb8ff, 0, 0.5, 0, { emissive: 0x2fb8ff, emissiveIntensity: 0.8 }));
    fountain.add(part(0.4, 1.6, 0.4, 0x9fe3ff, 0, 1.2, 0, { emissive: 0x9fe3ff, emissiveIntensity: 1 }));
    fountain.position.set(0, 0, d / 2 + 4);
    g.add(fountain);
    g.userData.fountain = fountain;
    const logo = part(2.4, 2.4, 0.2, 0x0a1a33, 0, floors - 1.5, d / 2 + 0.12, { emissive: 0x3b82ff, emissiveIntensity: 1 });
    g.add(logo);
  }
  const sign = textSprite(isHq ? "HQ" : name, { fg: color, size: 30, scale: 1.6 });
  sign.position.set(0, floors + 1.4, 0);
  g.add(sign);
  g.userData = { ...g.userData, name, floors, w, d, lamp, win: winMat, door: new THREE.Vector3(0, 0, d / 2 + 1.2), roof: new THREE.Vector3(0, floors + 0.3, 0) };
  return g;
}

// A character: legs, body, head, a hat for managers, a badge in the model colour above the head, a prop in hand.
function makeCharacter(agent, dept) {
  const g = new THREE.Group();
  const c = deptColor(dept);
  const skin = 0xf1c9a5, isJarvis = agent.id === "jarvis";
  const uniform = isJarvis ? 0x6fe3ff : agent.kind === "core" ? 0x2b2b33 : c;
  const extra = isJarvis ? { transparent: true, opacity: 0.6, emissive: 0x2fb8ff, emissiveIntensity: 0.9 } : undefined;
  const legL = part(0.3, 0.7, 0.3, 0x1e1e26, -0.2, 0.35, 0, extra), legR = part(0.3, 0.7, 0.3, 0x1e1e26, 0.2, 0.35, 0, extra);
  const body = part(0.8, 0.9, 0.5, uniform, 0, 1.15, 0, extra);
  const armL = part(0.22, 0.7, 0.22, uniform, -0.52, 1.2, 0, extra), armR = part(0.22, 0.7, 0.22, uniform, 0.52, 1.2, 0, extra);
  const head = part(0.7, 0.7, 0.7, isJarvis ? 0x9ff0ff : skin, 0, 1.95, 0, extra);
  const eyes = part(0.5, 0.1, 0.05, 0x101010, 0, 2.0, 0.36);
  g.add(legL, legR, body, armL, armR, head, eyes);
  if (agent.kind === "manager") g.add(part(0.85, 0.3, 0.85, c, 0, 2.4, 0), part(1.1, 0.1, 1.1, c, 0, 2.27, 0)); // hard hat
  if (agent.id === "orchestrator") g.add(part(0.9, 0.25, 0.9, 0x111111, 0, 2.42, 0)); // conductor's cap
  if (agent.id === "reviewer") { g.add(part(0.9, 0.2, 0.9, 0x4a3a6a, 0, 2.4, 0)); } // inspector's hat
  const badge = new THREE.Sprite(new THREE.SpriteMaterial({ color: MODEL_COLOR[agent.model] ?? "#ccc", depthTest: false }));
  badge.scale.set(0.45, 0.45, 1); badge.position.set(0, 2.95, 0);
  g.add(badge);
  const propKind = agent.id === "secretary" ? "notebook" : agent.id === "reviewer" ? "clipboard" : agent.id === "orchestrator" ? "baton" : propFor(agent);
  const prop = propKind ? part(propKind === "baton" ? 0.08 : 0.5, propKind === "baton" ? 0.9 : 0.35, 0.1, PROP_COLOR[propKind] ?? 0xcccccc, 0.75, 1.0, 0.2) : null;
  if (prop) g.add(prop);
  if (agent.id === "reviewer") g.add(part(0.3, 0.3, 0.1, PROP_COLOR.magnifier, -0.75, 1.0, 0.2, { emissive: 0x88ccff, emissiveIntensity: 0.5 }));
  const mug = part(0.3, 0.3, 0.3, PROP_COLOR.coffee, -0.75, 1.0, 0.2); mug.visible = false; g.add(mug);
  const mark = textSprite("?", { fg: "#ffd21e", bg: "rgba(0,0,0,0)", size: 48 }); mark.position.set(0, 3.6, 0); mark.visible = false; g.add(mark);
  const label = textSprite(agent.id, { size: 24, scale: 0.8 }); label.position.set(0, -0.5, 0); label.visible = false; g.add(label);
  g.userData = { agent, legL, legL0: 0, legR, armL, armR, body, head, prop, mug, mark, label, badge, walk: null, bob: hash(agent.id) * Math.PI * 2, reaction: null, bubble: null };
  return g;
}

// `events` is where the one shared stream is re-dispatched (jarvis-sse, jarvis-sse-open, jarvis-sse-error); tests can inject their own target.
// `snapshotImpl` fetches /api/city; the page shares one in-flight request between its views.
export function mountCity(root, { fetchImpl = fetch, events = document, snapshotImpl = globalThis.jarvisSnapshot } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const canvas = $("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
  const view = { target: new THREE.Vector3(0, 0, 0), zoom: 1.3, wantZoom: 1.3, wantTarget: new THREE.Vector3(0, 0, 0), zoomedInto: null };
  camera.position.set(60, 60, 60);
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(30, 60, 20);
  const sky = new THREE.HemisphereLight(0x8fb0ff, 0x1a1008, 0.8);
  scene.add(sun, sky);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), mat(0x0f1a12)));

  let state = initialState();
  const buildings = new Map(); // dept → group
  const people = new Map(); // id → group
  let roads = null, trees = null;
  const effects = []; // sparks, smoke, confetti: { mesh, until, update }
  const clickable = { buildings: [], people: [] };

  function setupLayout() {
    const l = layout(state);
    const places = [l.hq, ...l.buildings];
    for (const p of places) {
      if (!buildings.has(p.dept)) {
        const b = makeBuilding(p.dept, p.color, p.dept === "HQ");
        b.position.set(p.x, 0, p.z);
        b.userData.builtAt = p.builtAt ?? 0;
        scene.add(b);
        buildings.set(p.dept, b);
      }
    }
    // Roads: a cross through HQ and a ring, from instanced dark blocks. Trees in the gaps.
    if (roads) scene.remove(roads);
    if (trees) scene.remove(trees);
    const span = 14 * (1 + Math.floor(Math.max(0, l.buildings.length - 1) / 12)) + 9;
    const tiles = [];
    for (let i = -span; i <= span; i++) { tiles.push([i, 0, 0]); tiles.push([0, 0, i]); tiles.push([i, 0, span]); tiles.push([i, 0, -span]); tiles.push([span, 0, i]); tiles.push([-span, 0, i]); }
    roads = new THREE.InstancedMesh(box(1, 0.1, 1), mat(0x1b1b22), tiles.length);
    const m = new THREE.Matrix4();
    tiles.forEach(([x, y, z], i) => { m.makeTranslation(x, y, z); roads.setMatrixAt(i, m); });
    scene.add(roads);
    const r = rand("trees"), spots = [];
    const taken = places.map((p) => new THREE.Vector2(p.x, p.z));
    for (let i = 0; i < 90; i++) {
      const v = new THREE.Vector2((r() - 0.5) * span * 2.2, (r() - 0.5) * span * 2.2);
      if (Math.abs(v.x) < 1.5 || Math.abs(v.y) < 1.5 || Math.abs(Math.abs(v.x) - span) < 1.5 || Math.abs(Math.abs(v.y) - span) < 1.5) continue;
      if (taken.some((t) => t.distanceTo(v) < 6)) continue;
      spots.push(v);
    }
    trees = new THREE.Group();
    const trunk = new THREE.InstancedMesh(box(0.3, 1, 0.3), mat(0x4a2f1a), spots.length), crown = new THREE.InstancedMesh(box(1.4, 1.4, 1.4), mat(0x1f6a35), spots.length);
    spots.forEach((v, i) => { m.makeTranslation(v.x, 0.5, v.y); trunk.setMatrixAt(i, m); m.makeTranslation(v.x, 1.6, v.y); crown.setMatrixAt(i, m); });
    trees.add(trunk, crown);
    scene.add(trees);
    clickable.buildings = [...buildings.values()];
    syncPeople();
    renderDom();
  }

  const home = (agent) => {
    const dept = deptOf(agent), b = buildings.get(dept) ?? buildings.get("HQ");
    const bp = b.position;
    if (agent.id === "jarvis") return new THREE.Vector3(bp.x + 2.2, 0, bp.z + b.userData.d / 2 + 4);
    if (agent.id === "orchestrator") return new THREE.Vector3(bp.x, b.userData.floors + 0.3, bp.z);
    if (agent.id === "secretary") return new THREE.Vector3(bp.x - 3, 0, bp.z + b.userData.d / 2 + 1.5);
    if (agent.id === "reviewer") return new THREE.Vector3(bp.x + 4, 0, bp.z + b.userData.d / 2 + 1.5);
    const siblings = Object.values(state.agents).filter((a) => deptOf(a) === dept && !CORE.has(a.id)).map((a) => a.id).sort();
    const i = Math.max(0, siblings.indexOf(agent.id));
    return new THREE.Vector3(bp.x - b.userData.w / 2 + 1 + (i % 5) * 1.3, 0, bp.z + b.userData.d / 2 + 1.5 + Math.floor(i / 5) * 1.4);
  };
  const edge = (v) => new THREE.Vector3(Math.sign(v.x || 1) * 60, 0, v.z);

  function syncPeople() {
    for (const a of Object.values(state.agents)) {
      let p = people.get(a.id);
      if (!p) {
        if (a.state === "retired" && !state.recent[a.id]) continue; // long gone: not drawn
        p = makeCharacter(a, deptOf(a));
        const h = home(a);
        const fresh = state.recent[a.id]?.kind === "hired" && !reduced();
        p.position.copy(fresh ? edge(h) : h);
        if (fresh) p.userData.walk = { to: h.clone(), speed: 6 };
        scene.add(p);
        people.set(a.id, p);
      }
      p.userData.agent = a;
      if (a.state === "retired" && !p.userData.leaving) {
        p.userData.leaving = true;
        p.userData.walk = { to: edge(p.position), speed: 5, then: () => { scene.remove(p); people.delete(a.id); clickable.people = [...people.values()]; } };
        if (reduced()) p.userData.walk.then();
      }
    }
    clickable.people = [...people.values()];
  }

  // Jogs and walks: the Secretary carries a summary to Jarvis, the Inspector goes to a door.
  function onEvent(e) {
    const before = state;
    state = reduce(state, e);
    if (e.type === "agent.hired" || e.type === "agent.retired") setupLayout(); else syncPeople();
    if (e.type === "result" || (e.type === "ticket.status" && e.ticket.to === "orchestrator" && e.ticket.status === "done")) {
      const s = people.get("secretary"), j = people.get("jarvis");
      if (s && j) s.userData.walk = { to: j.position.clone().add(new THREE.Vector3(-1.2, 0, 0)), speed: 9, then: () => { s.userData.walk = { to: home(s.userData.agent), speed: 7 }; } };
    }
    if (e.type === "review.started") {
      const t = state.tickets[e.ticket_id], agent = t && state.agents[t.to], b = agent && buildings.get(deptOf(agent)), r = people.get("reviewer");
      if (b && r) r.userData.walk = { to: b.position.clone().add(b.userData.door), speed: 6 };
    }
    if (e.type === "review.result") {
      const r = people.get("reviewer");
      if (r) r.userData.walk = { to: home(r.userData.agent), speed: 6 };
      const t = before.tickets[e.ticket_id], agent = t && state.agents[t.to], b = agent && buildings.get(deptOf(agent));
      if (b && e.verdict === "FAIL") { b.userData.lampUntil = performance.now() + 20000; if (!reduced()) smoke(b.position.clone().add(new THREE.Vector3(0, b.userData.floors + 0.5, 0))); }
    }
    if (e.type === "ticket.status" && e.ticket.status === "done" && !reduced()) { const p = people.get(e.ticket.to); if (p) confetti(p.position.clone().add(new THREE.Vector3(0, 2.5, 0))); }
    if (e.type === "question.asked" || e.type === "question.answered" || e.type === "cost.update" || e.type === "ticket.status") renderDom();
    feedDom();
  }

  // Effects: little instanced bursts with a lifetime.
  function burst(origin, n, colors, size, speed, gravity, life) {
    const inst = new THREE.InstancedMesh(box(size, size, size), mat(0xffffff), n);
    const vel = [], pos = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) { pos.push(origin.clone()); vel.push(new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed)); inst.setColorAt(i, new THREE.Color(colors[i % colors.length])); m.makeTranslation(origin.x, origin.y, origin.z); inst.setMatrixAt(i, m); }
    scene.add(inst);
    effects.push({ mesh: inst, until: performance.now() + life, update: (dt) => { for (let i = 0; i < n; i++) { vel[i].y -= gravity * dt; pos[i].addScaledVector(vel[i], dt); m.makeTranslation(pos[i].x, pos[i].y, pos[i].z); inst.setMatrixAt(i, m); } inst.instanceMatrix.needsUpdate = true; } });
  }
  const confetti = (o) => burst(o, 60, [0xff6a1a, 0xffd21e, 0x2fd36b, 0x3b82ff, 0xa86bff, 0xffffff], 0.18, 7, 9, 1800);
  const smoke = (o) => burst(o, 24, [0x555555, 0x777777, 0x999999], 0.5, 1.2, -1.5, 2500);
  const sparks = (o) => burst(o, 6, [0xffe08a, 0xffb347], 0.08, 3, 6, 400);

  // Interaction: wheel and pinch zoom, drag pan, click, double-click, Esc.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let drag = null, pointers = new Map(), pinchDist = 0;
  const pick = (ev) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hitP = ray.intersectObjects(clickable.people, true)[0];
    if (hitP) { let o = hitP.object; while (o && !o.userData.agent) o = o.parent; if (o) return { agent: o }; }
    const hitB = ray.intersectObjects(clickable.buildings, true)[0];
    if (hitB) { let o = hitB.object; while (o && !o.userData.name) o = o.parent; if (o) return { building: o }; }
    return null;
  };
  canvas.addEventListener("wheel", (ev) => { ev.preventDefault(); const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)); view.wantZoom = Math.max(0.35, Math.min(6, view.wantZoom * f)); }, { passive: false });
  canvas.addEventListener("pointerdown", (ev) => { pointers.set(ev.pointerId, ev); canvas.setPointerCapture(ev.pointerId); if (pointers.size === 1) drag = { x: ev.clientX, y: ev.clientY, moved: false, t: new THREE.Vector3().copy(view.wantTarget) }; });
  canvas.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, ev);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); if (pinchDist) view.wantZoom = Math.max(0.35, Math.min(6, view.wantZoom * (d / pinchDist))); pinchDist = d; drag = null; return; }
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    const k = 1 / (view.zoom * 10);
    // Screen right is world (+x,-z), screen down is world (+x,+z) in this isometric view.
    view.wantTarget.set(drag.t.x - (dx + dy) * k * 0.9, 0, drag.t.z - (dy - dx) * k * 0.9);
  });
  const endPointer = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (drag && !drag.moved && ev.type === "pointerup") { const hit = pick(ev); if (hit?.agent) clickAgent(hit.agent); else if (hit?.building) openDept(hit.building.userData.name); }
    if (!pointers.size) drag = null;
  };
  canvas.addEventListener("pointerup", endPointer); canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("dblclick", (ev) => { const hit = pick(ev); if (hit?.building) zoomInto(hit.building); });
  root.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { if (view.zoomedInto) zoomOut(); else closePanel(); } });
  const zoomInto = (b) => { view.zoomedInto = b.userData.name; view.wantTarget.copy(b.position); view.wantZoom = 3.2; };
  const zoomOut = () => { view.zoomedInto = null; view.wantTarget.set(0, 0, 0); view.wantZoom = 1.3; };

  function clickAgent(p) {
    const u = p.userData, id = u.agent.id;
    if (!reduced()) {
      const kind = ["jump", "spin", "sweat", "bubble"][Math.floor(Math.random() * 4)];
      u.reaction = { kind, until: performance.now() + 900 };
      if (kind === "bubble") { if (u.bubble) { u.bubble.removeFromParent(); u.bubble.material.map.dispose(); u.bubble.material.dispose(); } u.bubble = textSprite(REACTIONS[Math.floor(Math.random() * REACTIONS.length)], { size: 26 }); u.bubble.position.set(0, 3.7, 0); p.add(u.bubble); u.bubbleUntil = performance.now() + 2200; }
      if (kind === "sweat") burst(p.position.clone().add(new THREE.Vector3(0.3, 2.3, 0.3)), 5, [0x66ccff], 0.12, 1.5, 4, 700);
    }
    openAgent(id);
  }

  // DOM panels: built with textContent only.
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const panel = $("#citypanel");
  let open = null;
  function closePanel() { open = null; panel.hidden = true; panel.replaceChildren(); }
  function showPanel(title, kind) {
    panel.hidden = false; panel.replaceChildren();
    const head = el("header"); head.append(el("h3", null, title), (() => { const b = el("button", "ibtn", "×"); b.setAttribute("aria-label", "Close"); b.onclick = closePanel; return b; })());
    panel.append(head);
    panel.dataset.kind = kind;
    panel.querySelector("button")?.focus();
    return panel;
  }
  const row = (k, v) => { const r = el("div", "row"); r.append(el("span", "k", k), el("span", "v", v)); return r; };
  async function openAgent(id) {
    open = { agent: id };
    let audit = [];
    try { audit = await (await fetchImpl(`./api/city/audit?agent=${encodeURIComponent(id)}`)).json(); } catch { /* unknown: shown as nothing */ }
    const p = agentPanel(state, id, audit);
    if (!p) return;
    const box = showPanel(`${p.role}`, "agent");
    const badge = el("span", "badge", p.modelName); badge.style.background = p.modelColor;
    box.append(badge);
    box.append(row("id", p.id), row("model", p.model), row("department", p.department), row("reports to", p.parent), row("status", p.status.replace(/_/g, " ")), row("ticket", p.ticket ? `${p.ticket.status.replace(/_/g, " ")}: ${p.ticket.goal}` : "—"), row("cost so far", p.costUsd === null ? "—" : `$${fmt(p.costUsd, 3)}`), row("tokens today", p.tokensToday === null ? "—" : String(p.tokensToday)));
    box.append(el("h4", null, "Last actions"));
    const ul = el("ul", "actions");
    if (!p.actions.length) ul.append(el("li", "mute", "—"));
    for (const a of p.actions) ul.append(el("li", null, a.text));
    box.append(ul);
    const form = el("form", "instruct");
    const input = el("input"); input.placeholder = `@${p.id} …`; input.setAttribute("aria-label", `Direct instruction to ${p.id}`);
    const send = el("button", null, "Send"); send.type = "submit";
    const note = el("div", "mute");
    form.append(input, send, note);
    form.onsubmit = async (ev) => { ev.preventDefault(); const text = input.value.trim(); if (!text) return; const line = text.startsWith("@") ? text : `@${p.id} ${text}`; try { const r = await fetchImpl("./api/city/instruct", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: line }) }); const j = await r.json(); note.textContent = r.ok ? `Sent as ticket ${j.ticket.id}, manager cc'd.` : j.error; if (r.ok) input.value = ""; } catch { note.textContent = "Could not reach the server."; } };
    box.append(form);
  }
  function openDept(name) {
    open = { dept: name };
    const d = departmentPanel(state, name);
    const box = showPanel(`${name === "HQ" ? "Headquarters" : `${name} department`}`, "department");
    box.append(row("manager", d.manager ?? "—"), row("workers", d.workers.length ? d.workers.join(", ") : "—"), row("today's cost", d.todayUsd === null ? "—" : `$${fmt(d.todayUsd, 2)}`));
    box.append(el("h4", null, `Open tickets (${d.openTickets.length})`));
    const ul = el("ul", "tickets");
    if (!d.openTickets.length) ul.append(el("li", "mute", "—"));
    for (const t of d.openTickets) ul.append(el("li", null, `${t.to}: ${t.status.replace(/_/g, " ")} — ${t.goal}`));
    box.append(ul);
    const b = buildings.get(name); if (b) { const z = el("button", "ibtn wide", "Zoom in"); z.onclick = () => zoomInto(b); box.append(z); }
  }

  function renderDom() {
    const t = topBar(state), d = daylight();
    $("#citytop").replaceChildren(
      stat("AGENTS", `${t.agentsActive} active · ${t.agentsTotal} total`), stat("TICKETS RUNNING", String(t.ticketsRunning)), stat("QUESTIONS", String(t.questionsWaiting)),
      stat("USAGE TODAY", t.usage ? `${t.usage.turns} turns · ${Math.round(t.usage.tokens / 1000)}k tokens · $${fmt(t.usage.usd, 2)}` : "—"),
      stat("STOCKHOLM", `${d.text} ${d.light > 0.5 ? "☀" : d.light > 0.2 ? "◐" : "☾"}`),
    );
    const list = $("#citydepts"); list.replaceChildren(el("h3", null, "Departments"));
    for (const name of ["HQ", ...Object.keys(state.departments)]) { const b = el("button", "dept", name); b.style.borderLeftColor = deptColor(name); b.dataset.building = name; b.onclick = () => openDept(name); list.append(b); }
    const a11y = $("#citylist"); a11y.replaceChildren();
    for (const name of ["HQ", ...Object.keys(state.departments)]) { const b = el("button", null, `Building: ${name}`); b.dataset.building = name; b.onclick = () => openDept(name); a11y.append(b); }
    for (const a of Object.values(state.agents)) { if (a.state === "retired") continue; const b = el("button", null, `Agent: ${a.id} (${a.role}, ${MODEL_NAME[a.model] ?? a.model})`); b.dataset.agent = a.id; b.onclick = () => { const p = people.get(a.id); if (p) clickAgent(p); else openAgent(a.id); }; a11y.append(b); }
    feedDom();
    if (open?.dept) openDept(open.dept);
  }
  const stat = (k, v) => { const s = el("div", "stat"); s.append(el("span", "k", k), el("b", null, v)); return s; };
  function feedDom() {
    const feed = $("#cityfeed"); feed.replaceChildren(el("h3", null, "Activity"));
    if (!state.feed.length) feed.append(el("div", "mute", "Quiet. Nothing has happened yet."));
    for (const f of state.feed.slice(0, 8)) { const line = el("div", `line ${f.kind}`); line.append(el("span", "t", new Date(f.at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })), el("span", null, f.text)); feed.append(line); }
  }

  // Data: a snapshot, then events. If either is missing the view says so; it never fills the gap with made-up data.
  let streamLost = false; // streamLost: the live stream dropped and has not come back yet
  const problem = (text) => { const e = $("#cityerror"); e.textContent = text ?? ""; e.hidden = !text; };
  async function load() {
    for (const p of people.values()) scene.remove(p); people.clear();
    for (const b of buildings.values()) scene.remove(b); buildings.clear();
    try {
      const r = snapshotImpl ? await snapshotImpl() : await fetchImpl("./api/city");
      const snap = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(snap.error || `server error ${r.status}`);
      state = applySnapshot(state, snap);
      problem(null);
    } catch (err) {
      state = applySnapshot(state, { agents: [], tickets: [], questions: [], usage: null, spend: {} });
      problem(`Can't reach Jarvis (${err.message === "Failed to fetch" ? "no connection" : err.message}). Nothing is shown until it answers.`);
    }
    setupLayout();
  }
  // The one shared stream. A drop is shown; on reconnect events may have been missed, so start again from a fresh snapshot.
  events.addEventListener("jarvis-sse", (ev) => { const j = ev.detail; if (j?.type === "city") onEvent(j.event); else if (j?.type === "jarvis") onEvent({ type: "result", ticket_id: "", status: "done", summary: j.text }); });
  events.addEventListener("jarvis-sse-error", () => { streamLost = true; problem("Live updates from Jarvis stopped. Reconnecting…"); });
  events.addEventListener("jarvis-sse-open", () => { if (streamLost) { streamLost = false; problem(null); load(); } });

  // The frame loop: walks, bobs, status animations, camera tweens, day and night.
  let last = performance.now(), fpsN = 0, fpsT = last;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const still = reduced();
    view.zoom += (view.wantZoom - view.zoom) * (still ? 1 : Math.min(1, dt * 6));
    view.target.lerp(view.wantTarget, still ? 1 : Math.min(1, dt * 6));
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    const s = 22 / view.zoom, aspect = w / Math.max(1, h);
    camera.left = -s * aspect; camera.right = s * aspect; camera.top = s; camera.bottom = -s;
    camera.position.set(view.target.x + 60, 60, view.target.z + 60); camera.lookAt(view.target); camera.updateProjectionMatrix();
    const d = daylight();
    sun.intensity = 0.25 + d.light * 0.9; sky.intensity = 0.35 + d.light * 0.5;
    (scene.background ??= new THREE.Color()).setHSL(0.62, 0.5, 0.03 + d.light * 0.35);
    for (const b of buildings.values()) {
      b.userData.win.emissiveIntensity = 1 - d.light * 0.85;
      const age = (Date.now() - (b.userData.builtAt || 0)) / 1000; // builtAt is epoch time from the state
      b.scale.y = still || age > 2 || !b.userData.builtAt ? 1 : Math.max(0.05, Math.min(1, age / 2));
      b.userData.lamp.material = mat(0x330000, { emissive: 0xff2020, emissiveIntensity: b.userData.lampUntil > now ? 1 : 0 });
      if (b.userData.fountain && !still) b.userData.fountain.children[2].scale.y = 1 + Math.sin(now / 300) * 0.2;
    }
    for (const p of people.values()) {
      const u = p.userData, a = u.agent, st = agentStatus(state, a.id, Date.now());
      if (u.walk) {
        const to = u.walk.to, dist = p.position.distanceTo(to);
        if (dist < 0.1 || still) { p.position.copy(to); const then = u.walk.then; u.walk = null; then?.(); } else { p.position.lerp(to, Math.min(1, (u.walk.speed * dt) / dist)); p.lookAt(to.x, p.position.y, to.z); const sw = Math.sin(now / 90) * 0.5; u.legL.rotation.x = sw; u.legR.rotation.x = -sw; u.armL.rotation.x = -sw; u.armR.rotation.x = sw; }
      } else if (!still) {
        u.legL.rotation.x = u.legR.rotation.x = 0;
        const typing = st === "working" ? Math.sin(now / 70 + u.bob) * 0.35 : 0;
        u.armL.rotation.x = -0.6 * (st === "working") + typing; u.armR.rotation.x = -0.6 * (st === "working") - typing;
        if (a.id === "jarvis") p.position.y = 0.4 + Math.sin(now / 600) * 0.2;
        if (a.id === "orchestrator") u.prop && (u.prop.rotation.z = Math.sin(now / 250) * 0.8);
        if (st === "working" && Math.random() < dt * 1.5) sparks(p.position.clone().add(new THREE.Vector3(0.6, 1.4, 0.4)));
      }
      u.mug.visible = st === "idle" && !CORE.has(a.id);
      u.mark.visible = st === "waiting_on_owner";
      if (u.mark.visible && !still) u.mark.position.y = 3.6 + Math.abs(Math.sin(now / 250)) * 0.5;
      u.label.visible = view.zoom > 1.8;
      if (u.reaction) {
        const k = (u.reaction.until - now) / 900;
        if (k <= 0) { u.reaction = null; p.rotation.y = 0; u.body.position.y = 1.15; } else if (u.reaction.kind === "jump") p.position.y = Math.sin((1 - k) * Math.PI) * 1.2; else if (u.reaction.kind === "spin") p.rotation.y = (1 - k) * Math.PI * 2;
      }
      if (u.bubble && u.bubbleUntil < now) { u.bubble.removeFromParent(); u.bubble.material.map.dispose(); u.bubble.material.dispose(); u.bubble = null; }
    }
    for (let i = effects.length - 1; i >= 0; i--) { const e = effects[i]; e.update(dt); if (e.until < now) { scene.remove(e.mesh); effects.splice(i, 1); } }
    renderer.render(scene, camera);
    fpsN++; if (now - fpsT > 2000) { root.dataset.fps = String(Math.round((fpsN * 1000) / (now - fpsT))); fpsN = 0; fpsT = now; }
    if (root.offsetParent !== null) requestAnimationFrame(frame); else paused = true;
  }
  let paused = true;
  const resume = () => { if (paused) { paused = false; last = performance.now(); requestAnimationFrame(frame); } };
  root.dataset.cityReady = "1";
  load().then(resume);
  return { resume, get state() { return state; }, onEvent };
}

// The HUD opens the view; the city mounts itself the first time, then only resumes its frame loop.
let city = null;
function openView() {
  const root = document.getElementById("city");
  if (!city) city = mountCity(root);
  else city.resume();
}
document.addEventListener("jarvis-view", (ev) => { if (ev.detail === "city") openView(); });
if (document.body.classList.contains("view-city")) openView(); // opened by the URL before this module loaded
