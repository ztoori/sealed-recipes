/**
 * The demo film's sound, made in the browser with the Web Audio API: no audio files to download.
 *  - a score: a soft pad whose chord and brightness follow the chapter, and a pulse (a heartbeat in the tense
 *    parts, a quiet clock elsewhere);
 *  - effects on cue (BEATS[].cue): a lock clicking, a coin, a seal, the camera whooshing in;
 *  - optional narration: if web/public/assets/film/voice.json exists (scripts/film-voice.ts), each beat's clip
 *    plays with it, and the score dips under the voice.
 * Nothing plays until the viewer presses play (browsers require that), and the mute button silences all of it.
 */
import type { ChapterId, Cue } from './script';

const MOOD: Record<ChapterId, { chord: number[]; bright: number; pulse: 'heart' | 'clock' | 'none'; bpm: number; level: number }> = {
  problem: { chord: [110, 130.81, 164.81], bright: 380, pulse: 'heart', bpm: 62, level: 0.9 },
  twist: { chord: [87.31, 130.81, 174.61], bright: 900, pulse: 'none', bpm: 0, level: 1 },
  pick: { chord: [130.81, 164.81, 196], bright: 1300, pulse: 'clock', bpm: 96, level: 0.7 },
  seal: { chord: [130.81, 164.81, 196], bright: 1400, pulse: 'clock', bpm: 96, level: 0.7 },
  pay: { chord: [174.61, 220, 261.63], bright: 1500, pulse: 'clock', bpm: 96, level: 0.7 },
  run: { chord: [110, 130.81, 164.81], bright: 650, pulse: 'heart', bpm: 76, level: 0.9 },
  paid: { chord: [87.31, 130.81, 174.61], bright: 1600, pulse: 'clock', bpm: 96, level: 0.75 },
  proof: { chord: [130.81, 196, 246.94], bright: 1700, pulse: 'none', bpm: 0, level: 0.75 },
  agents: { chord: [146.83, 174.61, 220], bright: 900, pulse: 'clock', bpm: 120, level: 0.85 },
  end: { chord: [130.81, 196, 293.66], bright: 2000, pulse: 'none', bpm: 0, level: 1 },
};

export class FilmAudio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private music!: GainNode;
  private fx!: GainNode;
  private filter!: BiquadFilterNode;
  private voices: OscillatorNode[] = [];
  private noise?: AudioBuffer;
  private mood: ChapterId = 'problem';
  private nextPulse = 0;
  private timer?: ReturnType<typeof setInterval>;
  private muted = false;

  /** call from the play button's click (a user gesture), so the browser lets sound start */
  async start() {
    if (!this.ctx) this.build();
    const c = this.ctx!;
    if (c.state !== 'running') await c.resume().catch(() => {});
    this.nextPulse = c.currentTime + 0.1;
    this.timer ??= setInterval(() => this.schedule(), 60);
  }
  /** pause: everything stops where it is */
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } void this.ctx?.suspend().catch(() => {}); }
  setMuted(m: boolean) { this.muted = m; if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05); }
  /** the score dips while the narrator speaks */
  duck(on: boolean) { if (this.ctx) this.music.gain.setTargetAtTime(on ? 0.32 : 1, this.ctx.currentTime, 0.25); }

  setMood(id: ChapterId) {
    if (id === this.mood || !this.ctx) { this.mood = id; return; }
    this.mood = id;
    const m = MOOD[id], now = this.ctx.currentTime;
    this.voices.forEach((o, i) => o.frequency.setTargetAtTime(m.chord[i % 3] * (i >= 3 ? 1.005 : 1), now, 0.6));
    this.filter.frequency.setTargetAtTime(m.bright, now, 0.8);
    this.music.gain.setTargetAtTime(m.level, now, 0.6);
  }

  private build() {
    const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const c = (this.ctx = new Ctx());
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.9; this.master.connect(c.destination);
    // a gentle limiter, so stacked effects never clip
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; comp.connect(this.master);
    this.music = c.createGain(); this.music.gain.value = MOOD[this.mood].level; this.music.connect(comp);
    this.fx = c.createGain(); this.fx.gain.value = 0.8; this.fx.connect(comp);
    this.filter = c.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = MOOD[this.mood].bright; this.filter.Q.value = 0.7;
    const padGain = c.createGain(); padGain.gain.value = 0.05; this.filter.connect(padGain); padGain.connect(this.music);
    // the pad: the chord twice, slightly detuned, plus a sub an octave below the root
    const chord = MOOD[this.mood].chord;
    for (let i = 0; i < 6; i++) {
      const o = c.createOscillator(); o.type = i < 3 ? 'sawtooth' : 'triangle';
      o.frequency.value = chord[i % 3] * (i >= 3 ? 1.005 : 1); o.connect(this.filter); o.start(); this.voices.push(o);
    }
    const sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.value = 55; const sg = c.createGain(); sg.gain.value = 0.05; sub.connect(sg); sg.connect(this.music); sub.start();
    // slow breathing on the filter
    const lfo = c.createOscillator(); lfo.frequency.value = 0.08; const lg = c.createGain(); lg.gain.value = 180; lfo.connect(lg); lg.connect(this.filter.frequency); lfo.start();
    const len = c.sampleRate; const buf = c.createBuffer(1, len, c.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  private schedule() {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    const m = MOOD[this.mood];
    if (m.pulse === 'none' || !m.bpm) { this.nextPulse = c.currentTime + 0.2; return; }
    const step = 60 / m.bpm;
    while (this.nextPulse < c.currentTime + 0.25) {
      if (m.pulse === 'heart') { this.thump(this.nextPulse, 0.32, 58); this.thump(this.nextPulse + 0.22, 0.2, 52); }
      else this.click(this.nextPulse, 0.035, 5200, this.music);
      this.nextPulse += step;
    }
  }

  // ---- instruments
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  private tone(t: number, f: number, dur: number, peak = 0.12, type: OscillatorType = 'sine', to?: number) {
    const c = this.ctx!; const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    this.env(g, t, peak, 0.008, dur); o.connect(g); g.connect(this.fx); o.start(t); o.stop(t + dur + 0.05);
  }
  private thump(t: number, peak = 0.5, low = 45) { this.tone(t, 140, 0.32, peak, 'sine', low); }
  private click(t: number, peak = 0.08, hp = 3000, out: AudioNode = this.fx) {
    const c = this.ctx!; const s = c.createBufferSource(); s.buffer = this.noise!; const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = c.createGain(); this.env(g, t, peak, 0.002, 0.03); s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 0.5, 0.06);
  }
  private sweep(t: number, from: number, to: number, dur: number, peak = 0.14) {
    const c = this.ctx!; const s = c.createBufferSource(); s.buffer = this.noise!; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.fx); s.start(t, 0, dur + 0.05);
  }
  private chime(t: number, base = 880, peak = 0.06) { [1, 1.5, 2, 3].forEach((k, i) => this.tone(t + i * 0.012, base * k, 1.4 - i * 0.25, peak / (i + 1))); }

  /** an effect, now */
  cue(name: Cue) {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    const t = c.currentTime + 0.02;
    switch (name) {
      case 'heartbeat': this.thump(t, 0.45, 50); this.thump(t + 0.24, 0.3, 46); break;
      case 'deny': this.tone(t, 70, 0.28, 0.1, 'sawtooth', 60); this.tone(t + 0.42, 66, 0.34, 0.1, 'sawtooth', 52); break;
      case 'impact': this.thump(t, 0.7, 32); this.sweep(t, 2400, 200, 1.4, 0.12); break;
      case 'seal': this.thump(t, 0.5, 60); this.chime(t + 0.05, 660, 0.08); break;
      case 'whoosh': this.sweep(t, 300, 3200, 0.7, 0.12); break;
      case 'type': for (let i = 0; i < 14; i++) this.click(t + i * 0.11 + Math.random() * 0.05, 0.05, 4200); break;
      case 'lock': this.click(t, 0.18, 1500); this.tone(t + 0.02, 220, 0.18, 0.12, 'triangle', 110); break;
      case 'ticks': [0, 0.45, 0.9].forEach((d) => { this.click(t + d, 0.1, 2500); this.tone(t + d, 1318, 0.12, 0.04); }); break;
      case 'chime': this.chime(t, 988, 0.07); break;
      case 'coin': this.tone(t, 1318, 0.12, 0.08, 'square'); this.tone(t + 0.08, 1760, 0.3, 0.07, 'square'); break;
      case 'dive': this.sweep(t, 3000, 180, 1.1, 0.14); this.thump(t + 0.9, 0.5, 40); break;
      case 'pings': [0, 0.6, 1.2, 1.8].forEach((d, i) => this.tone(t + d, 1046 + i * 120, 0.5, 0.04)); break;
      case 'hush': this.music.gain.setTargetAtTime(0.25, t, 0.3); this.music.gain.setTargetAtTime(MOOD[this.mood].level, t + 3, 0.8); this.sweep(t, 600, 120, 2.4, 0.06); break;
      case 'unlock': [523.25, 659.25, 783.99].forEach((f, i) => this.tone(t + i * 0.09, f, 0.5, 0.06, 'triangle')); this.click(t, 0.14, 1800); break;
      case 'register': for (let i = 0; i < 5; i++) this.click(t + i * 0.12, 0.08, 3500); this.chime(t + 0.7, 1174.66, 0.06); break;
      case 'success': [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(t + i * 0.11, f, 0.7, 0.05, 'triangle')); break;
      case 'drop': this.music.gain.setTargetAtTime(0.0001, t, 0.15); this.thump(t + 0.3, 0.7, 30); this.music.gain.setTargetAtTime(MOOD[this.mood].level, t + 3.2, 0.6); break;
      case 'glitch': for (let i = 0; i < 6; i++) this.tone(t + i * 0.05, 200 + Math.random() * 1600, 0.04, 0.05, 'square'); this.sweep(t + 0.3, 200, 2600, 0.5, 0.1); break;
      case 'resolve': this.chime(t, 523.25, 0.08); this.thump(t, 0.4, 50); break;
    }
  }

  dispose() { this.stop(); void this.ctx?.close().catch(() => {}); this.ctx = undefined; this.voices = []; }
}

/**
 * Narration clips, one per beat, if the site has them (web/public/assets/film/voice.json, written by
 * scripts/film-voice.ts). Without that file the film runs on captions alone, and nothing is requested again.
 */
export class FilmVoice {
  private clips = new Map<string, HTMLAudioElement>();
  private files: Record<string, string> | null | undefined;
  /** the voice's credit line from voice.json (a CC BY voice must be credited where it is used) */
  credit = '';
  private current?: HTMLAudioElement;
  private muted = false;
  constructor(private base: string, private onSpeaking: (on: boolean) => void) {}

  async load() {
    if (this.files !== undefined) return;
    this.files = null;
    try {
      const r = await fetch(`${this.base}voice.json`, { cache: 'no-cache' });
      if (r.ok) { const j = (await r.json()) as { clips: Record<string, string>; credit?: string }; this.files = j.clips ?? null; this.credit = j.credit ?? ''; }
    } catch { /* captions only */ }
  }
  get available() { return !!this.files; }
  /** speak a beat's line, starting `offset` seconds into it (after a seek) */
  play(id: string, offset: number, rate: number) {
    this.pause();
    const f = this.files?.[id]; if (!f) return;
    let a = this.clips.get(id);
    if (!a) { a = new Audio(this.base + f); a.preload = 'auto'; a.onplaying = () => this.onSpeaking(true); a.onended = a.onpause = () => this.onSpeaking(false); this.clips.set(id, a); }
    a.muted = this.muted; a.playbackRate = rate;
    try { a.currentTime = Math.max(0, offset); } catch { /* not loaded yet: from the top */ }
    if (offset > 0 && Number.isFinite(a.duration) && offset >= a.duration) return;
    this.current = a; void a.play().catch(() => {});
  }
  pause() { if (this.current && !this.current.paused) this.current.pause(); this.current = undefined; }
  setMuted(m: boolean) { this.muted = m; this.clips.forEach((a) => { a.muted = m; }); }
  /** load the next clips ahead of time */
  warm(ids: string[]) { for (const id of ids) { const f = this.files?.[id]; if (f && !this.clips.has(id)) { const a = new Audio(this.base + f); a.preload = 'auto'; a.onplaying = () => this.onSpeaking(true); a.onended = a.onpause = () => this.onSpeaking(false); this.clips.set(id, a); } } }
}
