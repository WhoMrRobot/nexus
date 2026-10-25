// The "second brain" on the home screen: a living graph of the notes. Folders and files are hubs,
// each file's sections and lines are the dots around it, and files that mention each other are linked.
// It is laid out once, then drifts slowly; now and then a soft pulse travels along a link.
// Only the shape of the notes is drawn, never their text.

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

function seeded(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class Brain {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'brain';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.px = 320;
    this.nodes = [];
    this.links = [];
    this.pulses = [];
    this.key = '';
    this.wanted = false;
    this.running = false;
    this.raf = 0;
    this.loop = this.loop.bind(this);
    this.readColors();
    darkQuery.addEventListener('change', () => { this.readColors(); this.draw(); });
    document.addEventListener('visibilitychange', () => (document.hidden ? this.pause() : this.wanted && this.start()));
    this.build(placeholderNotes());
  }

  readColors() {
    const dark = darkQuery.matches;
    this.ink = dark ? [222, 226, 245] : [30, 34, 62];
    this.accent = cssVar('--accent') || (dark ? '#a3b1ff' : '#4f5bd5');
  }

  setSize(px) {
    if (Math.abs(px - this.px) < 1) return;
    this.px = px;
    this.canvas.style.width = `${px}px`;
    this.canvas.style.height = `${px}px`;
    this.fit();
  }

  // Rebuild from the repo's files, only when they changed. `loose` (e.g. photos) float round the edge.
  setNotes(files, loose = []) {
    const key = files.map((f) => `${f.path}:${f.text ? f.text.length : 0}`).join('|') + `+${loose.length}`;
    if (key === this.key) return;
    this.key = key;
    this.build(files, loose);
  }

  build(files, loose = []) {
    const rand = seeded(files.length * 7919 + 17);
    const hubs = new Map();     // folder -> node
    const fileNodes = new Map(); // path -> node
    const nodes = [];
    const links = [];
    const add = (n) => { nodes.push(n); return n; };

    for (const f of files) {
      const folder = f.path.includes('/') ? f.path.split('/')[0] : '';
      if (folder && !hubs.has(folder)) hubs.set(folder, add({ kind: 'hub', folder, r: 3.4, leaves: [] }));
      const lines = f.text ? f.text.split('\n') : [];
      const marks = lines.filter((l) => /^\s*(#{1,4}\s|[-*+]\s|\d+[.)]\s|\|)/.test(l)).length;
      const count = f.text === undefined ? 3 : Math.max(3, Math.min(60, Math.round(marks / 2.5)));
      const node = add({ kind: 'file', path: f.path, folder, leaves: count, r: 2.1 });
      fileNodes.set(f.path, node);
      if (folder) links.push({ a: hubs.get(folder), b: node, kind: 'tree' });
    }

    // files that mention one another
    const paths = [...fileNodes.keys()];
    const byBase = new Map();
    for (const p of paths) {
      const base = p.split('/').pop();
      byBase.set(base, byBase.has(base) ? null : p);
    }
    const seen = new Set();
    for (const f of files) {
      if (!f.text) continue;
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
      for (const m of f.text.matchAll(/(?:\.{1,2}\/)*(?:[\w-]+\/)*[\w.-]+\.md/g)) {
        const target = resolve(m[0], dir, fileNodes, byBase);
        if (!target || target === f.path) continue;
        const key = [f.path, target].sort().join('>');
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ a: fileNodes.get(f.path), b: fileNodes.get(target), kind: 'mention' });
      }
    }

    // lay out hubs and files with a small force simulation; each file keeps room for its dots
    const movers = nodes;
    movers.forEach((n, i) => {
      const a = (i / movers.length) * Math.PI * 2 + rand();
      const d = 20 + rand() * 40;
      n.x = Math.cos(a) * d;
      n.y = Math.sin(a) * d;
      n.vx = 0;
      n.vy = 0;
      n.room = n.kind === 'file' ? Math.sqrt(n.leaves * 0.65) * 1.25 + 3 : 4;
    });
    for (let it = 0; it < 360; it++) {
      const cool = 1 - it / 360;
      for (let i = 0; i < movers.length; i++) {
        const p = movers[i];
        for (let j = i + 1; j < movers.length; j++) {
          const q = movers[j];
          let dx = q.x - p.x, dy = q.y - p.y;
          let d = Math.hypot(dx, dy) || 0.01;
          const min = p.room + q.room + 11;
          const push = (d < min ? (min - d) * 0.5 : 0) + 30 / (d * d);
          dx /= d; dy /= d;
          p.vx -= dx * push; p.vy -= dy * push;
          q.vx += dx * push; q.vy += dy * push;
        }
      }
      for (const l of links) {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const rest = l.a.room + l.b.room + (l.kind === 'tree' ? 6 : 14);
        const pull = (d - rest) * (l.kind === 'tree' ? 0.02 : 0.004);
        l.a.vx += (dx / d) * pull; l.a.vy += (dy / d) * pull;
        l.b.vx -= (dx / d) * pull; l.b.vy -= (dy / d) * pull;
      }
      for (const n of movers) {
        n.vx -= n.x * 0.003;
        n.vy -= n.y * 0.003;
        n.x += n.vx * cool;
        n.y += n.vy * cool;
        n.vx *= 0.6;
        n.vy *= 0.6;
      }
    }

    // each file's dots: most in a sunflower disc joined by faint spokes, the rest drifting loose nearby
    const dots = [];
    for (const n of nodes) {
      if (n.kind !== 'file') continue;
      const inner = Math.ceil(n.leaves * 0.55);
      const disc = 1.25 * Math.sqrt(inner) + 0.9;
      for (let i = 0; i < n.leaves; i++) {
        if (i < inner) {
          const a = i * 2.39996;
          const d = 1.25 * Math.sqrt(i + 1) + 0.9;
          dots.push({ kind: 'leaf', parent: n, spoke: true, x: n.x + Math.cos(a) * d, y: n.y + Math.sin(a) * d, r: 1.05 });
        } else {
          const a = rand() * Math.PI * 2;
          const d = disc * (1.5 + rand() * 2.2) + 1;
          dots.push({ kind: 'leaf', parent: n, spoke: false, x: n.x + Math.cos(a) * d, y: n.y + Math.sin(a) * d, r: 0.95 });
        }
      }
    }

    // loose items in a ring round the edge, like unlinked pages in a graph view
    const reach = Math.max(...dots.map((d) => Math.hypot(d.x, d.y)), 10);
    for (let i = 0; i < loose.length; i++) {
      const a = rand() * Math.PI * 2;
      const d = reach * (0.75 + Math.sqrt(rand()) * 0.4);
      dots.push({ kind: 'leaf', parent: null, spoke: false, x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.9 });
    }

    for (const n of [...nodes, ...dots]) {
      n.phase = rand() * Math.PI * 2;
      n.amp = n.kind === 'leaf' ? (n.spoke ? 0.35 : 0.8) + rand() * 0.4 : 0.25;
      n.hot = (n.parent || n).folder === 'journal';
    }
    this.nodes = nodes;
    this.dots = dots;
    this.links = links;
    this.mentions = links.filter((l) => l.kind === 'mention');
    this.pulses = [];
    this.fit();
  }

  // Scale the layout to fill a circle in the canvas.
  fit() {
    const all = [...this.nodes, ...(this.dots || [])];
    if (!all.length) return;
    const cx = all.reduce((s, n) => s + n.x, 0) / all.length;
    const cy = all.reduce((s, n) => s + n.y, 0) / all.length;
    const reach = Math.max(...all.map((n) => Math.hypot(n.x - cx, n.y - cy))) || 1;
    this.cx = cx;
    this.cy = cy;
    this.scale = (this.px / 2 - 6) / reach;
    this.draw();
  }

  pos(n, t) {
    const s = this.scale;
    const spin = t * 0.012;   // the whole brain turns very slowly
    const x = (n.x - this.cx) * s + Math.cos(t * 0.6 + n.phase) * n.amp * s;
    const y = (n.y - this.cy) * s + Math.sin(t * 0.5 + n.phase) * n.amp * s;
    return [this.px / 2 + x * Math.cos(spin) - y * Math.sin(spin), this.px / 2 + x * Math.sin(spin) + y * Math.cos(spin)];
  }

  draw() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const side = Math.round(this.px * dpr);
    if (this.canvas.width !== side) {
      this.canvas.width = side;
      this.canvas.height = side;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.px, this.px);
    const t = reducedQuery.matches ? 0 : performance.now() / 1000;
    const [ir, ig, ib] = this.ink;
    const ink = (a) => `rgba(${ir},${ig},${ib},${a})`;
    const P = new Map();
    for (const n of [...this.nodes, ...this.dots]) P.set(n, this.pos(n, t));

    ctx.lineWidth = 0.5;
    ctx.strokeStyle = ink(0.07);
    ctx.beginPath();
    for (const d of this.dots) {
      if (!d.spoke) continue;
      const [x1, y1] = P.get(d.parent);
      const [x2, y2] = P.get(d);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    ctx.strokeStyle = ink(0.16);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const l of this.links) {
      const [x1, y1] = P.get(l.a);
      const [x2, y2] = P.get(l.b);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    for (const d of this.dots) {
      const [x, y] = P.get(d);
      ctx.fillStyle = d.hot ? this.accent : ink(0.62);
      ctx.beginPath();
      ctx.arc(x, y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const n of this.nodes) {
      const [x, y] = P.get(n);
      ctx.fillStyle = n.hot ? this.accent : ink(n.kind === 'hub' ? 0.95 : 0.85);
      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // a thought: a small light travelling along a link
    if (!reducedQuery.matches && this.mentions.length) {
      if (!this.pulses.length || t - this.pulses[this.pulses.length - 1].start > 1.6) {
        const l = this.mentions[Math.floor(Math.random() * this.mentions.length)];
        this.pulses.push({ l, start: t });
      }
      this.pulses = this.pulses.filter((p) => t - p.start < 1.4);
      for (const p of this.pulses) {
        const f = (t - p.start) / 1.4;
        const [x1, y1] = P.get(p.l.a);
        const [x2, y2] = P.get(p.l.b);
        const x = x1 + (x2 - x1) * f, y = y1 + (y2 - y1) * f;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, this.accent);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = Math.sin(f * Math.PI);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  loop() {
    if (!this.canvas.isConnected) {
      this.pause();
      return;
    }
    this.draw();
    if (this.running) this.raf = requestAnimationFrame(this.loop);
  }

  start() {
    this.wanted = true;
    if (this.running || document.hidden) return;
    if (reducedQuery.matches) {
      this.draw();
      return;
    }
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  stop() {
    this.wanted = false;
    this.pause();
  }
}

// "../work/setup.md" seen in "medical/x.md" → "work/setup.md"; falls back to a unique file name.
function resolve(ref, dir, known, byBase) {
  const clean = ref.replace(/^\.\//, '');
  if (known.has(clean)) return clean;
  const parts = (dir + clean).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  const joined = out.join('/');
  if (known.has(joined)) return joined;
  return byBase.get(clean.split('/').pop()) || null;
}

// Before the notes load: a believable stand-in with the same shape, so the screen is never empty.
function placeholderNotes() {
  const rand = seeded(42);
  const folders = ['a', 'b', 'c', 'd', 'e', 'f'];
  const files = [];
  for (let i = 0; i < 40; i++) {
    const folder = folders[i % folders.length];
    const lines = Array.from({ length: 4 + Math.floor(rand() * 40) }, () => '- x').join('\n');
    files.push({ path: `${folder}/n${i}.md`, text: lines + (i > 0 ? `\nsee ${folders[(i * 3) % 6]}/n${(i * 7) % i}.md` : '') });
  }
  return files;
}
