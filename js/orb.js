// The animated thinking orb (thinking-orbs by Jakub Antalik, MIT; engine in vendor/thinking-orbs).
// One canvas and one animation loop per orb. The app moves the same canvas into each new render,
// so the animation never restarts, and changes its state to match what Nexus is doing.
import { r as resolvePreset, M as MODE_FRAMES, p as paintFrame } from '../vendor/thinking-orbs/engine.js';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

function accentTint() {
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--orb').trim();
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export class Orb {
  // `preset` is a tuned design size (64 for avatars, 20 for inline text); `px` is the size on screen.
  constructor({ preset = 64, px = preset, state = 'working' } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orb';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.width = `${px}px`;
    this.canvas.style.height = `${px}px`;
    this.preset = preset;
    this.px = px;
    this.wanted = false;
    this.running = false;
    this.raf = 0;
    this.tint = accentTint();
    this.loop = this.loop.bind(this);
    darkQuery.addEventListener('change', () => { this.tint = accentTint(); this.draw(); });
    document.addEventListener('visibilitychange', () => (document.hidden ? this.pause() : this.wanted && this.start()));
    this.setState(state);
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    const { mode, speed, opts } = resolvePreset(state, this.preset);
    this.frame = MODE_FRAMES[mode];
    this.speed = speed;
    this.opts = opts;
    this.draw();
  }

  draw() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const side = Math.round(this.px * dpr);
    if (this.canvas.width !== side) {
      this.canvas.width = side;
      this.canvas.height = side;
    }
    const ctx = this.canvas.getContext('2d');
    const k = (dpr * this.px) / this.preset;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, this.preset, this.preset);
    const t = reducedQuery.matches ? 0.6 : (performance.now() / 1000) * this.speed;
    paintFrame(ctx, this.frame(this.preset, t, this.opts), darkQuery.matches, this.tint);
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
