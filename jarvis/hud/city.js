// The City View: a procedural voxel city of the agents, drawn by three.js from city-state.js.
// Everything here is original blocky art built from boxes; nothing is copied from any game.
import * as THREE from "./vendor/three.module.js";
import { CORE, COST_NOTE, INTEGRATION_MEANS, MODEL_COLOR, MODEL_NAME, ageText, agentPanel, agentStatus, applyLive, applySnapshot, checkText, courierFor, departmentNames, departmentPanel, deptColor, deptOf, estUsd, gateStatus, initialState, integrationGroups, layout, parkedRows, propFor, reduce, relTime, stockholmTime, topBar, traceLines, usdRows, workforceGroups } from "./city-state.js";

const REACTIONS = ["On it!", "Five more minutes...", "I swear it compiled locally", "Have you tried turning it off and on?", "Coffee first.", "Shipping it. Probably.", "Who touched my branch?", "Reviewing my own code. Bold.", "The tests pass on my machine", "Ask the manager."];
const PROP_COLOR = { laptop: 0xbfc7d5, camera: 0x222222, chart: 0x3bd36b, wrench: 0x9a9a9a, ticket: 0xffd21e, clipboard: 0xf4e4c1, coffee: 0x6b3e26, notebook: 0xe8d9b5, magnifier: 0x88ccff, baton: 0xffffff };
// A worker in one of these states wears the mark over its head. Waiting on the owner has its own question mark.
const STATE_MARK = { failed: ["!", "#ff3b2e"], blocked: ["!", "#ffd21e"], paused: ["II", "#9fd0ff"], cancelled: ["x", "#b57a4a"] };
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
    for (const [name, b] of buildings) if (!places.some((p) => p.dept === name)) { scene.remove(b); buildings.delete(name); } // deleted or renamed
    for (const p of places) {
      if (!buildings.has(p.dept)) {
        const b = makeBuilding(p.dept, p.color, p.dept === "HQ");
        b.position.set(p.x, 0, p.z);
        b.userData.builtAt = p.builtAt ?? 0;
        scene.add(b);
        buildings.set(p.dept, b);
      }
      buildings.get(p.dept).visible = !p.archived;
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
    clickable.buildings = [...buildings.values()].filter((b) => b.visible);
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
    if (e.type === "agent.hired" || e.type === "agent.retired" || e.type === "department.created" || e.type === "department.updated") setupLayout(); else syncPeople();
    const hop = courierFor(e); if (hop) courier(hop);
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
    if (["question", "question.asked", "question.answered", "cost.update", "ticket.status", "worker.state", "tickets.parked", "city.paused", "city.resumed"].includes(e.type)) renderDom();
    // The gate's counters and the open panel's numbers only come from the server: read them again once the events settle.
    if (["ticket.status", "worker.state", "cost.update", "tickets.parked", "city.paused", "city.resumed", "turn.failed"].includes(e.type)) refreshSoon();
    if (open?.agent) { const v = panel.querySelector("[data-status] .v"); if (v) v.textContent = agentStatus(state, open.agent).replace(/_/g, " "); }
    feedDom();
  }

  // A parcel carried between two agents, only when a real ticket event says it moved.
  function courier({ from, to, kind }) {
    const a = people.get(from), b = people.get(to);
    if (!a || !b || reduced()) return;
    const parcel = part(0.5, 0.35, 0.5, kind === "ticket" ? 0xffd21e : 0x2fd36b, 0, 0, 0, { emissive: kind === "ticket" ? 0x665200 : 0x0f5a2c });
    const start = a.position.clone().add(new THREE.Vector3(0, 1.4, 0)), life = 1400;
    let t = 0;
    parcel.position.copy(start);
    scene.add(parcel);
    effects.push({ mesh: parcel, until: performance.now() + life, update: (dt) => {
      t = Math.min(1, t + (dt * 1000) / life);
      parcel.position.lerpVectors(start, b.position, t);
      parcel.position.y += 1.4 * (1 - t) + Math.sin(t * Math.PI) * 3;
    } });
    root.dataset.couriers = String(Number(root.dataset.couriers ?? 0) + 1);
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
    // The same panel redrawn with fresher data keeps the reader's place and focus.
    const same = !panel.hidden && panel.dataset.kind === kind, top = panel.scrollTop;
    panel.hidden = false; panel.replaceChildren();
    const head = el("header"); head.append(el("h3", null, title), (() => { const b = el("button", "ibtn", "×"); b.setAttribute("aria-label", "Close"); b.onclick = closePanel; return b; })());
    panel.append(head);
    panel.dataset.kind = kind;
    if (same) requestAnimationFrame(() => { panel.scrollTop = top; }); else panel.querySelector("button")?.focus();
    return panel;
  }
  const row = (k, v) => { const r = el("div", "row"); r.append(el("span", "k", k), el("span", "v", v)); return r; };
  const costNote = () => el("p", "hint costnote", COST_NOTE);
  const button = (cls, text, onclick) => { const b = el("button", cls, text); b.type = "button"; b.onclick = onclick; return b; };
  // Where a panel's Back goes.
  const reopen = (o) => { if (o?.agent) openAgent(o.agent); else if (o?.dept) openDept(o.dept); else if (o?.parked) openParked(); else if (o?.data) openData(o.data); };
  const storyButton = (id) => { const from = open; return button("act", "Story", () => openData(storyView(id, from))); };
  async function openAgent(id) {
    open = { agent: id };
    const mine = open;
    let audit = [];
    try { audit = await (await fetchImpl(`./api/city/audit?agent=${encodeURIComponent(id)}`)).json(); } catch { /* unknown: shown as nothing */ }
    if (open !== mine) return; // closed or replaced while the audit was on its way
    const p = agentPanel(state, id, Array.isArray(audit) ? audit : []);
    if (!p) return;
    const box = showPanel(`${p.role}`, "agent");
    const badge = el("span", "badge", p.modelName); badge.style.background = p.modelColor;
    box.append(badge);
    const statusRow = row("status", p.status.replace(/_/g, " ")); statusRow.dataset.status = "";
    box.append(row("id", p.id), row("model", p.model), row("department", p.department), row("reports to", p.parent), statusRow);
    if (p.executor) box.append(row("runs on", p.executor));
    box.append(row("ticket", p.ticket ? `${p.ticket.status.replace(/_/g, " ")}: ${p.ticket.goal}` : "—"), row("cost so far", p.costUsd === null ? "—" : estUsd(p.costUsd, 3)), row("tokens today", p.tokensToday === null ? "—" : String(p.tokensToday)), costNote());
    const storyId = p.ticket?.id ?? p.lastTicket;
    if (storyId) box.append(button("act", p.ticket ? "Story of this ticket" : `Story of ${storyId}`, () => openData(storyView(storyId, mine))));
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
    if (d.state === "archived") box.append(el("p", "hint", "Archived. It has no building and no active agents until it is reactivated."));
    if (d.mission) box.append(row("mission", d.mission));
    box.append(row("manager", d.manager ?? "—"), row("workers", d.workers.length ? d.workers.map((w) => `${w} (${d.workerStates[w].replace(/_/g, " ")})`).join(", ") : "—"), row("today's cost, UTC", d.todayUsd === null ? "—" : estUsd(d.todayUsd)), costNote());
    box.append(el("h4", null, `Open tickets (${d.openTickets.length})`));
    const ul = el("ul", "tickets");
    if (!d.openTickets.length) ul.append(el("li", "mute", "—"));
    for (const t of d.openTickets) { const li = el("li", "withact"); li.append(el("span", null, `${t.to}: ${t.status.replace(/_/g, " ")} — ${t.goal}`), storyButton(t.id)); ul.append(li); }
    box.append(ul);
    if (d.released.length) {
      box.append(el("h4", null, `Released (${d.released.length})`));
      const past = el("ul", "tickets");
      for (const r of d.released) { const li = el("li", "withact"); li.append(el("span", null, `${r.id}: ${r.role}`), button("act", "Details", () => openAgent(r.id))); past.append(li); }
      box.append(past);
    }
    const b = buildings.get(name); if (b?.visible) { const z = el("button", "ibtn wide", "Zoom in"); z.onclick = () => zoomInto(b); box.append(z); }
  }

  // ---------- Panels read from the backend. The phone listener answers 403 for these routes; the panel says so. ----------
  async function getJson(url) {
    try {
      const r = await fetchImpl(url);
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) return { restricted: true };
      return r.ok ? { data: j } : { error: j.error || `server error ${r.status}` };
    } catch { return { error: "no connection" }; }
  }
  const unavailable = (res, what) => el("p", "mute", res.restricted ? `${what} is not available from the phone. Open Jarvis on the Mac to see it.` : `Could not load ${what} (${res.error}). Nothing is shown until it answers.`);
  const atTime = (t) => new Date(t).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // A view is { kind, title, what, sections: [{ url, render(box, data), loading? }], back? }. First open shows each
  // section's own loading line; a refresh keeps the old numbers up until the new ones are here.
  async function openData(view, quiet = false) {
    open = { data: view };
    const mine = open;
    const fill = (holder, sec, res) => { holder.replaceChildren(); if (res.data) sec.render(holder, res.data); else holder.append(unavailable(res, view.what)); };
    const frame = () => { const box = showPanel(view.title, view.kind); if (view.back) box.append(button("act back", "Back", () => reopen(view.back))); return box; };
    if (quiet) {
      const results = await Promise.all(view.sections.map((sec) => getJson(sec.url)));
      if (open !== mine) return;
      const box = frame();
      view.sections.forEach((sec, i) => { const holder = el("section"); fill(holder, sec, results[i]); box.append(holder); });
      return;
    }
    const box = frame();
    await Promise.all(view.sections.map(async (sec) => {
      const holder = el("section"); holder.append(el("p", "mute", sec.loading ?? "Loading…")); box.append(holder);
      const res = await getJson(sec.url);
      if (open === mine) fill(holder, sec, res);
    }));
  }

  const tag = (text, cls = "") => el("span", `tag ${cls}`, text.replace(/_/g, " "));
  const WORKER_TONE = { working: "good", completed: "good", failed: "bad", blocked: "bad", cancelled: "bad", paused: "warn", review: "warn" };
  function workerItem(w) {
    const li = el("li", "wk"); li.dataset.worker = w.id;
    const head = el("div", "wkhead"); head.append(state.agents[w.id] ? button("link", w.id, () => openAgent(w.id)) : el("b", null, w.id), tag(w.state, WORKER_TONE[w.state]));
    const rate = w.success_rate === null ? "no finished tickets" : `${Math.round(w.success_rate * 100)}% success`;
    const stats = el("div", "mute", `${w.completed} done · ${w.failed} failed · ${rate} · median ${w.median_completion_ms === null ? "—" : ageText(w.median_completion_ms)} · busy ${ageText(w.busy_ms)} · `);
    stats.append(el("span", "nowrap", estUsd(w.cost_usd, 3)));
    li.append(head,
      el("div", "mute", `${w.role} · ${w.department ?? "no department"} · ${w.executor} · ${MODEL_NAME[w.model] ?? w.model}`),
      el("div", null, w.assignment ?? "no current assignment"),
      stats);
    return li;
  }
  const workforceView = () => ({ kind: "workforce", title: "Workforce", what: "Workforce", sections: [{ url: "./api/city/workforce", render(box, wf) {
    const t = wf.totals ?? {}, g = workforceGroups(wf);
    box.append(el("p", null, `${t.hired_ever ?? 0} hired ever · ${t.active ?? 0} active · ${t.working ?? 0} working · ${t.in_review ?? 0} in review · ${t.blocked ?? 0} blocked · ${t.failed ?? 0} failed · ${t.released ?? 0} released`));
    if (!g.current.length && !g.released.length) { box.append(el("p", "mute", "No workers have been hired yet.")); return; }
    box.append(costNote());
    const list = (title, rows) => { box.append(el("h4", null, `${title} (${rows.length})`)); const ul = el("ul"); ul.append(...rows.map(workerItem)); if (!rows.length) ul.append(el("li", "mute", "None.")); box.append(ul); };
    list("Current", g.current);
    list("Released", g.released);
  } }] });

  function costTable(title, rows, cell = (r) => document.createTextNode(r.name)) {
    const wrap = el("div"); wrap.append(el("h4", null, title));
    if (!rows.length) { wrap.append(el("p", "mute", "Nothing recorded.")); return wrap; }
    const t = el("table", "costs"), head = el("tr");
    for (const h of ["", "Est. value", "Tokens", "Turns"]) head.append(el("th", null, h));
    t.append(head);
    for (const r of rows) { const tr = el("tr"), name = el("td"); name.append(cell(r)); tr.append(name, el("td", null, estUsd(r.usd, r.usd >= 1 ? 2 : 3)), el("td", null, Number(r.tokens ?? 0).toLocaleString("en-US")), el("td", null, String(r.turns ?? 0))); t.append(tr); }
    wrap.append(t);
    return wrap;
  }
  const costsView = () => { const view = { kind: "costs", title: "Costs (estimates)", what: "Costs", sections: [{ url: "./api/city/costs", render(box, c) {
    box.append(el("p", "hint costnote", c.note || COST_NOTE));
    box.append(costTable("Totals, UTC", [{ name: "Today", ...c.today }, { name: "This month", ...c.month }]));
    box.append(row("done, month", String(c.done_tickets ?? 0)), row("failed, month", String(c.failed_tickets ?? 0)), row("per done ticket", estUsd(c.usd_per_done_ticket)));
    box.append(costTable("This month by model", usdRows(c.by_model).map((r) => ({ ...r, name: MODEL_NAME[r.name] ?? r.name }))), costTable("This month by department", usdRows(c.by_department)), costTable("This month by agent", usdRows(c.by_agent)));
    box.append(costTable("This month by ticket (top 20)", (c.by_ticket ?? []).map((r) => ({ ...r, name: r.ticket_id })), (r) => button("link", r.name, () => openData(storyView(r.name, { data: view })))));
  } }] }; return view; };

  const INTEGRATION_TONE = { operational: "good", needs_owner: "bad", unavailable: "bad" };
  const healthView = () => ({ kind: "health", title: "Health", what: "Health", sections: [
    { url: "./api/city/health", render(box, h) {
      box.append(el("p", "hint", `Read from the ledger at ${atTime(Date.now())}.`));
      box.append(row("paused until", h.paused_until ? `${stockholmTime(Date.parse(h.paused_until))} Stockholm` : "not paused"), row("turns", `${h.turns_running} running · ${h.turns_waiting} waiting`), row("open tickets", String(h.tickets_open)), row("stale, 1 h+", h.tickets_stale?.length ? h.tickets_stale.join(", ") : "none"), row("parked", String(h.tickets_parked)), row("waiting on you", String(h.tickets_waiting_on_owner)), row("failed today, UTC", String(h.failed_today)), row("last model turn", h.last_model_turn ? `${atTime(h.last_model_turn)} (${relTime(Date.now() - Date.parse(h.last_model_turn))})` : "none recorded"), row("active agents", String(h.active_agents)));
    } },
    { url: "./api/city/integrations", loading: "Probing integrations. This can take up to 20 s.", render(box, res) {
      const checked = Date.parse(res.checked_at ?? "");
      box.append(el("h4", null, "Integrations"), el("p", "hint", Number.isNaN(checked) ? "Time of the check unknown." : `Probed at ${atTime(checked)} (${relTime(Date.now() - checked)}). The server probes at most every five minutes.`));
      const groups = integrationGroups(res.integrations);
      if (!groups.length) box.append(el("p", "mute", "No integrations are configured."));
      for (const g of groups) {
        box.append(el("h4", null, g.category));
        const ul = el("ul");
        for (const i of g.items) {
          const li = el("li", "wk"); li.dataset.integration = i.name;
          const head = el("div", "wkhead"); head.append(el("b", null, i.name), tag(i.status, INTEGRATION_TONE[i.status]));
          li.append(head, el("div", null, i.detail ?? "no detail"));
          const what = checkText(i.check); if (what) li.append(el("div", "mute", `checked: ${what}`));
          if (i.note) li.append(el("div", "mute", i.note));
          ul.append(li);
        }
        box.append(ul);
      }
      const legend = el("dl", "legend");
      for (const [k, v] of INTEGRATION_MEANS) legend.append(el("dt", null, k.replace(/_/g, " ")), el("dd", null, v));
      box.append(el("h4", null, "What the words mean"), legend);
    } },
  ] });

  const storyView = (id, back) => ({ kind: "story", title: `Story of ${id}`, what: "This ticket's story", back, key: id, sections: [{ url: `./api/city/trace?ticket=${encodeURIComponent(id)}`, render(box, events) {
    const lines = traceLines(Array.isArray(events) ? events : []);
    if (!lines.length) { box.append(el("p", "mute", "No events recorded for this ticket.")); return; }
    const ul = el("ul", "story");
    for (const l of lines) { const li = el("li", "line"); li.append(el("span", "t", atTime(l.at)), el("span", null, l.text)); ul.append(li); }
    box.append(ul);
  } }] });

  // ---------- Parked tickets: the owner resumes or cancels, one or all ----------
  let parkedBlocked = false; // the server said this listener may not act on tickets
  const parkedIds = () => parkedRows(state).map((t) => t.id).join();
  function openParked() {
    const rows = parkedRows(state);
    const note = open?.parked ? open.note : "";
    open = { parked: true, note, ids: parkedIds() };
    const box = showPanel(`Parked tickets (${rows.length})`, "parked");
    const g = gateStatus(state);
    if (g.paused) box.append(el("p", "hint", `The city is paused until ${g.paused.text} Stockholm. A resumed ticket waits for that.`));
    if (!rows.length) box.append(el("p", "mute", "Nothing is parked."));
    else box.append(el("p", "hint", "These tickets do nothing until you decide. Resuming one starts its agent again."));
    const say = el("p", "hint saynote", note); say.setAttribute("role", "status");
    const setBusy = (busy) => { for (const b of box.querySelectorAll("button.needsauth")) b.disabled = busy || parkedBlocked; };
    const act = async (action, ids) => {
      setBusy(true);
      const res = await (async () => {
        try {
          const r = await fetchImpl(`./api/city/tickets/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
          const j = await r.json().catch(() => ({}));
          if (r.status === 403) { parkedBlocked = true; return "Resuming and cancelling are not available from the phone. Open Jarvis on the Mac to decide."; }
          if (!r.ok) return `Nothing changed: ${j.error || `server error ${r.status}`}`;
          const n = (action === "resume" ? j.resumed : j.cancelled)?.length ?? 0;
          return `${action === "resume" ? "Resumed" : "Cancelled"} ${n} of ${ids.length}.`;
        } catch { return "Could not reach the server. Nothing changed."; }
      })();
      say.textContent = res;
      if (open?.parked) open.note = res;
      setBusy(false);
      await refresh();
    };
    // Cancelling is final and a resume-all starts many turns: both ask for a second click.
    const armed = (cls, label, sure, run) => {
      let timer = null;
      const b = button(`${cls} needsauth`, label, () => {
        if (timer === null) { b.textContent = sure; b.classList.add("sure"); timer = setTimeout(() => { timer = null; b.textContent = label; b.classList.remove("sure"); }, 4000); return; }
        clearTimeout(timer); timer = null; b.textContent = label; b.classList.remove("sure"); run();
      });
      return b;
    };
    if (rows.length > 1) {
      const all = el("div", "acts");
      all.append(armed("act main", `Resume all (${rows.length})`, `Sure? Resume ${rows.length}`, () => act("resume", rows.map((t) => t.id))), armed("act", `Cancel all (${rows.length})`, `Sure? Cancel ${rows.length}`, () => act("cancel", rows.map((t) => t.id))));
      box.append(all);
    }
    box.append(say);
    const ul = el("ul");
    for (const t of rows) {
      const li = el("li", "wk"); li.dataset.parked = t.id;
      const acts = el("div", "acts");
      acts.append(button("act main needsauth", "Resume", () => act("resume", [t.id])), armed("act", "Cancel", "Sure? Cancel it", () => act("cancel", [t.id])), storyButton(t.id));
      li.append(el("div", null, t.goal), el("div", "mute", `${t.to} · from ${t.from} · ${t.id} · opened ${relTime(t.ageMs)} · last touched ${relTime(t.quietMs)}`), acts);
      ul.append(li);
    }
    box.append(ul);
    setBusy(false);
  }

  // What only the server can say again: the gate's counters, parked tickets, spend. Never reloads the scene.
  let refreshTimer = null;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 1500); };
  async function refresh() {
    if (root.offsetParent === null || document.hidden) return;
    try {
      const r = snapshotImpl ? await snapshotImpl() : await fetchImpl("./api/city");
      if (r.ok) state = applyLive(state, await r.json());
    } catch { /* the stream's own banner says when the server is gone */ }
    renderTop();
    if (open?.parked && open.ids !== parkedIds()) openParked();
    if (open?.data) openData(open.data, true);
  }

  function renderTop() {
    const t = topBar(state), d = daylight(), g = gateStatus(state), parked = parkedRows(state).length;
    const value = stat("EST. VALUE, NOT A CHARGE", t.usage ? estUsd(t.usage.usd) : "—"); value.title = COST_NOTE;
    $("#citytop").replaceChildren(
      stat("AGENTS", `${t.agentsActive} active · ${t.agentsTotal} total`), stat("TICKETS RUNNING", String(t.ticketsRunning)), stat("QUESTIONS", String(t.questionsWaiting)), stat("PARKED", String(parked)),
      stat("TURNS", g.known ? `${g.running ?? "—"} running · ${g.waiting ?? "—"} waiting` : "—"),
      stat("USAGE TODAY, UTC", t.usage ? `${t.usage.turns} turns · ${Math.round(t.usage.tokens / 1000)}k tokens` : "—"), value,
      stat("STOCKHOLM", `${d.text} ${d.light > 0.5 ? "☀" : d.light > 0.2 ? "◐" : "☾"}`),
    );
    const banner = $("#citypaused");
    banner.hidden = !g.paused;
    banner.replaceChildren();
    if (g.paused) {
      banner.append(el("b", null, `City paused until ${g.paused.text} Stockholm (in ${g.paused.inText}).`), el("span", null, ` ${g.running ?? "—"} turns running, ${g.waiting ?? "—"} waiting. Turns in progress continue after the reset.`));
      if (g.paused.reason) banner.append(el("div", "why", g.paused.reason));
    }
    $("#cityparked").hidden = !parked;
    $("#cityparkedsum").textContent = `${parked} parked ${parked === 1 ? "ticket waits" : "tickets wait"} for you.`;
  }

  function renderDom() {
    renderTop();
    const names = ["HQ", ...departmentNames(state)];
    const list = $("#citydepts"); list.replaceChildren(el("h3", null, "Departments"));
    for (const name of names) { const off = state.departments[name]?.state === "archived"; const b = el("button", off ? "dept off" : "dept", off ? `${name} (archived)` : name); b.style.borderLeftColor = deptColor(name); b.dataset.building = name; b.onclick = () => openDept(name); list.append(b); }
    list.append(el("h3", null, "Records"));
    for (const [key, label, go] of [["workforce", "Workforce", () => openData(workforceView())], ["costs", "Costs (estimates)", () => openData(costsView())], ["health", "Health", () => openData(healthView())], ["parked", `Parked (${parkedRows(state).length})`, openParked]]) { const b = el("button", "dept rec", label); b.dataset.view = key; b.onclick = go; list.append(b); }
    const a11y = $("#citylist"); a11y.replaceChildren();
    for (const name of names) { const b = el("button", null, `Building: ${name}`); b.dataset.building = name; b.onclick = () => openDept(name); a11y.append(b); }
    for (const a of Object.values(state.agents)) { if (a.state === "retired") continue; const b = el("button", null, `Agent: ${a.id} (${a.role}, ${MODEL_NAME[a.model] ?? a.model})`); b.dataset.agent = a.id; b.onclick = () => { const p = people.get(a.id); if (p) clickAgent(p); else openAgent(a.id); }; a11y.append(b); }
    feedDom();
    if (open?.dept) openDept(open.dept);
    if (open?.parked && open.ids !== parkedIds()) openParked();
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

  $("#cityparkedbtn").onclick = () => openParked();
  setInterval(refresh, 20000); // the gate's counters have no events of their own

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
    const d = daylight(), halted = !!gateStatus(state).paused;
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
        const busy = st === "working" && !halted; // a paused city's turns are waiting, nobody is typing
        const typing = busy ? Math.sin(now / 70 + u.bob) * 0.35 : 0;
        u.armL.rotation.x = -0.6 * busy + typing; u.armR.rotation.x = -0.6 * busy - typing;
        if (a.id === "jarvis") p.position.y = 0.4 + Math.sin(now / 600) * 0.2;
        if (a.id === "orchestrator") u.prop && (u.prop.rotation.z = Math.sin(now / 250) * 0.8);
        if (busy && Math.random() < dt * 1.5) sparks(p.position.clone().add(new THREE.Vector3(0.6, 1.4, 0.4)));
      }
      u.mug.visible = st === "idle" && !CORE.has(a.id);
      u.mark.visible = st === "waiting_on_owner";
      if (u.markFor !== st) {
        u.markFor = st;
        if (u.stateMark) { u.stateMark.removeFromParent(); u.stateMark.material.map.dispose(); u.stateMark.material.dispose(); u.stateMark = null; }
        const m = STATE_MARK[st];
        if (m) { u.stateMark = textSprite(m[0], { fg: m[1], bg: "rgba(0,0,0,0)", size: 48 }); u.stateMark.position.set(0, 3.6, 0); p.add(u.stateMark); }
      }
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
