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
  // `colors` paints the dots with a gradient (keeping their depth shading) instead of one tint.
  constructor({ preset = 64, px = preset, state = 'working', colors } = {}) {
    this.colors = colors;
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
    paintFrame(ctx, this.frame(this.preset, t, this.opts), darkQuery.matches, this.colors ? undefined : this.tint);
    if (this.colors) this.colorize(ctx, side);
  }

  // Lay a gradient over the dots only. On dark backgrounds the dots are light, so multiplying keeps
  // their near/far shading; on light backgrounds they are dark, so the colour goes on top instead.
  colorize(ctx, side) {
    this.off ??= document.createElement('canvas');
    if (this.off.width !== side) {
      this.off.width = side;
      this.off.height = side;
    }
    const o = this.off.getContext('2d');
    o.globalCompositeOperation = 'source-over';
    o.clearRect(0, 0, side, side);
    const g = o.createLinearGradient(0, side, side, 0);
    this.colors.forEach((c, i) => g.addColorStop(i / (this.colors.length - 1), c));
    o.fillStyle = g;
    o.fillRect(0, 0, side, side);
    o.globalCompositeOperation = 'destination-in';
    o.drawImage(this.canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = darkQuery.matches ? 'multiply' : 'source-atop';
    ctx.globalAlpha = darkQuery.matches ? 1 : 0.85;
    ctx.drawImage(this.off, 0, 0);
    ctx.restore();
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
