// The City View: a small game world of the agents, drawn pixel by pixel on a canvas from city-state.js.
// All of the art is drawn here in code. Every person on screen is a real agent; only the scenery moves on its own.
import { BUILDING_H, COST_NOTE, CORE, INTEGRATION_MEANS, MODEL_NAME, TILE, VISUALS, ageText, agentPanel, agentStatus, applyLive, applySnapshot, assignSlots, checkText, cityMessage, courierFor, departmentNames, departmentPanel, deptColor, deptOf, doingWords, estUsd, gateStatus, hashOf, homeSpot, identity, initialState, integrationGroups, layout, parkedRows, placement, walksOut, propFor, reduce, relTime, residents, seatRows, seatSpot, stockholmTime, topBar, traceLines, usdRows, visitAllowed, visualState, walkRoute, workforceGroups } from "./city-state.js";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const INK = "#1d1c36";
const rng = (seed) => { let x = hashOf(seed) || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; }; };
const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); const g = c.getContext("2d"); g.imageSmoothingEnabled = false; return [c, g]; };
const R = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
// A filled oval on the pixel grid, row by row, so its edge stays crisp.
function oval(g, cx, cy, rx, ry, c) {
  g.fillStyle = c;
  for (let dy = -ry; dy <= ry; dy++) { const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + 0.3)) ** 2))); g.fillRect(Math.round(cx - half), Math.round(cy + dy), half * 2, 1); }
}
// Draws `paint` with a one-pixel ink outline around everything it drew.
function outlined(w, h, paint, ink = INK) {
  const [src, s] = newCanvas(w, h); paint(s);
  const [mask, m] = newCanvas(w, h); m.drawImage(src, 0, 0); m.globalCompositeOperation = "source-in"; m.fillStyle = ink; m.fillRect(0, 0, w, h);
  const [out, o] = newCanvas(w, h);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) o.drawImage(mask, dx, dy);
  o.drawImage(src, 0, 0);
  return out;
}

// ---------- Lettering: my own 4×5 capitals, each glyph five rows of four bits ----------
const GLYPH = { A: "69F99", B: "E9E9E", C: "78887", D: "E999E", E: "F8E8F", F: "F8E88", G: "78B97", H: "99F99", I: "E444E", J: "31196", K: "9ACA9", L: "8888F", M: "9FF99", N: "9DB99", O: "69996", P: "E9E88", Q: "699A5", R: "E9EA9", S: "7861E", T: "E4444", U: "99996", V: "99966", W: "99FF9", X: "99699", Y: "AAE44", Z: "F124F", 0: "6BD96", 1: "4C44E", 2: "E168F", 3: "E161E", 4: "99F11", 5: "F8E1E", 6: "68E96", 7: "F1244", 8: "69696", 9: "69716", "-": "00F00", ".": "00040", ",": "00048", ":": "04040", "/": "11248", _: "0000F", "'": "44000", "!": "44404", "?": "69202", "(": "24442", ")": "42224", "&": "4A4A5", "+": "04E40", " ": "00000" };
const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const fontable = (s) => [...fold(s)].every((c) => GLYPH[c]);
const WIDE = { M: [17, 27, 21, 17, 17], W: [17, 17, 21, 27, 17] }; // five bits wide, or they read as H
const textW = (s) => [...fold(s)].reduce((w, c) => w + (WIDE[c] ? 6 : 5), 0) - 1;
// Agent-written names go through here as data. A name the capitals cannot spell falls back to plain canvas text.
function pixelText(g, s, x, y, c) {
  const t = fold(s);
  if (!fontable(s)) { g.fillStyle = c; g.font = "8px sans-serif"; g.textBaseline = "top"; g.fillText(String(s), x, y - 2); return; }
  g.fillStyle = c;
  let at = x;
  for (const ch of t) {
    const wide = WIDE[ch];
    for (let r = 0; r < 5; r++) { const bits = wide ? wide[r] : parseInt(GLYPH[ch][r], 16) << 1; for (let b = 0; b < 5; b++) if (bits & (16 >> b)) g.fillRect(at + b, y + r, 1, 1); }
    at += wide ? 6 : 5;
  }
}
const fit = (s, maxPx) => { let t = String(s); if (textW(t) <= maxPx) return t; while (t.length > 1 && textW(t) + 10 > maxPx) t = t.slice(0, -1); return `${t}..`; };

// ---------- Figures. A chunky toy person, 14×21, built from blocks; the look comes from the id alone ----------
const SKIN = ["#f6cfa8", "#eebb8e", "#d99b6c", "#b97a4e", "#8f5a38", "#6c422a"];
const HAIR = ["#3a2a22", "#6b4226", "#b5763a", "#e2c26a", "#c6543a", "#23222f", "#8a8aa0"];
const SHIRT = ["#e0625a", "#4f8fd6", "#49ad7c", "#e6a53c", "#9a6bd0", "#39a7a8", "#d2699e", "#7fa04a", "#c97a45", "#6f7bd8"];
const TROUSERS = ["#32344f", "#4a3a34", "#2d4a56", "#51406a"];
const hatColor = (name) => deptColor(name) === deptColor("other") ? SHIRT[hashOf(name) % SHIRT.length] : deptColor(name);

// Arms in each pose: [left dy, right dy, right dx, prop, head dy, body bob], one entry per frame of four.
const POSES = {
  rest: [[0, 0, 0], [0, 0, 0], [0, 0, 0, null, 0, 1], [0, 0, 0, null, 0, 1]],
  still: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
  type: [[-2, -4, 0], [-4, -2, 0], [-2, -4, 0, null, 0, 1], [-4, -2, 0, null, 0, 1]],
  think: [[0, -6, -2], [0, -6, -2], [0, -6, -2, null, 0, 1], [0, -6, -2, null, 0, 1]],
  read: [[-3, -3, -3, "book"], [-3, -3, -3, "book"], [-3, -3, -3, "book2"], [-3, -3, -3, "book"]],
  tablet: [[-3, -3, -3, "tablet"], [-3, -3, -3, "tablet2"], [-3, -3, -3, "tablet"], [-3, -3, -3, "tablet2"]],
  wave: [[0, -8, 1], [0, -9, 2], [0, -8, 1], [0, -9, 0]],
  point: [[0, -4, 2], [0, -5, 3], [0, -4, 2], [0, -5, 3]],
  raise: [[0, -9, 0], [0, -9, 0], [0, -10, 0], [0, -10, 0]],
  clipboard: [[-3, -2, -3, "clip"], [-3, -3, -3, "clip"], [-3, -2, -3, "clip"], [-3, -3, -3, "clip"]],
  magnify: [[0, -5, 1, "lens"], [0, -6, 2, "lens"], [0, -5, 3, "lens"], [0, -6, 2, "lens"]],
  wait: [[0, 0, 0], [0, 0, 0], [0, 0, 0, null, 0, 1], [0, 0, 0, null, 0, 1]],
  alarm: [[-9, -9, 0, null, 0, -3], [-10, -10, 0, null, 0, -1], [-9, -9, 0, null, 0, -3], [-10, -10, 0, null, 0, 0]],
  slump: [[1, 1, 0, null, 2], [1, 1, 0, null, 2], [1, 1, 0, null, 2], [1, 1, 0, null, 2]],
};
const PROP = {
  book: (g, x, y) => { R(g, x, y, 8, 5, "#4f8fd6"); R(g, x + 1, y, 3, 4, "#fff6e0"); R(g, x + 4, y, 3, 4, "#fff6e0"); },
  book2: (g, x, y) => { R(g, x, y, 8, 5, "#4f8fd6"); R(g, x + 1, y, 3, 4, "#fff6e0"); R(g, x + 4, y, 3, 4, "#e7d9b8"); },
  tablet: (g, x, y) => { R(g, x + 1, y - 1, 6, 6, "#2a2d4a"); R(g, x + 2, y, 4, 4, "#8fdcff"); },
  tablet2: (g, x, y) => { R(g, x + 1, y - 1, 6, 6, "#2a2d4a"); R(g, x + 2, y, 4, 4, "#c8f0ff"); },
  clip: (g, x, y) => { R(g, x + 1, y - 2, 6, 7, "#8a5a33"); R(g, x + 2, y - 1, 4, 5, "#fff6e0"); R(g, x + 3, y - 3, 2, 2, "#c9c9d6"); },
};
function paintFigure(g, agent, poseName, f, stride = null) {
  const id = agent.id, look = identity(id);
  const [ly, ry, rx, prop, headDy = 0, bob = 0] = POSES[poseName]?.[f % 4] ?? POSES.rest[0];
  const skin = id === "jarvis" ? "#a7f0ff" : SKIN[look.skin];
  let shirt = SHIRT[look.shirt], legs = TROUSERS[look.trousers], hair = HAIR[look.hair];
  if (id === "jarvis") { shirt = "#54c8ee"; legs = "#2f8fc0"; hair = null; }
  if (id === "orchestrator") { shirt = "#23222f"; legs = "#23222f"; }
  if (id === "secretary") { shirt = "#b05a8a"; legs = "#3a2f4a"; }
  if (id === "reviewer") { shirt = "#6a4aa0"; legs = "#32344f"; }
  if (agent.kind === "manager") shirt = hatColor(deptOf(agent));
  const top = 2 + bob;
  // Legs and shoes; a stride shortens one leg and then the other.
  const lL = stride === 1 ? 3 : 5, lR = stride === 3 ? 3 : 5;
  R(g, 4, top + 13, 3, lL, legs); R(g, 7, top + 13, 3, lR, legs);
  R(g, 4, top + 13 + lL, 3, 1, "#2a2030"); R(g, 7, top + 13 + lR, 3, 1, "#2a2030");
  // Left arm, body, right arm; a raised arm ends in a hand above the shoulder.
  const arm = (x, dy) => { R(g, x, top + 8 + Math.min(dy, 0), 2, 5 - Math.abs(Math.min(dy, 0)) / 3, shirt); R(g, x, top + 8 + Math.min(dy, 0) - (dy < 0 ? 1 : -4), 2, 2, skin); };
  arm(2, ly);
  R(g, 3, top + 8, 8, 6, shirt); R(g, 3, top + 13, 8, 1, "rgba(0,0,0,.18)");
  R(g, 6, top + 8, 2, 2, agent.kind === "core" && id !== "jarvis" ? "#fff6e0" : "rgba(255,255,255,.3)");
  arm(10 + (rx > 0 ? rx : 0) + (rx < 0 ? rx : 0), ry);
  // Head, a big friendly block with its corners knocked off.
  const hy = top + headDy;
  R(g, 3, hy + 1, 8, 7, skin); R(g, 4, hy, 6, 1, skin);
  if (headDy > 0) R(g, 5, hy + 5, 4, 1, "#3a2a22"); // eyes shut, head down
  else { R(g, 5, hy + 4, 1, 2, "#23202f"); R(g, 8, hy + 4, 1, 2, "#23202f"); R(g, 6, hy + 6, 2, 1, id === "jarvis" ? "#2f8fc0" : "rgba(120,50,40,.55)"); }
  if (hair) switch (look.hairStyle) {
    case 0: R(g, 3, hy, 8, 3, hair); R(g, 3, hy + 3, 1, 2, hair); R(g, 10, hy + 3, 1, 2, hair); break;
    case 1: R(g, 3, hy, 8, 2, hair); R(g, 6, hy + 2, 5, 1, hair); break;
    case 2: R(g, 3, hy, 8, 3, hair); R(g, 5, hy - 2, 4, 2, hair); break;
    case 3: R(g, 3, hy, 8, 2, hair); R(g, 3, hy + 2, 1, 5, hair); R(g, 10, hy + 2, 1, 5, hair); break;
    default: R(g, 4, hy - 1, 6, 2, hair); R(g, 6, hy - 2, 2, 1, hair); R(g, 3, hy + 1, 8, 1, hair);
  }
  if (agent.kind === "manager") { const c = hatColor(deptOf(agent)); R(g, 3, hy - 2, 8, 3, c); R(g, 2, hy + 1, 10, 1, c); R(g, 4, hy - 2, 3, 1, "rgba(255,255,255,.35)"); }
  if (id === "jarvis") { R(g, 4, hy + 3, 6, 1, "#ffffff"); R(g, 6, hy - 2, 2, 2, "#e8fbff"); }
  if (id === "orchestrator") { R(g, 4, hy - 3, 6, 4, "#23222f"); R(g, 3, hy + 1, 8, 1, "#c7a23c"); R(g, 12, top + 3, 1, 6, "#fff6e0"); }
  if (id === "secretary") { R(g, 3, hy, 8, 3, "#3a2a22"); R(g, 5, hy - 2, 4, 2, "#3a2a22"); R(g, 4, hy + 4, 3, 2, "#c8d6e8"); R(g, 7, hy + 4, 3, 2, "#c8d6e8"); R(g, 5, hy + 4, 1, 2, "#23202f"); R(g, 8, hy + 4, 1, 2, "#23202f"); }
  if (id === "reviewer") { R(g, 2, hy + 1, 10, 1, "#3d2a60"); R(g, 4, hy - 2, 6, 3, "#3d2a60"); }
  if (prop && PROP[prop]) PROP[prop](g, 3, top + 8);
  if (prop === "lens") { const x = 10 + rx, y = top + 1; R(g, x + 1, y - 3, 4, 4, "#bfe6ff"); R(g, x, y - 2, 1, 2, "#c7a23c"); R(g, x + 5, y - 2, 1, 2, "#c7a23c"); R(g, x + 1, y - 4, 4, 1, "#c7a23c"); R(g, x + 1, y + 1, 4, 1, "#c7a23c"); }
}
const figures = new Map();
function figure(agent, pose, f, stride) {
  const key = `${agent.id}|${agent.kind}|${agent.department}|${pose}|${f % 4}|${stride}`;
  let c = figures.get(key);
  if (!c) { c = outlined(20, 26, (g) => { g.translate(3, 4); paintFigure(g, agent, pose, f, stride); }); figures.set(key, c); }
  return c;
}

// ---------- Bubble icons, 9×9, one per state ----------
const ICON_INK = { k: INK, w: "#ffffff", y: "#f4c63c", r: "#d8392b", b: "#3f7fd0", g: "#37a564", o: "#e8842c", s: "#8b8fa8", p: "#8a5ad0", n: "#8a5a33", c: "#8fdcff" };
const ICONS = {
  understanding: ["..kkkkk..", ".k.....k.", "k.......k", "k.k.k.k.k", "k.......k", ".k.....k.", "..kkkkk..", ".kk......", "k........"],
  reading: [".........", ".bbb.bbb.", "bwwwbwwwb", "bwkwbwkwb", "bwwwbwwwb", "bwkwbwkwb", "bwwwbwwwb", "bbbbbbbbb", "........."],
  researching: ["..bbbbb..", ".bggbbgb.", "bgggbbggb", "bgggbbbgb", "bbggbbbbb", "bbbbbggbb", "bbbbgggbb", ".bbbbggb.", "..bbbbb.."],
  browsing: ["kkkkkkkkk", "krkykgkkk", "kkkkkkkkk", "kwwwwwwwk", "kwbbbwwwk", "kwwwwwwwk", "kwbbwkwwk", "kwwwwkkwk", "kkkkkkkkk"],
  coding: ["kkkkkkkkk", "kcccccck.", "kcgcccck.", "kccgccck.", "kcgcckck.", "kcccccck.", "kkkkkkkk.", ".sssssss.", "sssssssss"],
  running: ["...s.s...", ".s.sss.s.", "..sssss..", "ssskkksss", ".ssk.kss.", "ssskkksss", "..sssss..", ".s.sss.s.", "...s.s..."],
  working: [".sssssss.", ".sssssss.", ".ss.n.ss.", "....n....", "....n....", "....n....", "....n....", "....n....", "....n...."],
  hiring: ["...nn....", "..nnnn...", "..nnnn.g.", "...nn.ggg", "..bbbb.g.", ".bbbbbb..", ".bbbbbb..", ".bbbbbb..", "........."],
  delegating: [".........", "....o....", "....oo...", "ooooooo..", "oooooooo.", "ooooooo..", "....oo...", "....o....", "........."],
  asking: ["..bbbbb..", ".bb...bb.", ".bb...bb.", ".....bb..", "....bb...", "...bb....", "...bb....", ".........", "...bb...."],
  answering: [".kkkkkkk.", "kwwwwwwwk", "kwkkkkkwk", "kwwwwwwwk", "kwkkkwwwk", "kwwwwwwwk", ".kkwkkkk.", "..kk.....", "..k......"],
  reporting: ["...sss...", ".nnnsnnn.", ".nwwwwwn.", ".nwwwgwn.", ".nwwgwwn.", ".ngwgwwn.", ".nwgwwwn.", ".nwwwwwn.", ".nnnnnnn."],
  reviewing: ["..kkkk...", ".kccccK..".replace("K", "k"), "kcwcccck.", "kcccccck.", "kcccccck.", ".kcccck..", "..kkkkkn.", "......nnn", ".......nn"],
  in_review: [".sssssss.", ".swwwwws.", ".swkkkws.", ".swwwwws.", ".swkkkws.", ".swwwwws.", ".sssssss.", ".........", ".p..p..p."],
  summarizing: ["......ooo", ".....oyyo", "kkkk.oyyk", "....oyyk.", "kkkoyyk..", "...kkk...", "kkk......", ".........", "kkkkkkk.."],
  remembering: ["..yyyyy..", ".yyyyyyy.", ".yywwyyy.", ".yyywyyy.", "..yyyyy..", "...yyy...", "...sss...", "...sss...", "....k...."],
  waiting_team: ["nnnnnnnnn", ".kwwwwwk.", ".kyyyyyk.", "..kyyyk..", "...kyk...", "..kwywk..", ".kwwywwk.", ".kyyyyyk.", "nnnnnnnnn"],
  waiting_owner: ["...rrr...", "...rrr...", "...rrr...", "...rrr...", "...rrr...", "....r....", ".........", "...rrr...", "...rrr..."],
  waiting_merge: [".g.....g.", "ggg...ggg", ".g.....g.", ".g.....g.", "..g...g..", "...g.g...", "....g....", "....g....", "...ggg..."],
  failed: ["rr.....rr", "rrr...rrr", ".rrr.rrr.", "..rrrrr..", "...rrr...", "..rrrrr..", ".rrr.rrr.", "rrr...rrr", "rr.....rr"],
  blocked: ["..rrrrr..", ".rrrrrrr.", "rrrrrrrrr", "rrrrrrrrr", "rwwwwwwwr", "rrrrrrrrr", "rrrrrrrrr", ".rrrrrrr.", "..rrrrr.."],
  paused: [".........", ".bbb.bbb.", ".bbb.bbb.", ".bbb.bbb.", ".bbb.bbb.", ".bbb.bbb.", ".bbb.bbb.", ".bbb.bbb.", "........."],
};
function paintIcon(g, key, x, y) {
  (ICONS[key] ?? []).forEach((row, r) => { [...row].forEach((ch, c) => { if (ch !== ".") { g.fillStyle = ICON_INK[ch]; g.fillRect(x + c, y + r, 1, 1); } }); });
}
const bubbles = new Map();
function bubble(key) {
  if (!bubbles.has(key)) {
    const loud = key === "waiting_owner", bad = key === "failed" || key === "blocked";
    bubbles.set(key, outlined(17, 18, (g) => {
      const fill = loud ? "#ffd84a" : bad ? "#ffe3dc" : "#fff6e0";
      R(g, 2, 1, 13, 13, fill); R(g, 1, 2, 15, 11, fill);
      if (key === "understanding") { R(g, 6, 14, 2, 1, fill); R(g, 7, 16, 1, 1, fill); } else { R(g, 7, 14, 3, 1, fill); R(g, 8, 15, 1, 1, fill); }
      paintIcon(g, key, 4, 3);
    }));
  }
  return bubbles.get(key);
}

// ---------- Desks ----------
const DESK_ITEM = {
  laptop: (g) => { R(g, 8, 0, 8, 5, "#3a3d5a"); R(g, 9, 1, 6, 3, "#8fdcff"); R(g, 7, 5, 10, 1, "#c9c9d6"); },
  camera: (g) => { R(g, 9, 1, 7, 5, "#2a2d4a"); R(g, 11, 2, 3, 3, "#8fdcff"); },
  chart: (g) => { R(g, 8, 0, 8, 6, "#fff6e0"); R(g, 9, 3, 1, 2, "#37a564"); R(g, 11, 2, 1, 3, "#37a564"); R(g, 13, 1, 1, 4, "#e8842c"); },
  wrench: (g) => { R(g, 8, 4, 8, 2, "#8b8fa8"); R(g, 15, 2, 2, 3, "#8b8fa8"); R(g, 7, 3, 2, 4, "#8b8fa8"); },
  ticket: (g) => { R(g, 8, 2, 8, 4, "#f4c63c"); R(g, 11, 2, 1, 4, "#c9962a"); },
  clipboard: (g) => { R(g, 9, 0, 6, 6, "#8a5a33"); R(g, 10, 1, 4, 5, "#fff6e0"); },
  none: () => {},
};
const desks = new Map();
function desk(item = "none") {
  if (!desks.has(item)) desks.set(item, outlined(24, 16, (g) => {
    g.translate(0, 1);
    (DESK_ITEM[item] ?? DESK_ITEM.laptop)(g);
    R(g, 1, 6, 22, 3, "#c98f55"); R(g, 1, 6, 22, 1, "#e2ae72"); R(g, 1, 9, 22, 4, "#9a6638"); R(g, 3, 9, 18, 1, "#7d4f2a");
  }));
  return desks.get(item);
}

// ---------- The ground ----------
const PLAZA = ["#6f5c6c", "#776370", "#6a5768"], WALK = ["#7a7690", "#817d97", "#74708a"];
function paving(g, x, y, w, h, tones, grout, seed, size = 8) {
  const r = rng(seed);
  for (let ty = 0; ty < h; ty += size) for (let tx = 0; tx < w; tx += size) {
    R(g, x + tx, y + ty, Math.min(size, w - tx), Math.min(size, h - ty), tones[Math.floor(r() * tones.length)]);
    R(g, x + tx, y + ty, Math.min(size, w - tx), 1, grout);
    R(g, x + tx, y + ty, 1, Math.min(size, h - ty), grout);
  }
}
function lawn(g, x, y, w, h, seed) {
  R(g, x, y, w, h, "#2f6a52");
  const r = rng(seed), blades = (w * h) / 26;
  for (let i = 0; i < blades; i++) { R(g, x + r() * w, y + r() * h, 1, 2, r() > 0.5 ? "#387a5c" : "#29604a"); }
}
function roadH(g, x, y, w, h, seed) {
  R(g, x, y, w, h, "#3f4168");
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 40; i++) R(g, x + r() * w, y + r() * h, 1, 1, r() > 0.5 ? "#4a4c74" : "#383a5e");
}
function street(g, x0, x1, y, seed, avenues) { // tiles
  const X = x0 * TILE, W = (x1 - x0) * TILE, Y = y * TILE, H = 3 * TILE;
  paving(g, X, Y, W, 8, WALK, "#65617c", `${seed}n`);
  paving(g, X, Y + H - 8, W, 8, WALK, "#65617c", `${seed}s`);
  roadH(g, X, Y + 8, W, H - 16, seed);
  for (let dx = 4; dx < W; dx += 20) R(g, X + dx, Y + H / 2 - 1, 10, 2, "#b9a45a");
  for (const a of avenues) if (a >= x0 && a < x1) for (let k = 0; k < 4; k++) R(g, (a + 3) * TILE + 2, Y + 11 + k * 7, 8, 4, "#cfcfd6"); // a crossing beside each junction
}
function avenue(g, x, y0, y1, seed) { // tiles
  const X = x * TILE, Y = y0 * TILE, H = (y1 - y0) * TILE, W = 3 * TILE;
  paving(g, X, Y, 8, H, WALK, "#65617c", `${seed}w`);
  paving(g, X + W - 8, Y, 8, H, WALK, "#65617c", `${seed}e`);
  roadH(g, X + 8, Y, W - 16, H, seed);
  for (let dy = 4; dy < H; dy += 20) R(g, X + W / 2 - 1, Y + dy, 2, 10, "#b9a45a");
}

// ---------- Scenery. It never pretends to be anyone ----------
function glow(g, cx, cy, big = 1) {
  oval(g, cx, cy, 28 * big, 13 * big, "rgba(255,206,130,.11)");
  oval(g, cx, cy, 20 * big, 9 * big, "rgba(255,206,130,.14)");
  oval(g, cx, cy, 11 * big, 5 * big, "rgba(255,218,160,.2)");
}
function lamp(g, x, y) {
  glow(g, x, y + 1);
  R(g, x - 3, y - 1, 7, 2, INK); R(g, x - 2, y - 2, 5, 1, "#3a3d5a");
  R(g, x - 1, y - 20, 2, 18, "#2a2d4a"); R(g, x, y - 20, 1, 18, "#3f4368");
  oval(g, x, y - 23, 6, 6, "rgba(255,226,150,.16)");
  oval(g, x, y - 23, 3, 3, INK); oval(g, x, y - 23, 2, 2, "#ffe9a0"); R(g, x - 1, y - 24, 1, 1, "#fff8d8");
}
function tree(g, x, y, r) {
  oval(g, x + 1, y, 9, 3, "rgba(20,18,40,.35)");
  R(g, x - 2, y - 9, 4, 9, "#6b4630"); R(g, x - 2, y - 9, 1, 9, "#7f5638"); R(g, x - 3, y - 1, 6, 2, "#5a3a28");
  const dx = Math.floor(r() * 3) - 1;
  for (const [ox, oy, rx, ry] of [[0, -22, 10, 11], [-5 + dx, -14, 7, 7], [5 + dx, -15, 7, 7]]) oval(g, x + ox, y + oy, rx + 1, ry + 1, INK);
  for (const [ox, oy, rx, ry] of [[0, -22, 10, 11], [-5 + dx, -14, 7, 7], [5 + dx, -15, 7, 7]]) oval(g, x + ox, y + oy, rx, ry, "#2c6b49");
  oval(g, x - 1, y - 24, 7, 7, "#3a8456");
  oval(g, x - 3, y - 27, 3, 3, "#59a468");
  oval(g, x - 6 + dx, y - 15, 3, 3, "#3a8456"); oval(g, x + 4 + dx, y - 16, 3, 3, "#3a8456");
}
function hedge(g, x, y, w) {
  R(g, x, y, w, 10, INK); R(g, x + 1, y + 1, w - 2, 8, "#2f6e4a"); R(g, x + 1, y + 1, w - 2, 3, "#3f8a57");
  const r = rng(`${x},${y}`);
  for (let i = 0; i < w / 3; i++) R(g, x + 1 + r() * (w - 3), y + 2 + r() * 6, 2, 1, r() > 0.5 ? "#55a265" : "#28603f");
}
function bench(g, x, y) {
  R(g, x, y, 22, 2, INK); R(g, x + 1, y + 1, 20, 3, "#c98f55"); R(g, x + 1, y + 1, 20, 1, "#e2ae72");
  R(g, x + 1, y + 5, 20, 3, "#a97444"); R(g, x, y + 4, 22, 1, INK); R(g, x, y + 8, 22, 1, INK);
  R(g, x + 2, y + 9, 2, 3, INK); R(g, x + 18, y + 9, 2, 3, INK);
}
function flowers(g, x, y, c) {
  R(g, x, y + 3, 16, 7, INK); R(g, x + 1, y + 4, 14, 5, "#a6794a"); R(g, x + 1, y + 4, 14, 1, "#c79660");
  const r = rng(`${x}f${y}`);
  for (let i = 0; i < 12; i++) R(g, x + 1 + r() * 13, y + r() * 3, 1, 2, i % 3 ? "#3f8a57" : c);
}
function stallRoof(g, x, y, w, a, b) { // a striped market awning with a scalloped edge
  R(g, x - 1, y - 1, w + 2, 9, INK);
  for (let i = 0; i < w; i += 4) { R(g, x + i, y, Math.min(4, w - i), 6, (i / 4) % 2 ? a : b); R(g, x + i + 1, y + 6, Math.min(2, w - i), 2, (i / 4) % 2 ? a : b); }
  R(g, x, y, w, 1, "rgba(255,255,255,.3)");
}
function sign(g, text, cx, y, maxW) {
  const label = fit(text, maxW), w = Math.min(textW(label), maxW) + 8;
  R(g, cx - w / 2 - 1, y - 1, w + 2, 11, INK); R(g, cx - w / 2, y, w, 9, "#c98f55"); R(g, cx - w / 2, y, w, 1, "#e2ae72"); R(g, cx - w / 2, y + 8, w, 1, "#8a5a33");
  pixelText(g, label, Math.round(cx - w / 2 + 4), y + 2, "#2e1c10");
}

// Each department's own colours, by its slot, so twelve offices look like twelve offices.
const ROOFS = [["#c0533f", "#d96c50", "#9c3f30"], ["#3f7fa8", "#5499c2", "#2f6387"], ["#3f8f6a", "#55a97f", "#2f7052"], ["#b5823a", "#d09c4c", "#8e642a"], ["#7f5aa8", "#9a74c2", "#634587"], ["#b84f78", "#d26a92", "#923c5e"], ["#4a6fb0", "#6288c8", "#37558c"], ["#8d9440", "#a8ae52", "#6e7430"], ["#b0663a", "#cb7f4e", "#8c4f2c"], ["#3f9a9a", "#55b4b4", "#2f7878"], ["#a84848", "#c25e5e", "#863636"], ["#5f7a8a", "#7894a4", "#485e6c"]];
const WALLS = ["#e6d3ae", "#d9c6c0", "#cfd3c0", "#e2c8a8"];
// A window around a seat: the cell's width, from above the figure's head to just under the desk.
const windowRect = (p, b) => { const pitch = (b.w * TILE - 8) / 4; return { x: Math.round(p.x - pitch / 2) + 1, y: p.y - 22, w: Math.round(pitch) - 2, h: 28, pitch }; };
function office(g, b) {
  const X = b.x * TILE, Y = b.y * TILE, W = b.w * TILE, H = b.h * TILE, r = rng(b.dept);
  const [roof, light, dark] = ROOFS[b.slot % ROOFS.length], wall = WALLS[hashOf(b.dept) % WALLS.length];
  paving(g, X, Y + 56, W, H - 56, PLAZA, "#5e4d5e", b.dept);
  // The building: roof, then the wall with windows and a door, on a little shadow.
  const bx = X + 8, bw = W - 16, by = Y + 2;
  R(g, bx - 1, by + 70, bw + 2, 4, "rgba(20,18,40,.35)");
  R(g, bx - 1, by + 26, bw + 2, 45, INK); R(g, bx, by + 27, bw, 43, wall); R(g, bx, by + 27, bw, 3, "rgba(60,30,40,.25)");
  R(g, bx - 3, by - 1, bw + 6, 29, INK); R(g, bx - 2, by, bw + 4, 27, roof);
  for (let ry = 0; ry < 27; ry += 5) { R(g, bx - 2, by + ry, bw + 4, 1, dark); for (let rx = (ry / 5) % 2 ? 4 : 0; rx < bw + 4; rx += 8) R(g, bx - 2 + rx, by + ry, 1, 5, dark); }
  R(g, bx - 2, by, bw + 4, 2, light);
  if (hashOf(b.dept) % 2) { R(g, bx + 10, by - 4, 8, 7, INK); R(g, bx + 11, by - 3, 6, 5, "#8a5a50"); } // a chimney on some
  // Lit windows either side of the door.
  for (const wx of [bx + 8, bx + 28, bx + bw - 44, bx + bw - 24]) { R(g, wx - 1, by + 43, 16, 14, INK); R(g, wx, by + 44, 14, 12, "#ffdf94"); R(g, wx, by + 44, 14, 3, "#ffefc0"); R(g, wx + 6, by + 44, 2, 12, INK); R(g, wx, by + 49, 14, 1, INK); R(g, wx - 1, by + 57, 16, 2, dark); }
  const dx = X + W / 2 - 8;
  R(g, dx - 1, by + 48, 18, 23, INK); R(g, dx, by + 49, 16, 21, "#7a4a2a"); R(g, dx + 7, by + 49, 2, 21, INK); R(g, dx + 11, by + 60, 2, 2, "#f4c63c"); R(g, dx + 3, by + 60, 2, 2, "#f4c63c");
  stallRoof(g, X + W / 2 - 16, by + 39, 32, roof, "#f3e6cc");
  sign(g, b.dept, X + W / 2, by + 27, W - 26);
  // The terrace: a seat for everyone, with a lamp and planters at its edges.
  // The glass front: a dark pane behind each seat's desk. The lit glow and the mullions and sill are drawn live, around the figure.
  for (let s = 0; s < seatRows(b) * 4; s++) { const p = seatSpot(b, s), q = windowRect(p, b); R(g, q.x - 1, q.y - 1, q.w + 2, q.h + 2, INK); R(g, q.x, q.y, q.w, q.h, "#3a4660"); R(g, p.x - 8, p.y + 2, 16, 2, "rgba(20,18,40,.28)"); g.drawImage(desk("none"), p.x - 12, p.y - 11); }
  lamp(g, X + 1, Y + BUILDING_H * TILE + 8); lamp(g, X + W - 1, Y + BUILDING_H * TILE + 8);
  if (r() > 0.5) flowers(g, X + W - 18, Y + H - 12, "#d2699e");
}
function freeLot(g, l, text) {
  const X = l.x * TILE, Y = l.y * TILE, W = l.w * TILE, H = l.h * TILE, r = rng(`${l.x},${l.y}`);
  lawn(g, X, Y, W, H, `${X}${Y}`);
  hedge(g, X + 2, Y + 2, W - 4);
  tree(g, X + 26, Y + 62, r); tree(g, X + W - 24, Y + 104, r);
  flowers(g, X + 40, Y + H - 22, "#e0c04a");
  sign(g, text, X + W / 2, Y + H / 2 - 6, W - 20);
  R(g, X + W / 2 - 1, Y + H / 2 + 5, 2, 8, "#6b4630");
}

// Where the four of the core stand on the plaza, in art pixels from the corner of HQ's plot.
const CORE_SPOT = { orchestrator: [96, 100], secretary: [28, 116], reviewer: [164, 116], jarvis: [62, 152] };
const FOUNTAIN = [112, 140];
const CORE_DESK = new Set(["secretary", "reviewer"]);
function headquarters(g, q) {
  const X = q.x * TILE, Y = q.y * TILE, W = q.w * TILE, H = q.h * TILE;
  paving(g, X, Y + 64, W, H - 64, PLAZA, "#5e4d5e", "hq", 8);
  const bx = X + 8, bw = W - 16, by = Y + 8;
  R(g, bx - 1, by + 69, bw + 2, 4, "rgba(20,18,40,.35)");
  R(g, bx - 1, by + 18, bw + 2, 52, INK); R(g, bx, by + 19, bw, 50, "#d6cdb8"); R(g, bx, by + 19, bw, 3, "rgba(60,30,40,.22)");
  R(g, bx - 3, by - 1, bw + 6, 21, INK); R(g, bx - 2, by, bw + 4, 19, "#3f5f92");
  for (let ry = 0; ry < 19; ry += 4) R(g, bx - 2, by + ry, bw + 4, 1, "#324c78");
  R(g, bx - 2, by, bw + 4, 2, "#5c7fb8");
  for (let wx = bx + 8; wx < bx + bw - 12; wx += 20) { if (Math.abs(wx + 7 - (X + W / 2)) < 26) continue; for (const wy of [by + 26, by + 46]) { R(g, wx - 1, wy - 1, 16, 15, INK); R(g, wx, wy, 14, 13, "#ffdf94"); R(g, wx, wy, 14, 3, "#ffefc0"); R(g, wx + 6, wy, 2, 13, INK); } }
  // The tower with its clock, and the grand door.
  const cx = X + W / 2;
  R(g, cx - 19, by - 8, 38, 78, INK); R(g, cx - 18, by - 7, 36, 77, "#e6dfc9"); R(g, cx - 18, by - 7, 36, 3, "#f4eedd");
  R(g, cx - 20, by - 13, 40, 7, INK); R(g, cx - 19, by - 12, 38, 5, "#3f5f92");
  oval(g, cx, by + 7, 9, 9, INK); oval(g, cx, by + 7, 8, 8, "#fff6e0"); R(g, cx, by + 1, 1, 6, INK); R(g, cx, by + 7, 5, 1, INK);
  R(g, cx - 11, by + 44, 22, 26, INK); R(g, cx - 10, by + 45, 20, 25, "#7a4a2a"); R(g, cx - 1, by + 45, 2, 25, INK); R(g, cx - 5, by + 58, 2, 2, "#f4c63c"); R(g, cx + 3, by + 58, 2, 2, "#f4c63c");
  stallRoof(g, cx - 20, by + 36, 40, "#3f5f92", "#f3e6cc");
  sign(g, "HQ", cx, by + 24, 30);
  // The podium the Orchestrator stands on, and the fountain's basin; the water is drawn live.
  const [ox, oy] = CORE_SPOT.orchestrator; oval(g, X + ox, Y + oy, 12, 4, INK); oval(g, X + ox, Y + oy - 1, 11, 3, "#c9b28a");
  const [fx, fy] = FOUNTAIN;
  glow(g, X + fx, Y + fy, 1.5);
  oval(g, X + fx, Y + fy + 2, 24, 11, "rgba(20,18,40,.3)");
  oval(g, X + fx, Y + fy, 24, 11, INK); oval(g, X + fx, Y + fy - 1, 23, 10, "#b5b4c4"); oval(g, X + fx, Y + fy - 1, 19, 8, "#55749c");
  R(g, X + fx - 2, Y + fy - 11, 4, 11, INK); R(g, X + fx - 1, Y + fy - 10, 2, 10, "#c9c9d6");
  for (const id of CORE_DESK) { const [sx, sy] = CORE_SPOT[id]; g.drawImage(desk(id === "reviewer" ? "clipboard" : "laptop"), X + sx - 12, Y + sy - 11); }
  lamp(g, X + 12, Y + H - 4); lamp(g, X + W - 12, Y + H - 4); lamp(g, X + 60, Y + 98); lamp(g, X + 132, Y + 98);
  bench(g, X + 150, Y + H - 28); flowers(g, X + 6, Y + 78, "#d2699e"); flowers(g, X + W - 22, Y + 78, "#e0c04a");
}
const ROOF_HOUSE = [["#b0533f", "#c96a50"], ["#4f7fa0", "#6799b8"], ["#7f6a44", "#99835a"], ["#6a7f4a", "#83995e"], ["#8a5a80", "#a4749a"]];
const houseWindows = (h) => ({ x: h.x * TILE + 7, y: h.y * TILE + 22, w: 8, h: 7 });
function house(g, h, i) {
  const X = h.x * TILE, Y = h.y * TILE, [roof, light] = ROOF_HOUSE[hashOf(`${h.x},${h.y}`) % ROOF_HOUSE.length];
  R(g, X + 3, Y + 37, 42, 3, "rgba(20,18,40,.3)");
  R(g, X + 4, Y + 15, 40, 23, INK); R(g, X + 5, Y + 16, 38, 21, "#e4d6b6");
  R(g, X + 2, Y + 3, 44, 15, INK); R(g, X + 3, Y + 4, 42, 13, roof); R(g, X + 3, Y + 4, 42, 2, light);
  for (let ry = 4; ry < 17; ry += 4) R(g, X + 3, Y + ry, 42, 1, "rgba(0,0,0,.18)");
  R(g, X + 26, Y + 23, 10, 15, INK); R(g, X + 27, Y + 24, 8, 14, "#7a4a2a"); R(g, X + 33, Y + 31, 1, 2, "#f4c63c");
  const w = houseWindows(h);
  R(g, w.x - 1, w.y - 1, w.w + 2, w.h + 2, INK); R(g, w.x, w.y, w.w, w.h, "#3a3f62");
  R(g, X + 3, Y + 41 + (i % 2), 8, 1, "#387a5c");
}

// Everything that does not move, baked once per layout, with a margin of countryside so the map runs off the screen's edges.
const MARGIN = 30; // tiles
function bake(world) {
  const W = world.width * TILE, H = world.height * TILE, M = MARGIN * TILE, r = rng("world");
  const [c, g] = newCanvas(W + M * 2, H + M * 2);
  g.translate(M, M);
  lawn(g, -M, -M, W + M * 2, H + M * 2, "lawn");
  const columns = [...new Set(world.buildings.concat(world.lots).map((b) => b.x))].sort((a, b) => a - b);
  const top = world.portrait ? world.hqStreet : -MARGIN, bottom = world.portrait ? world.officesEnd + 3 : world.height + MARGIN;
  const verticals = [world.avenue, ...columns.slice(1).map((x) => x - 3).filter((x) => x !== world.avenue)];
  for (const x of verticals) avenue(g, x, top, bottom, `ave${x}`);
  const roads = world.streets.map((s) => ({ ...s, x0: s.x0 === 0 ? -MARGIN : s.x0, x1: s.x1 === world.width ? world.width + MARGIN : s.x1 }));
  for (const s of roads) street(g, s.x0, s.x1, s.y, `st${s.y}`, [world.avenue]);
  // Trees wherever nothing else stands, far to near.
  const taken = [world.hq, ...world.buildings, ...world.lots, world.homes, ...roads.map((s) => ({ x: s.x0, y: s.y, w: s.x1 - s.x0, h: 3 })), ...verticals.map((x) => ({ x, y: top, w: 3, h: bottom - top }))];
  const clear = (x, y) => taken.every((t) => x < (t.x * TILE) - 12 || x > (t.x + t.w) * TILE + 12 || y < t.y * TILE - 2 || y > (t.y + t.h) * TILE + 34);
  const spots = [];
  for (let i = 0; i < ((W + M * 2) * (H + M * 2)) / 3000; i++) { const x = -M + r() * (W + M * 2), y = -M + r() * (H + M * 2); if (clear(x, y)) spots.push([Math.round(x), Math.round(y)]); }
  spots.sort((a, b) => a[1] - b[1]);
  const kept = [];
  for (const [x, y] of spots) if (kept.every(([kx, ky]) => Math.abs(kx - x) > 18 || Math.abs(ky - y) > 14)) kept.push([x, y]);
  for (const [x, y] of kept) tree(g, x, y, r);
  for (const b of world.buildings) if (b.archived) freeLot(g, b, "ARCHIVED"); else office(g, b);
  for (const l of world.lots) freeLot(g, l, "FREE LOT");
  headquarters(g, world.hq);
  // The neighbourhood: houses, with trees where no house stands yet.
  const hx = world.homes.x * TILE, hy = world.homes.y * TILE, hw = world.homes.w * TILE;
  world.homes.houses.forEach((h, i) => house(g, h, i));
  const below = world.homes.houses.at(-1), freeY = below ? below.y * TILE + 68 : hy;
  for (let y = freeY; y < hy + world.homes.h * TILE - 16; y += 44) for (let x = hx + 16; x < hx + hw - 8; x += 52) tree(g, x + r() * 10, y + 26 + r() * 8, r);
  g.fillStyle = "rgba(38,30,78,.14)"; g.fillRect(-M, -M, W + M * 2, H + M * 2); // the dusk wash over all of it
  return c;
}

const DASH_MS = 320, WALK_SPEED = 46, SCENERY_MS = 125, ZOOMS = [1, 1.5, 2, 3, 4, 5, 6];

// `events` is where the one shared stream is re-dispatched (jarvis-sse, jarvis-sse-open, jarvis-sse-error); tests can inject their own target.
// `snapshotImpl` fetches /api/city; the page shares one in-flight request between its views.
export function mountCity(root, { fetchImpl = fetch, events = document, snapshotImpl = globalThis.jarvisSnapshot } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  let state = initialState();
  let world = null, ground = null, worldSig = "";
  const people = new Map(); // id → { id, x, y, key, move, route, flip, hop, say, visual, seated }
  const seats = new Map(); // dept → Map(id → seat)
  let homes = new Map();
  let effects = [], parcels = [];
  const cam = { x: 0, y: 0, wantX: 0, wantY: 0, zoom: 2, userMoved: false };
  const walked = new Set(); // ids that already walked home for good
  const winBox = document.createElement("div"); winBox.id = "citywindows"; winBox.hidden = true; winBox.setAttribute("aria-hidden", "true"); root.append(winBox);
  let selected = null, hover = null, lastVisit = 0, hiddenHomes = 0;

  const visible = () => root.offsetParent !== null && !document.hidden;
  const dpr = () => devicePixelRatio || 1;
  const isPortrait = () => root.clientWidth < 800 && root.clientHeight > root.clientWidth;

  // ---------- Who stands where: placement from the state, seats and houses kept stable, journeys only for real changes ----------
  function spotOf(id) {
    const where = placement(state, id);
    if (where.place === "hq") { const [x, y] = CORE_SPOT[id] ?? CORE_SPOT.jarvis; return { x: world.hq.x * TILE + x, y: world.hq.y * TILE + y, key: `hq:${id}`, seated: CORE_DESK.has(id) }; }
    if (where.place === "station") {
      const b = world.buildings.find((x) => x.dept === where.dept), seat = seats.get(where.dept)?.get(id);
      if (b && seat !== undefined) return { ...seatSpot(b, seat), key: `desk:${where.dept}:${seat}`, seated: true };
    }
    return { ...homeSpot(world, homes.get(id) ?? 0), key: "home", seated: false };
  }
  const dust = (x, y, n, colors, speed = 40, life = 0.5) => { if (reduced() || !visible()) return; for (let i = 0; i < n && effects.length < 240; i++) { const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random()); effects.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 - speed * 0.3, c: colors[i % colors.length], life, g: speed * 1.6, s: 1 + (i % 2) }); } };
  const POOF = ["#fff6e0", "#e8dcc4", "#cfc4b0"], CONFETTI = ["#e0625a", "#f4c63c", "#49ad7c", "#4f8fd6", "#9a6bd0", "#fff6e0"];

  function sync(instant = false) {
    const list = Object.values(state.agents);
    const shown = residents(state);
    hiddenHomes = shown.hidden;
    const atDesk = new Map();
    for (const a of list) { const w = placement(state, a.id); if (w.place === "station") { if (!atDesk.has(w.dept)) atDesk.set(w.dept, []); atDesk.get(w.dept).push(a.id); } }
    const seatCount = {};
    seats.forEach((_, d) => { if (!atDesk.has(d)) seats.delete(d); });
    for (const [d, ids] of atDesk) { const s = assignSlots(ids, seats.get(d)); seats.set(d, s); seatCount[d] = Math.max(...s.values()) + 1; }
    homes = assignSlots(shown.ids, homes);
    const portrait = isPortrait();
    const minHouses = portrait ? 7 : 8;
    const houses = Math.max(minHouses, Math.ceil((Math.max(-1, ...homes.values()) + 1) / 2));
    const next = layout(state, { portrait, seats: seatCount, houses });
    const sig = JSON.stringify(next);
    const rebaked = sig !== worldSig;
    if (rebaked) { world = next; worldSig = sig; ground = bake(world); fitView(); }
    const wanted = new Set([...list.filter((a) => a.kind === "core" || CORE.has(a.id)).map((a) => a.id), ...shown.ids]);
    for (const id of people.keys()) if (!wanted.has(id)) { people.delete(id); if (selected === id) selected = null; if (hover === id) hover = null; }
    const still = instant || reduced() || !visible();
    for (const id of wanted) {
      const to = spotOf(id);
      let p = people.get(id);
      const fresh = !p;
      if (fresh) { const start = !still && to.key.startsWith("desk") ? homeSpot(world, homes.get(id) ?? 0) ?? to : to; p = { id, x: start.x, y: start.y, key: fresh && start === to ? to.key : "home", phase: hashOf(id) % 4, flip: false, hop: 0 }; people.set(id, p); }
      if (p.visiting) continue; // Jarvis is out; it comes back by itself
      p.seated = to.seated;
      if (p.key === to.key) { if (!p.move && !p.route) { p.x = to.x; p.y = to.y; } else if (p.route) p.route[p.route.length - 1] = to; else if (p.move) p.move.to = to; continue; } // a new layout only shifts them
      p.key = to.key;
      const walk = to.key === "home" && walksOut(state, id, walked);
      if (still) { p.x = to.x; p.y = to.y; p.move = null; p.route = null; continue; }
      if (walk) { p.move = null; p.route = walkRoute(world, p, to).slice(); }
      else if (to.key === "home") { p.x = to.x; p.y = to.y; p.move = null; p.route = null; } // any other move home is instant
      else dashTo(p, to);
    }
    const lit = [];
    for (const [d, m] of seats) for (const id of m.keys()) { const i = el("i"); i.dataset.lit = id; i.dataset.dept = d; lit.push(i); }
    winBox.replaceChildren(...lit);
    refreshVisuals();
    root.dataset.people = String(people.size);
  }
  function dashTo(p, to, then) {
    p.route = null;
    p.flip = to.x < p.x;
    p.move = { from: { x: p.x, y: p.y }, to, at: performance.now(), then };
    dust(p.x, p.y, 8, POOF);
  }
  function refreshVisuals() { const now = Date.now(); for (const p of people.values()) p.visual = visualState(state, p.id, now); }

  // ---------- Live events ----------
  const PLACEMENT_EVENTS = new Set(["agent.hired", "agent.retired", "department.created", "department.updated", "ticket.status", "worker.state", "worker.merge_waiting", "worker.merged", "tickets.parked"]);
  function onEvent(e) {
    const feedBefore = state.feed;
    state = reduce(state, e);
    if (PLACEMENT_EVENTS.has(e.type)) sync(); else refreshVisuals();
    const hop = courierFor(e); if (hop) courier(hop);
    if (e.type === "jarvis.visit") jarvisVisit(e);
    if (e.type === "review.result" && e.verdict === "FAIL") { const t = state.tickets[e.ticket_id], p = t && people.get(t.to); if (p) dust(p.x, p.y - 20, 14, ["#55525e", "#77747f", "#99969f"], 18, 1.2); }
    if (e.type === "ticket.status" && e.ticket.status === "done") { const p = people.get(e.ticket.to); if (p) dust(p.x, p.y - 22, 28, CONFETTI, 70, 1); }
    if (e.type === "department.created" || e.type === "agent.hired") { const b = world.buildings.find((x) => x.dept === (e.department?.name ?? "")); if (b) dust((b.x + b.w / 2) * TILE, (b.y + 3) * TILE, 40, POOF, 70, 0.8); }
    if (["agent.hired", "agent.retired", "department.created", "department.updated", "question", "question.asked", "question.answered", "cost.update", "ticket.status", "worker.state", "worker.merge_waiting", "worker.merged", "tickets.parked", "city.paused", "city.resumed"].includes(e.type)) renderDom();
    // The gate's counters and the open panel's numbers only come from the server: read them again once the events settle.
    if (["ticket.status", "worker.state", "cost.update", "tickets.parked", "city.paused", "city.resumed", "turn.failed"].includes(e.type)) refreshSoon();
    if (open?.agent) { paintDoing(); if (eventAbout(e, open.agent)) agentSoon(); }
    if (e.type === "agent.activity") { const b = $(`#citylist button[data-agent="${CSS.escape(e.id)}"]`); if (b) b.textContent = agentLabel(state.agents[e.id]); }
    if (state.feed !== feedBefore) feedDom(); // a screen reader hears each new line once
  }
  const eventAbout = (e, id) => e.id === id || e.agent === id || e.agent?.id === id || e.to === id || e.ticket?.to === id || e.ticket?.from === id || e.question?.asked_by === id;

  // A parcel carried between two agents, only when a real ticket event says it moved.
  function courier({ from, to, kind }) {
    const a = people.get(from), b = people.get(to);
    if (!a || !b || reduced()) return;
    root.dataset.couriers = String(Number(root.dataset.couriers ?? 0) + 1);
    if (visible()) parcels.push({ from: { x: a.x, y: a.y - 14 }, target: b, t: 0, kind });
  }
  // Jarvis dashes over, says what it is doing, and comes back. Its status call can repeat fast: those are not new visits.
  function jarvisVisit({ to, kind }) {
    const now = Date.now(), allowed = visitAllowed(lastVisit, now, to);
    lastVisit = now;
    if (!allowed) return;
    const j = people.get("jarvis"), target = people.get(to);
    if (!j || !target || j.visiting) return;
    root.dataset.visits = String(Number(root.dataset.visits ?? 0) + 1);
    const words = kind === "ask" ? "ASKING" : "CHECKING IN", side = target.x > 40 ? -15 : 15;
    j.visiting = true;
    const back = () => { const home = spotOf("jarvis"); j.visiting = false; if (reduced() || !visible()) { j.x = home.x; j.y = home.y; } else dashTo(j, home); };
    j.say = { text: words, until: performance.now() + 1500 };
    const arrived = () => { j.flip = side < 0 ? false : true; setTimeout(back, 1400); };
    if (reduced() || !visible()) { j.x = target.x + side; j.y = target.y; arrived(); } else dashTo(j, { x: target.x + side, y: target.y }, arrived);
  }

  // ---------- The view: integer-ish zoom, crisp pixels, pan and pinch ----------
  // The room the map may use: not under the side column on a wide screen, not under the top rows or bottom rows on a phone.
  function safeArea() {
    const box = root.getBoundingClientRect(), top = $("#citytop").getBoundingClientRect();
    if (root.clientWidth < 800) { const nav = $("#citydepts").getBoundingClientRect(), feed = $("#cityfeed").getBoundingClientRect(); return { l: 0, t: nav.bottom - box.top + 6, r: root.clientWidth, b: feed.top - box.top - 6 }; }
    const side = $("#cityside").getBoundingClientRect();
    return { l: 0, t: top.bottom - box.top + 8, r: side.left - box.left - 8, b: root.clientHeight };
  }
  function viewSize() {
    const n = cam.zoom * dpr();
    const w = Math.max(1, Math.ceil(root.clientWidth * dpr() / n)), h = Math.max(1, Math.ceil(root.clientHeight * dpr() / n));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const cssW = `${(w * n) / dpr()}px`, cssH = `${(h * n) / dpr()}px`;
    if (canvas.style.width !== cssW) { canvas.style.width = cssW; canvas.style.height = cssH; }
    ctx.imageSmoothingEnabled = false;
    return { w, h };
  }
  function clampCam(x, y) {
    const { w, h } = viewSize(), W = world.width * TILE, H = world.height * TILE;
    return [Math.max(-w * 0.6, Math.min(W - w * 0.4, x)), Math.max(-h * 0.6, Math.min(H - h * 0.4, y))]; // a little past the edge, never lost
  }
  function centreOn(x, y, area = safeArea()) {
    const px = ((area.l + area.r) / 2) / cam.zoom, py = ((area.t + area.b) / 2) / cam.zoom;
    [cam.wantX, cam.wantY] = clampCam(x - px, y - py);
  }
  // The biggest zoom that shows the whole map, and never below one art pixel per screen pixel.
  function fitView(force = false) {
    if (!world || (cam.userMoved && !force) || !root.clientWidth) return;
    const area = safeArea(), W = world.width * TILE, H = world.height * TILE;
    const portrait = world.portrait;
    const usable = ZOOMS.filter((z) => z * dpr() === Math.round(z * dpr()) || dpr() === 1);
    let best = 1;
    for (const z of usable.length ? usable : ZOOMS) if (W * z <= area.r - area.l && (portrait || H * z <= area.b - area.t)) best = z;
    cam.zoom = best;
    if (force) cam.userMoved = false;
    viewSize();
    centreOn(W / 2, portrait ? (area.b - area.t) / 2 / best : H / 2, area); // a phone starts at the top of the map, HQ first
    cam.x = cam.wantX; cam.y = cam.wantY;
  }
  function setZoom(z, cx = root.clientWidth / 2, cy = root.clientHeight / 2) {
    if (z === cam.zoom) return;
    const ax = cam.x + cx / cam.zoom, ay = cam.y + cy / cam.zoom;
    cam.zoom = z; cam.userMoved = true;
    viewSize();
    [cam.x, cam.y] = clampCam(ax - cx / z, ay - cy / z);
    cam.wantX = cam.x; cam.wantY = cam.y;
    wake();
  }
  const zoomStep = (dir, cx, cy) => { const i = ZOOMS.indexOf(cam.zoom) + dir; if (ZOOMS[i]) setZoom(ZOOMS[i], cx, cy); };
  const zoomToBuilding = (b) => { cam.userMoved = true; const i = Math.max(ZOOMS.indexOf(cam.zoom), ZOOMS.indexOf(3)); cam.zoom = ZOOMS[i]; viewSize(); centreOn((b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE); wake(); };

  // Pick by art position. Figures get a forgiving box: fingers are bigger than sprites.
  const toArt = (ev) => { const r = root.getBoundingClientRect(); return { x: cam.x + (ev.clientX - r.left) / cam.zoom, y: cam.y + (ev.clientY - r.top) / cam.zoom }; };
  function pickAgent(ev, slack = 0) {
    const { x, y } = toArt(ev), extra = slack / cam.zoom;
    let best = null, bestD = Infinity;
    for (const p of people.values()) {
      const dx = Math.abs(x - p.x), dy = Math.abs(y - (p.y - 10));
      if (dx > 8 + extra || dy > 13 + extra) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
  function pickBuilding(ev) {
    const { x, y } = toArt(ev), tx = x / TILE, ty = y / TILE;
    for (const b of [world.hq, ...world.buildings]) if (!b.archived && tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) return b.dept;
    return null;
  }

  let drag = null, pinchDist = 0;
  const pointers = new Map();
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (Math.abs(ev.deltaY) < 4 && !ev.ctrlKey) return;
    const r = root.getBoundingClientRect();
    wheelSum += ev.deltaY;
    if (Math.abs(wheelSum) > 60) { zoomStep(wheelSum < 0 ? 1 : -1, ev.clientX - r.left, ev.clientY - r.top); wheelSum = 0; }
  }, { passive: false });
  let wheelSum = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    pointers.set(ev.pointerId, ev);
    canvas.setPointerCapture?.(ev.pointerId);
    if (pointers.size === 1) drag = { x: ev.clientX, y: ev.clientY, moved: false, cx: cam.x, cy: cam.y, touch: ev.pointerType === "touch" };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) {
      if (ev.pointerType !== "touch") { const p = pickAgent(ev); const next = p?.id ?? null; if (next !== hover) { hover = next; wake(); } canvas.style.cursor = next || pickBuilding(ev) ? "pointer" : "grab"; }
      return;
    }
    pointers.set(ev.pointerId, ev);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchDist && Math.abs(d / pinchDist - 1) > 0.25) { const r = root.getBoundingClientRect(); zoomStep(d > pinchDist ? 1 : -1, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top); pinchDist = d; }
      if (!pinchDist) pinchDist = d;
      drag = null;
      return;
    }
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) { cam.userMoved = true; [cam.x, cam.y] = clampCam(drag.cx - dx / cam.zoom, drag.cy - dy / cam.zoom); cam.wantX = cam.x; cam.wantY = cam.y; wake(); }
  });
  const endPointer = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (drag && !drag.moved && ev.type === "pointerup") {
      const p = pickAgent(ev, drag.touch ? 14 : 0);
      if (p) selectAgent(p.id); else { const dept = pickBuilding(ev); if (dept) openDept(dept); }
    }
    if (!pointers.size) drag = null;
  };
  canvas.addEventListener("pointerup", endPointer); canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => { if (hover) { hover = null; wake(); } });
  canvas.addEventListener("dblclick", (ev) => { const dept = pickBuilding(ev); const b = dept && [world.hq, ...world.buildings].find((x) => x.dept === dept); if (b) zoomToBuilding(b); });
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { closePanel(); return; }
    if (ev.target.closest?.("input")) return;
    if (ev.key === "+" || ev.key === "=") zoomStep(1); else if (ev.key === "-") zoomStep(-1);
  });
  new ResizeObserver(() => { if (world) { const was = world.portrait; if (was !== isPortrait()) { worldSig = ""; sync(true); } fitView(); wake(); } }).observe(root);

  function selectAgent(id) {
    const p = people.get(id);
    if (p) {
      selected = id;
      if (!reduced()) { p.hop = 1; dust(p.x, p.y - 8, 6, ["#ffe9a0", "#fff6e0"], 30, 0.4); }
      showAgentOnMap(p);
      wake();
    }
    openAgent(id);
  }
  // A figure the panel would hide comes into view beside it.
  function showAgentOnMap(p) {
    requestAnimationFrame(() => {
      const box = root.getBoundingClientRect(), area = safeArea(), pane = panel.hidden ? null : panel.getBoundingClientRect();
      if (pane && root.clientWidth >= 800) area.l = pane.right - box.left + 8;
      if (pane && root.clientWidth < 800) area.b = pane.top - box.top - 6;
      const sx = (p.x - cam.x) * cam.zoom, sy = (p.y - cam.y) * cam.zoom;
      if (sx < area.l + 30 || sx > area.r - 30 || sy < area.t + 50 || sy > area.b - 20) { centreOn(p.x, p.y - 10, area); wake(); }
    });
  }

  // ---------- Drawing ----------
  function drawPerson(p, now, f) {
    const a = state.agents[p.id];
    if (!a) return;
    const moving = !!(p.move || p.route), key = p.visual ?? "idle", vis = VISUALS[key] ?? VISUALS.working;
    const pose = moving ? "still" : key === "idle" && p.seated ? "still" : vis.pose;
    const frame = (f + p.phase) % 4;
    const stride = moving ? (Math.floor(now / (p.move ? 40 : 130)) % 4) : null;
    const hopY = p.hop > 0 ? -Math.round(Math.sin(p.hop * Math.PI) * 7) : 0;
    const floatY = p.id === "jarvis" && !moving ? [-2, -3, -2, -1][f] : 0;
    const x = Math.round(p.x - cam.x), y = Math.round(p.y - cam.y);
    if (!p.seated || moving) { ctx.fillStyle = "rgba(20,18,40,.35)"; ctx.fillRect(x - 5, y, 10, 2); ctx.fillRect(x - 4, y + 2, 8, 1); }
    if (key === "waiting_owner" && !moving) { const k = reduced() ? 1 : f % 2; ctx.fillStyle = k ? "rgba(255,216,74,.45)" : "rgba(255,216,74,.25)"; ctx.fillRect(x - 11, y - 1, 22, 4); ctx.fillRect(x - 8, y - 3, 16, 8); }
    if (p.id === "jarvis") { ctx.fillStyle = "rgba(120,220,255,.16)"; ctx.fillRect(x - 10, y - 24, 20, 26); ctx.fillRect(x - 7, y - 27, 14, 32); }
    const sprite = figure(a, pose, frame, stride);
    const sy = y - 24 + hopY + floatY;
    if (p.flip) { ctx.save(); ctx.scale(-1, 1); ctx.drawImage(sprite, -x - 10, sy); ctx.restore(); } else ctx.drawImage(sprite, x - 10, sy);
    if (p.seated && !moving) ctx.drawImage(desk(p.id === "reviewer" ? "clipboard" : p.id === "secretary" ? "laptop" : propFor(a) ?? "laptop"), x - 12, y - 11);
    if (key === "failed" && !reduced() && Math.random() < 0.05) dust(p.x, p.y - 22, 1, ["#77747f"], 8, 0.8);
  }
  function drawBubble(p, f) {
    const key = p.visual ?? "idle";
    if (p.move || p.route) return;
    const x = Math.round(p.x - cam.x), y = Math.round(p.y - 24 - cam.y);
    if (key !== "idle") {
      const loud = key === "waiting_owner";
      const bounce = reduced() ? 0 : loud ? [0, -3, -5, -3][f] : key === "failed" || key === "blocked" ? 0 : [0, 0, -1, -1][(f + p.phase) % 4];
      const img = bubble(key);
      if (loud && !reduced() && f % 2) { ctx.fillStyle = "rgba(255,216,74,.4)"; ctx.fillRect(x - 12, y - 17 + bounce, 24, 19); }
      ctx.drawImage(img, x - 8, y - 15 + bounce);
    }
  }
  function label(text, wx, wy, fg = "#fff6e0", bg = INK) {
    const t = fit(text, 120), w = textW(t) + 6, x = Math.round(wx - cam.x - w / 2), y = Math.round(wy - cam.y);
    ctx.fillStyle = bg; ctx.fillRect(x, y, w, 9); ctx.fillRect(x + 1, y - 1, w - 2, 11);
    pixelText(ctx, t, x + 3, y + 2, fg);
  }
  function draw(now) {
    const { w, h } = viewSize();
    const f = reduced() ? 0 : Math.floor(now / SCENERY_MS / 2) % 4;
    ctx.fillStyle = "#2d5d53"; ctx.fillRect(0, 0, w, h);
    const ox = Math.round(cam.x), oy = Math.round(cam.y);
    const M = MARGIN * TILE, sx = Math.max(0, ox + M), sy = Math.max(0, oy + M), dw = Math.min(w, ground.width - sx), dh = Math.min(h, ground.height - sy);
    if (dw > 0 && dh > 0) ctx.drawImage(ground, sx, sy, dw, dh, sx - ox - M, sy - oy - M, dw, dh); // only the part on screen
    // Scenery that moves: the fountain's jet and ripples.
    const fx = world.hq.x * TILE + FOUNTAIN[0] - ox, fy = world.hq.y * TILE + FOUNTAIN[1] - oy;
    const jet = [13, 15, 14, 16][f];
    R(ctx, fx - 1, fy - 10 - jet, 2, jet, "#bfe6ff"); R(ctx, fx - 3, fy - 10 - jet, 6, 1, "#d7f1ff");
    for (const [dx, dy] of [[-3, -8 - jet + (f * 3) % 6], [3, -8 - jet + ((f + 2) * 3) % 6], [-5, -4 - ((f * 2) % 4)], [5, -6 + ((f * 2) % 4)]]) R(ctx, fx + dx, fy + dy - 2, 1, 2, "#a8dcff");
    R(ctx, fx - 12 + f * 2, fy - 1, 6, 1, "#8ab2d6"); R(ctx, fx + 6 - f * 2, fy + 2, 7, 1, "#8ab2d6");
    // A house with someone home has its light on.
    const occupied = new Set();
    for (const p of people.values()) if (!p.move && !p.route && p.key === "home") occupied.add(Math.floor((homes.get(p.id) ?? 0) / 2));
    for (const i of occupied) { const hh = world.homes.houses[i]; if (hh) { const win = houseWindows(hh); R(ctx, win.x - ox, win.y - oy, win.w, win.h, "#ffdf94"); R(ctx, win.x - ox, win.y - oy, win.w, 2, "#ffefc0"); } }
    if (hiddenHomes) label(`+${hiddenHomes} MORE IN WORKFORCE`, world.homes.x * TILE + 60, (world.homes.y + world.homes.h) * TILE - 12);
    // Lit glass behind the desks: one window per occupied seat.
    const litWin = [];
    for (const [d, m] of seats) { const b = world.buildings.find((x) => x.dept === d); if (!b) continue; for (const seat of m.values()) { const q = windowRect(seatSpot(b, seat), b); litWin.push(q); R(ctx, q.x - ox, q.y - oy, q.w, q.h, "#ffdf94"); R(ctx, q.x - ox, q.y - oy, q.w, 4, "#ffefc0"); } }
    // Everyone, back to front.
    const order = [...people.values()].sort((a, b) => a.y - b.y);
    for (const p of order) drawPerson(p, now, f);
    for (const p of parcels) {
      const tx = p.target.x, ty = p.target.y - 14, k = p.t, ax = p.from.x + (tx - p.from.x) * k, ay = p.from.y + (ty - p.from.y) * k;
      const x = Math.round(ax - cam.x), y = Math.round(ay - cam.y - Math.sin(k * Math.PI) * 26);
      R(ctx, Math.round(ax - cam.x) - 3, Math.round(ay - cam.y) + 12, 6, 2, "rgba(20,18,40,.35)");
      R(ctx, x - 4, y - 4, 8, 7, INK); R(ctx, x - 3, y - 3, 6, 5, p.kind === "ticket" ? "#f4c63c" : "#49ad7c"); R(ctx, x - 1, y - 3, 2, 5, "#fff6e0");
    }
    // The mullions and sill sit in front of the figures; every occupied window keeps a name plate cut to its width.
    for (const q of litWin) { R(ctx, q.x - ox, q.y - oy, 1, q.h, INK); R(ctx, q.x + q.w - 1 - ox, q.y - oy, 1, q.h, INK); R(ctx, q.x + Math.floor(q.w / 2) - ox, q.y - oy, 1, 6, INK); R(ctx, q.x - ox, q.y - oy, q.w, 1, INK); R(ctx, q.x - 1 - ox, q.y + q.h - oy, q.w + 2, 2, "#8c7a66"); }
    for (const p of order) if (p.key.startsWith("desk") && !p.move && p.id !== selected && p.id !== hover) label(fit(p.id, Math.round((world.buildings[0] ? (world.buildings[0].w * TILE - 8) / 4 : 34) - 8)), p.x, p.y + 8);
    for (const p of order) drawBubble(p, f);
    for (const e of effects) R(ctx, e.x - cam.x, e.y - cam.y, e.s, e.s, e.c);
    // The one being looked at gets an arrow and its name; so does whoever the mouse is on, and the core keep name plates.
    for (const p of order) if (p.id === selected || p.id === hover || CORE.has(p.id)) {
      const a = state.agents[p.id];
      if (a) label(p.id === hover && p.visual && p.visual !== "idle" ? `${p.id}: ${VISUALS[p.visual].label}` : p.id, p.x, p.y + 4, p.id === selected ? INK : "#fff6e0", p.id === selected ? "#ffd84a" : INK);
    }
    for (const p of order) if (p.say && p.say.until > performance.now()) label(p.say.text, p.x, p.y - 46, INK, "#8fdcff"); // Jarvis's word stays on top of every mark
    const s = selected && people.get(selected);
    if (s) { const bob = reduced() ? 0 : [0, 1, 2, 1][f]; const x = Math.round(s.x - cam.x), y = Math.round(s.y - cam.y) - (s.visual && s.visual !== "idle" ? 46 : 32) + bob; R(ctx, x - 4, y, 8, 2, INK); R(ctx, x - 3, y, 6, 2, "#ffd84a"); R(ctx, x - 3, y + 2, 6, 2, INK); R(ctx, x - 2, y + 2, 4, 1, "#ffd84a"); R(ctx, x - 1, y + 4, 2, 2, INK); }
  }

  // The frame loop. Scenery ticks at a low rate; only journeys, effects and parcels ask for every frame.
  let last = performance.now(), lastDraw = 0, fpsN = 0, fpsT = last, paused = true, needDraw = true;
  const wake = () => { needDraw = true; resume(); };
  function step(dt, now) {
    let busy = false;
    for (const p of people.values()) {
      if (p.hop > 0) { p.hop = Math.max(0, p.hop - dt * 2.6); busy = true; }
      if (p.move) {
        busy = true;
        const t = Math.max(0, Math.min(1, (now - p.move.at) / DASH_MS)); // by the clock: a slow machine still gets there on time
        const e = 1 - (1 - t) ** 3;
        const { from, to } = p.move;
        p.x = from.x + (to.x - from.x) * e; p.y = from.y + (to.y - from.y) * e;
        if (Math.random() < 0.5) dust(p.x, p.y - 2, 1, POOF, 12, 0.3);
        if (t >= 1) { const then = p.move.then; p.move = null; dust(p.x, p.y - 4, 12, ["#ffe9a0", "#fff6e0", "#f4c63c"], 50, 0.45); then?.(); }
      } else if (p.route) {
        busy = true;
        const to = p.route[0], dx = to.x - p.x, dy = to.y - p.y, d = Math.hypot(dx, dy), s = WALK_SPEED * dt;
        if (Math.abs(dx) > 0.5) p.flip = dx < 0;
        if (d <= s) { p.x = to.x; p.y = to.y; p.route.shift(); if (!p.route.length) p.route = null; } else { p.x += (dx / d) * s; p.y += (dy / d) * s; }
      }
    }
    if (effects.length) { busy = true; effects = effects.filter((e) => { e.life -= dt; e.vy += e.g * dt; e.x += e.vx * dt; e.y += e.vy * dt; return e.life > 0; }); }
    if (parcels.length) {
      busy = true;
      parcels = parcels.filter((p) => { p.t += dt / 0.9; if (p.t < 1) return true; dust(p.target.x, p.target.y - 14, 8, p.kind === "ticket" ? ["#f4c63c", "#fff6e0"] : ["#49ad7c", "#fff6e0"], 34, 0.4); return false; });
    }
    if (Math.abs(cam.wantX - cam.x) > 0.5 || Math.abs(cam.wantY - cam.y) > 0.5) {
      busy = true;
      const k = reduced() ? 1 : Math.min(1, dt * 8);
      cam.x += (cam.wantX - cam.x) * k; cam.y += (cam.wantY - cam.y) * k;
    }
    return busy;
  }
  function frame(now) {
    if (root.offsetParent === null) { paused = true; return; }
    const dt = Math.max(0, Math.min(0.25, (now - last) / 1000)); last = now;
    const busy = world ? step(dt, now) : false;
    if (world && (busy || needDraw || now - lastDraw >= SCENERY_MS)) { draw(now); lastDraw = now; needDraw = false; fpsN++; }
    if (now - fpsT > 2000) { root.dataset.fps = String(Math.round((fpsN * 1000) / (now - fpsT))); fpsN = 0; fpsT = now; }
    requestAnimationFrame(frame);
  }
  function resume() { if (paused && root.offsetParent !== null) { paused = false; last = performance.now(); requestAnimationFrame(frame); } }

  // DOM panels: built with textContent only.
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // A heading in the game's lettering. The real words stay in the DOM for readers and search; what the capitals can't spell stays plain text.
  function heading(tag, text, cls) {
    const e = el(tag, cls);
    const w = textW(text);
    if (!fontable(text) || w * 2 > 300) { e.textContent = text; return e; }
    const [c, g] = newCanvas(w, 5);
    pixelText(g, text, 0, 0, tag === "h3" ? "#5a3219" : "#7a4a2a");
    c.style.width = `${w * 2}px`; c.style.height = "10px"; c.setAttribute("aria-hidden", "true");
    e.append(el("span", "sr", text), c);
    return e;
  }
  const panel = $("#citypanel");
  let open = null;
  function closePanel() { open = null; selected = null; panel.hidden = true; panel.replaceChildren(); needDraw = true; }
  function showPanel(title, kind) {
    // The same panel redrawn with fresher data keeps the reader's place and focus.
    const same = !panel.hidden && panel.dataset.kind === kind, top = panel.scrollTop;
    panel.hidden = false; panel.replaceChildren();
    const head = el("header"); head.append(heading("h3", title), (() => { const b = el("button", "closer"); b.type = "button"; b.setAttribute("aria-label", "Close"); b.title = "Close"; const [c, g] = newCanvas(7, 7); for (let i = 0; i < 7; i++) { R(g, i, i, 1, 1, "#5a3219"); R(g, 6 - i, i, 1, 1, "#5a3219"); } c.setAttribute("aria-hidden", "true"); b.append(c); b.onclick = closePanel; return b; })());
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

  // ---------- One agent: what it is doing right now, in plain words, kept fresh while the panel is open ----------
  function portrait(a) {
    const [c, g] = newCanvas(20, 26);
    g.drawImage(figure(a, "still", 0, null), 0, 0);
    c.className = "portrait"; c.setAttribute("aria-hidden", "true");
    return c;
  }
  function doingNow(id, live) {
    const key = visualState(state, id), info = state.activities[id] ?? live?.activity;
    return { key, text: doingWords(key, info?.activity === key ? info.detail : "") };
  }
  function paintDoing() {
    const id = open?.agent, box = panel.querySelector("[data-doing]");
    if (!id || !box) return;
    const { key, text } = doingNow(id, open.live);
    box.dataset.doing = key;
    box.querySelector(".words").textContent = text;
    const icon = box.querySelector("canvas");
    const g = icon.getContext("2d"); g.clearRect(0, 0, 17, 18);
    if (key !== "idle") g.drawImage(bubble(key), 0, 0);
    const v = panel.querySelector("[data-status] .v"); if (v) v.textContent = agentStatus(state, id).replace(/_/g, " ");
  }
  async function readAgent(id) {
    try {
      const r = await fetchImpl(`./api/city/agent?id=${encodeURIComponent(id)}`);
      const j = await r.json().catch(() => ({}));
      return r.ok ? { data: j } : { error: j.error || `server error ${r.status}` };
    } catch { return { error: "no connection" }; }
  }
  function fillAgent(box, id, res) {
    const a = state.agents[id], d = res.data, p = agentPanel(state, id);
    const ticketsNow = d?.current ?? Object.values(state.tickets).filter((t) => t.to === id);
    box.replaceChildren();
    if (res.error) box.append(el("p", "hint", `Live details did not load (${res.error}). This is what the city last heard.`));
    const wait = d?.awaiting_merge ?? a.awaiting_merge;
    if (wait) box.append(el("p", "merge", `Done, and staying until ${wait.branch}${wait.repo ? ` in ${wait.repo}` : ""} is merged. Waiting ${ageText(Date.now() - Date.parse(wait.since))}.`));
    const status = row(a.kind === "worker" ? "worker state" : "status", agentStatus(state, id).replace(/_/g, " ")); status.dataset.status = "";
    box.append(row("id", id), row("department", d?.department ?? p.department), row("reports to", p.parent ?? "—"), row("model", MODEL_NAME[d?.model] ?? p.modelName));
    box.append(row("runs on", d?.executor ?? p.executor ?? "sdk"), status);
    box.append(row("cost so far", estUsd(d?.cost_usd_estimate ?? p.costUsd, 3)), row("tokens today", p.tokensToday === null ? "—" : String(p.tokensToday)), costNote());
    const storyId = ticketsNow[0]?.id ?? d?.recent?.[0]?.id ?? p.lastTicket;
    if (storyId) box.append(button("act", ticketsNow[0] ? "Story of this ticket" : `Story of ${storyId}`, () => openData(storyView(storyId, open))));
    const list = (title, items, draw) => {
      box.append(heading("h4", `${title} (${items.length})`));
      const ul = el("ul", "tickets");
      for (const it of items) ul.append(draw(it));
      box.append(ul);
    };
    list("Working on", ticketsNow, (t) => { const li = el("li"); li.append(el("span", null, `${t.status.replace(/_/g, " ")}: ${t.goal}`)); return li; });
    const waiting = d?.waiting_for ?? Object.values(state.tickets).filter((t) => t.from === id);
    if (waiting.length) list("Waiting for", waiting, (t) => el("li", null, `${t.to}: ${t.status.replace(/_/g, " ")}`));
    const questions = d?.questions ?? Object.values(state.questions).filter((q) => q.question?.asked_by === id).map((q) => ({ id: q.id, text: q.question.questions?.[0]?.text ?? "" }));
    if (questions.length) list("Asking you", questions, (q) => el("li", "ask", q.text));
    if (d?.recent?.length) list("Recent results", d.recent, (t) => { const li = el("li", "withact"); li.append(el("span", null, `${t.status}: ${t.result ?? t.goal}`), storyButton(t.id)); return li; });
    const tools = d?.recent_tools ?? [];
    box.append(heading("h4", "Last tools"));
    const ul = el("ul", "actions");
    if (!tools.length) ul.append(el("li", "mute", "None recorded."));
    for (const t of tools) ul.append(el("li", null, `${t.decision === "allow" ? "" : `${t.decision}: `}${t.tool}`));
    box.append(ul);
  }
  let agentTimer = null;
  const agentSoon = () => { clearTimeout(agentTimer); agentTimer = setTimeout(() => refreshAgent(), 300); };
  function whereWords(id) {
    const tag = placement(state, id);
    return tag.place === "home" ? "At home" : tag.place === "hq" ? "At HQ" : `At its desk in ${tag.dept}`;
  }
  async function refreshAgent() {
    const mine = open;
    if (!mine?.agent || !visible()) return;
    const res = await readAgent(mine.agent);
    if (open !== mine || !state.agents[mine.agent]) return;
    const where = panel.querySelector(".who .where");
    if (where) where.textContent = whereWords(mine.agent);
    mine.live = res.data ?? mine.live;
    const sig = JSON.stringify([res, state.agents[mine.agent]?.worker_state, Object.values(state.tickets).filter((t) => t.to === mine.agent)]);
    if (sig === mine.sig) return; // nothing new: leave the reader's focus and place alone
    mine.sig = sig;
    const box = panel.querySelector("[data-live]");
    if (box) fillAgent(box, mine.agent, res);
    paintDoing();
  }
  setInterval(() => { if (open?.agent) refreshAgent(); }, 3000);
  async function openAgent(id) {
    const a = state.agents[id], p = agentPanel(state, id);
    if (!a) return;
    open = { agent: id };
    selected = people.has(id) ? id : null;
    const box = showPanel(p.role, "agent");
    const who = el("div", "who"), line = el("div", "doing"); line.dataset.doing = "";
    const [icon] = newCanvas(17, 18); icon.setAttribute("aria-hidden", "true"); icon.className = "bub";
    line.append(icon, el("span", "words"));
    const badge = el("span", "badge", p.modelName); badge.style.background = p.modelColor;
    who.append(portrait(a), (() => { const t = el("div"); t.append(el("div", "where", whereWords(id)), badge); return t; })());
    box.append(who, line);
    const holder = el("div"); holder.dataset.live = "";
    box.append(holder);
    fillAgent(holder, id, {}); // what the city already knows, at once; the live read follows
    const form = el("form", "instruct");
    const input = el("input"); input.placeholder = `@${id} …`; input.setAttribute("aria-label", `Direct instruction to ${id}`);
    const send = el("button", null, "Send"); send.type = "submit";
    const note = el("div", "mute");
    form.append(input, send, note);
    form.onsubmit = async (ev) => { ev.preventDefault(); const text = input.value.trim(); if (!text) return; const say = text.startsWith("@") ? text : `@${id} ${text}`; try { const r = await fetchImpl("./api/city/instruct", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: say }) }); const j = await r.json(); note.textContent = r.ok ? `Sent as ticket ${j.ticket.id}, manager cc'd.` : j.error; if (r.ok) input.value = ""; } catch { note.textContent = "Could not reach the server."; } };
    box.append(form);
    paintDoing();
    await refreshAgent();
  }
  function openDept(name) {
    open = { dept: name };
    selected = null;
    const d = departmentPanel(state, name);
    const box = showPanel(`${name === "HQ" ? "Headquarters" : `${name} department`}`, "department");
    const b = world?.buildings.find((x) => x.dept === name) ?? (name === "HQ" ? world?.hq : null);
    if (d.state === "archived" && (!b || b.archived)) box.append(el("p", "hint", "Archived. It has no building and no active agents until it is reactivated."));
    if (d.mission) box.append(row("mission", d.mission));
    box.append(row("manager", d.manager ?? "—"), row("workers", d.workers.length ? d.workers.map((w) => `${w} (${d.workerStates[w].replace(/_/g, " ")})`).join(", ") : "—"), row("today's cost, UTC", d.todayUsd === null ? "—" : estUsd(d.todayUsd)), costNote());
    box.append(heading("h4", `Open tickets (${d.openTickets.length})`));
    const ul = el("ul", "tickets");
    if (!d.openTickets.length) ul.append(el("li", "mute", "None right now."));
    for (const t of d.openTickets) { const li = el("li", "withact"); li.append(el("span", null, `${t.to}: ${t.status.replace(/_/g, " ")} — ${t.goal}`), storyButton(t.id)); ul.append(li); }
    box.append(ul);
    if (d.released.length) {
      box.append(heading("h4", `Released (${d.released.length})`));
      const past = el("ul", "tickets");
      for (const r of d.released) { const li = el("li", "withact"); li.append(el("span", null, `${r.id}: ${r.role}`), button("act", "Details", () => openAgent(r.id))); past.append(li); }
      box.append(past);
    }
    if (b && !b.archived) box.append(button("act wide", "Zoom in", () => zoomToBuilding(b)));
  }
  // What every mark on the map means, drawn with the map's own bubbles.
  function openLegend() {
    open = { legend: true };
    const box = showPanel("What the marks mean", "legend");
    box.append(el("p", "hint", "Everyone on this map is a real agent, and each mark comes from what the backend reports. A figure at a desk is working or holding its place; a figure in a yard is off work."));
    const ul = el("ul", "legendlist");
    for (const [key, v] of Object.entries(VISUALS)) {
      const li = el("li"); li.dataset.visual = key;
      const [c, g] = newCanvas(17, 18); c.setAttribute("aria-hidden", "true");
      if (key !== "idle") g.drawImage(bubble(key), 0, 0);
      li.append(c, el("b", null, v.label), el("span", "mute", key === "idle" ? "No mark. Nothing right now." : v.words));
      ul.append(li);
    }
    box.append(ul);
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
    const list = (title, rows) => { box.append(heading("h4", `${title} (${rows.length})`)); const ul = el("ul"); ul.append(...rows.map(workerItem)); if (!rows.length) ul.append(el("li", "mute", "None.")); box.append(ul); };
    list("Current", g.current);
    list("Released", g.released);
  } }] });

  function costTable(title, rows, cell = (r) => document.createTextNode(r.name)) {
    const wrap = el("div"); wrap.append(heading("h4", title));
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
      box.append(heading("h4", "Integrations"), el("p", "hint", Number.isNaN(checked) ? "Time of the check unknown." : `Probed at ${atTime(checked)} (${relTime(Date.now() - checked)}). The server probes at most every five minutes.`));
      const groups = integrationGroups(res.integrations);
      if (!groups.length) box.append(el("p", "mute", "No integrations are configured."));
      for (const g of groups) {
        box.append(heading("h4", g.category));
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
      box.append(heading("h4", "What the words mean"), legend);
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

  // What only the server can say again: the gate's counters, parked tickets, spend. Never moves anyone.
  let refreshTimer = null;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 1500); };
  async function refresh() {
    if (root.offsetParent === null || document.hidden) return;
    try {
      const r = snapshotImpl ? await snapshotImpl() : await fetchImpl("./api/city");
      if (r.ok) state = applyLive(state, await r.json());
    } catch { /* the stream's own banner says when the server is gone */ }
    refreshVisuals();
    renderTop();
    if (open?.parked && open.ids !== parkedIds()) openParked();
    if (open?.data) openData(open.data, true);
  }

  function renderTop() {
    const t = topBar(state), g = gateStatus(state), parked = parkedRows(state).length;
    const value = stat("EST. VALUE, NOT A CHARGE", t.usage ? estUsd(t.usage.usd) : "—"); value.title = COST_NOTE;
    $("#citytop").replaceChildren(
      stat("AGENTS", `${t.agentsActive} active · ${t.agentsTotal} total`), stat("TICKETS RUNNING", String(t.ticketsRunning)), stat("QUESTIONS", String(t.questionsWaiting)), stat("PARKED", String(parked)),
      stat("TURNS", g.known ? `${g.running ?? "—"} running · ${g.waiting ?? "—"} waiting` : "—"),
      stat("USAGE TODAY, UTC", t.usage ? `${t.usage.turns} turns · ${Math.round(t.usage.tokens / 1000)}k tokens` : "—"), value,
      stat("STOCKHOLM", stockholmTime(Date.now())),
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
    const msg = $("#cityempty"), text = $("#cityerror").hidden ? cityMessage(state) : null;
    msg.hidden = !text; msg.textContent = text ?? "";
  }

  const agentLabel = (a) => { const w = VISUALS[visualState(state, a.id)]; return `Agent: ${a.id} (${a.role}, ${MODEL_NAME[a.model] ?? a.model}), ${placement(state, a.id).place === "home" ? "at home" : w.label.toLowerCase()}`; };
  function renderDom() {
    renderTop();
    const names = ["HQ", ...departmentNames(state)];
    const list = $("#citydepts"); list.replaceChildren(heading("h3", "Departments"));
    const atWork = (name) => Object.values(state.agents).filter((a) => { const w = placement(state, a.id); return w.place === "station" && w.dept === name; }).length;
    names.forEach((name, i) => {
      const off = state.departments[name]?.state === "archived";
      const b = el("button", off ? "dept off" : "dept", off ? `${name} (archived)` : name);
      b.style.setProperty("--swatch", name === "HQ" ? "#3f5f92" : ROOFS[(i - 1) % ROOFS.length][0]);
      b.dataset.building = name;
      if (name !== "HQ") b.dataset.count = String(atWork(name));
      b.onclick = () => openDept(name);
      list.append(b);
    });
    list.append(heading("h3", "Records"));
    for (const [key, label, go] of [["workforce", "Workforce", () => openData(workforceView())], ["costs", "Costs (estimates)", () => openData(costsView())], ["health", "Health", () => openData(healthView())], ["parked", `Parked (${parkedRows(state).length})`, openParked], ["legend", "What the marks mean", openLegend]]) { const b = el("button", "dept rec", label); b.dataset.view = key; b.onclick = go; list.append(b); }
    const a11y = $("#citylist");
    const focused = document.activeElement?.closest?.("#citylist button");
    const keep = focused ? { agent: focused.dataset.agent, building: focused.dataset.building } : null;
    a11y.replaceChildren();
    for (const name of names) { const b = el("button", null, `Building: ${name}`); b.dataset.building = name; b.onclick = () => openDept(name); a11y.append(b); }
    const shown = new Set(residents(state).ids);
    for (const a of Object.values(state.agents)) { if (a.state === "retired" && !shown.has(a.id)) continue; const b = el("button", null, agentLabel(a)); b.dataset.agent = a.id; b.onclick = () => selectAgent(a.id); a11y.append(b); }
    if (keep?.agent) a11y.querySelector(`[data-agent="${CSS.escape(keep.agent)}"]`)?.focus();
    if (keep?.building) a11y.querySelector(`[data-building="${CSS.escape(keep.building)}"]`)?.focus();
    feedDom();
    if (open?.dept) openDept(open.dept);
    if (open?.parked && open.ids !== parkedIds()) openParked();
  }
  const stat = (k, v) => { const s = el("div", "stat"); s.append(el("span", "k", k), el("b", null, v)); return s; };
  function feedDom() {
    const feed = $("#cityfeed"); feed.replaceChildren(heading("h3", "Activity"));
    if (!state.feed.length) feed.append(el("div", "mute", "Quiet. Nothing has happened since this page opened."));
    for (const f of state.feed.slice(0, 8)) { const line = el("div", `line ${f.kind}`); line.append(el("span", "t", new Date(f.at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })), el("span", null, f.text)); feed.append(line); }
  }

  // Data: a snapshot, then events. If either is missing the view says so; it never fills the gap with made-up data.
  let streamLost = false; // streamLost: the live stream dropped and has not come back yet
  const problem = (text) => { const e = $("#cityerror"); e.textContent = text ?? ""; e.hidden = !text; };
  async function load() {
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
    // A load places everyone directly: no replayed journeys.
    people.clear(); parcels = []; effects = [];
    sync(true);
    renderDom();
    fitView();
    needDraw = true;
  }
  // The one shared stream. A drop is shown; on reconnect events may have been missed, so start again from a fresh snapshot.
  events.addEventListener("jarvis-sse", (ev) => { const j = ev.detail; if (j?.type === "city") onEvent(j.event); else if (j?.type === "jarvis") onEvent({ type: "result", ticket_id: "", status: "done", summary: j.text }); });
  events.addEventListener("jarvis-sse-error", () => { streamLost = true; problem("Live updates from Jarvis stopped. Reconnecting…"); });
  events.addEventListener("jarvis-sse-open", () => { if (streamLost) { streamLost = false; problem(null); load(); } });

  $("#cityparkedbtn").onclick = () => openParked();
  $("#cityzoomin").onclick = () => zoomStep(1);
  $("#cityzoomout").onclick = () => zoomStep(-1);
  $("#cityzoomfit").onclick = () => { fitView(true); wake(); };
  setInterval(refresh, 20000); // the gate's counters have no events of their own
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

  root.dataset.cityReady = "1";
  load().then(resume);
  return {
    resume() { resume(); if (world) { fitView(); wake(); } },
    get state() { return state; },
    get people() { return people; },
    get view() { return { x: cam.x, y: cam.y, zoom: cam.zoom }; },
    onEvent,
  };
}

// The HUD opens the view; the city mounts itself the first time, then only resumes its frame loop.
let city = null;
function openView() {
  const root = document.getElementById("city");
  if (!city) city = window.__city = mountCity(root);
  else city.resume();
}
document.addEventListener("jarvis-view", (ev) => { if (ev.detail === "city") openView(); });
if (document.body.classList.contains("view-city")) openView(); // opened by the URL before this module loaded
