/**
 * The guided demo, as a film: a code-rendered motion piece that walks through the whole product (the problem, the
 * sealed box, picking a recipe, sealing, quoting, paying, the sealed run, the result and the payout, the proof, and
 * how AI agents buy), with a camera that glides across mock screens of the app, spotlights with short labels,
 * captions for every spoken line, a score made in the browser (demo-film/audio.ts) and optional narration.
 *
 * It is the same technique as the recipe films on Trust & privacy (RecipeFilm.tsx): one 960 × 540 stage, scaled
 * to fit, driven by a clock; every frame is drawn from the screenplay in demo-film/script.ts. Nothing inside the
 * film is a link: the only buttons are the player's own, and the end card's "Try it" and "Watch again".
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../icons';
import { BrandMark, Seal } from '../ui';
import { BEATS, CAMERA, CHAPTERS, END, SPOTS, beatAt, type ChapterId, type Key } from './demo-film/script';
import { FilmAudio, FilmVoice } from './demo-film/audio';

const W = 960, H = 540;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const inOut = (x: number) => { const p = clamp(x); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
/** 0 → 1 over d seconds from a */
const prog = (t: number, a: number, d = 0.6) => ease((t - a) / d);
/** visible from a to b, fading at both ends */
const span = (t: number, a: number, b: number, f = 0.45) => Math.min(prog(t, a, f), 1 - prog(t, b - f, f));
const rise = (o: number, px = 14): CSSProperties => ({ opacity: o, transform: `translateY(${((1 - o) * px).toFixed(2)}px)` });
const pop = (o: number): CSSProperties => ({ opacity: clamp(o * 1.4), transform: `scale(${(0.86 + 0.14 * o).toFixed(3)})` });
const vis = (o: number): CSSProperties => ({ opacity: o, visibility: o < 0.01 ? 'hidden' : 'visible' });
const clock = (x: number) => { const s = Math.round(x); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** text typed out between a and a + d */
const typed = (s: string, t: number, a: number, d: number) => s.slice(0, Math.round(s.length * clamp((t - a) / d)));
const HEX = '0123456789abcdef';
/** a line of ciphertext that settles into `s` between a and a + d (a decryption you can see) */
const decode = (s: string, t: number, a: number, d: number) => {
  const p = clamp((t - a) / d); const n = Math.round(s.length * p); const seed = Math.floor(t * 18);
  return s.slice(0, n) + Array.from(s.slice(n), (c, i) => (c === ' ' ? ' ' : HEX[(seed * 7 + i * 13) % 16])).join('');
};

// ---- the world: four app screens on one canvas; the camera glides between them
const WX = { R: { x: 50, y: 50 }, Q: { x: 1050, y: 50 }, X: { x: 50, y: 630 }, S: { x: 1050, y: 630 } };
const camHold = (k: Key, tt: number) => ({ x: k.x, y: k.y, z: k.z * (1 + 0.035 * clamp((tt - k.t) / 8)) });
function camAt(t: number, reduce: boolean) {
  const i = CAMERA.findIndex((k) => t < k.t);
  if (i === -1) return camHold(CAMERA[CAMERA.length - 1], t);
  if (i === 0) return camHold(CAMERA[0], CAMERA[0].t);
  const k0 = CAMERA[i - 1], k1 = CAMERA[i];
  const move = reduce ? 0.01 : (k1.move ?? 1.2), start = k1.t - move;
  if (t < start) return camHold(k0, t);
  const a = camHold(k0, start), p = inOut((t - start) / move);
  return { x: a.x + (k1.x - a.x) * p, y: a.y + (k1.y - a.y) * p, z: Math.exp(Math.log(a.z) + (Math.log(k1.z) - Math.log(a.z)) * p) };
}
const toStage = (c: { x: number; y: number; z: number }, x: number, y: number) => ({ x: W / 2 + (x - c.x) * c.z, y: H / 2 + (y - c.y) * c.z });

/** what the film knows about the live recipes (prices and names follow the contract when the page has them) */
export interface FilmData {
  recipes: { ticker: string; name: string; price: number; runs: number; risk: string; kind: string }[];
  split: { price: number; parts: number; runner: number; protocol: number; creator: number; reserve: number };
}
export const FALLBACK: FilmData = {
  recipes: [
    { ticker: 'CHECK', name: 'Contract check before you sign', price: 0.12, runs: 8, risk: 'low', kind: 'report' },
    { ticker: 'SAFE3', name: 'Wallet scam scan', price: 0.15, runs: 5, risk: 'low', kind: 'report' },
    { ticker: 'AUDIT3', name: 'Account security audit', price: 0.2, runs: 4, risk: 'low', kind: 'report' },
  ],
  split: { price: 0.12, parts: 0.045, runner: 0.03, protocol: 0.0024, creator: 0.0426, reserve: 0 },
};
const usd = (n: number, dp = 2) => n.toFixed(dp);

export function DemoFilm({ data = FALLBACK, onTry, onBrowse, voiceBase = './assets/film/' }: { data?: FilmData; onTry: (ticker: string) => void; onBrowse: () => void; voiceBase?: string }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(1);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('srs-film-muted') === '1'; } catch { return false; } });
  const [cc, setCc] = useState(true);
  const [full, setFull] = useState(false);
  const [seekN, setSeekN] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const reduce = useMemo(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const audio = useMemo(() => new FilmAudio(), []);
  const voice = useMemo(() => new FilmVoice(voiceBase, (on) => audio.duck(on)), [voiceBase, audio]);
  useEffect(() => () => audio.dispose(), [audio]);
  const [credit, setCredit] = useState('');
  useEffect(() => { void voice.load().then(() => setCredit(voice.available ? voice.credit : '')); }, [voice]);
  useEffect(() => { audio.setMuted(muted); voice.setMuted(muted); try { localStorage.setItem('srs-film-muted', muted ? '1' : '0'); } catch { /* not kept */ } }, [muted, audio, voice]);

  // fit the stage to the frame
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / W)); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { const on = () => setFull(document.fullscreenElement === root.current); document.addEventListener('fullscreenchange', on); return () => document.removeEventListener('fullscreenchange', on); }, []);
  // pause when the tab is hidden
  useEffect(() => { const v = () => { if (document.hidden) setPlaying(false); }; document.addEventListener('visibilitychange', v); return () => document.removeEventListener('visibilitychange', v); }, []);
  // the clock
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      setT((x) => { const n = x + dt; if (n >= END) { setPlaying(false); return END; } return n; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  // sound follows the picture: effects when a beat starts, the score's mood per chapter, the narrator per beat
  const chapter = CHAPTERS.find((c) => t >= c.a && t < c.b) ?? CHAPTERS[CHAPTERS.length - 1];
  const now = beatAt(t);
  const prevT = useRef(0);
  useEffect(() => {
    const p = prevT.current; prevT.current = t;
    if (!playing || t < p || t - p > 0.5) return;
    for (const b of BEATS) if (b.cue && p < b.at && t >= b.at) audio.cue(b.cue);
  }, [t, playing, audio]);
  useEffect(() => { audio.setMood(chapter.id as ChapterId); }, [chapter.id, audio]);
  const beatId = now?.beat.id;
  useEffect(() => {
    if (!playing || !now) { voice.pause(); return; }
    voice.play(now.beat.id, t - now.beat.at, 1);
    voice.warm(BEATS.slice(now.i + 1, now.i + 3).map((b) => b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId, playing, seekN]);
  useEffect(() => { if (playing) void audio.start(); else audio.stop(); }, [playing, audio]);
  // screenshots and tests can seek: window.dispatchEvent(new CustomEvent('demo-film-seek', { detail: 42 }))
  useEffect(() => { const on = (e: Event) => { setT(clamp(Number((e as CustomEvent).detail) / END) * END); setSeekN((n) => n + 1); }; addEventListener('demo-film-seek', on); return () => removeEventListener('demo-film-seek', on); }, []);

  const toggle = () => { if (t >= END) { setT(0); setSeekN((n) => n + 1); } setPlaying((p) => !p); };
  const seek = (x: number) => { setT(Math.max(0, Math.min(END, x))); setSeekN((n) => n + 1); };
  const fullscreen = () => {
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    void root.current?.requestFullscreen?.().then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {})).catch(() => {});
  };
  const small = scale < 0.62;
  const ended = t >= END - 0.05 && !playing;
  const cam = camAt(t, reduce);
  const ci = CHAPTERS.indexOf(chapter);

  return (
    <div className={'film dfilm' + (full ? ' full' : '')} ref={root}>
      <div className="film-frame" ref={frame} role="region" aria-label="The guided demo, as a film" style={{ aspectRatio: `${W} / ${H}` }}
        onClick={(e) => { if ((e.target as HTMLElement).closest('button')) return; toggle(); }}>
        <div className="film-stage" style={{ width: W, height: H, transform: `scale(${scale})` }}>
          <div className="film-bg" style={{ ['--h' as never]: [355, 38, 214, 200, 150, 260, 150, 160, 280, 38][ci] }} />
          <ActProblem t={t} />
          <ActBox t={t} />
          <World t={t} cam={cam} d={data} />
          <Spotlight t={t} cam={cam} />
          <ActProof t={t} />
          <ActAgents t={t} d={data} />
          <ActEnd t={t} />
          <div className="df-kicker" key={chapter.id} style={rise(prog(t, chapter.a, 0.5), 6)}><b>{String(ci + 1).padStart(2, '0')}</b>{chapter.label}{chapter.id === 'agents' && <span>a separate story</span>}</div>
          {cc && !small && <Caption t={t} />}
          <div className="df-vignette" />
        </div>
        {!playing && !ended && t < 0.05 && (
          <button className="df-start" onClick={toggle} aria-label="Play the demo film">
            <span className="df-start-ic"><Icon name="play" size={28} fill /></span>
            <b>Watch the demo</b><span>2½ minutes · sound on</span>
          </button>
        )}
        {!playing && !ended && t >= 0.05 && <button className="film-bigplay" aria-label="Play" onClick={toggle}><Icon name="play" size={26} /></button>}
        {ended && (
          <div className="df-endcard">
            <button className="btn primary lg" onClick={() => onTry('CHECK')}><Icon name="receipt" size={16} />Try CHECK live</button>
            <button className="btn ghost" onClick={onBrowse}><Icon name="market" size={15} />See all recipes</button>
            <button className="btn ghost" onClick={toggle}><Icon name="refresh" size={14} />Watch again</button>
          </div>
        )}
      </div>
      {cc && small && now && <div className="film-subs df-subs" aria-live="polite"><div className="film-kicker">{String(ci + 1).padStart(2, '0')} · {chapter.label}</div><b>{now.beat.text}</b></div>}
      <div className="film-controls">
        <button className="btn ghost sm icon-only" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'stop' : ended ? 'refresh' : 'play'} size={14} /></button>
        <div className="film-track" role="slider" aria-label="Position in the film" aria-valuemin={0} aria-valuemax={END} aria-valuenow={Math.round(t)} tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') seek(t + 5); if (e.key === 'ArrowLeft') seek(t - 5); if (e.key === ' ') { e.preventDefault(); toggle(); } }}
          onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); const go = (x: number) => seek(clamp((x - r.left) / r.width) * END); go(e.clientX); const mv = (ev: PointerEvent) => go(ev.clientX); const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); }}>
          {CHAPTERS.map((c) => (
            <div key={c.id} className={'film-seg' + (t >= c.b ? ' done' : t >= c.a ? ' on' : '') + (c.id === 'agents' ? ' agents' : '')} style={{ flexGrow: c.b - c.a }}>
              <i style={{ width: `${clamp((t - c.a) / (c.b - c.a)) * 100}%` }} /><span>{c.label}</span>
            </div>
          ))}
        </div>
        <span className="film-time">{clock(t)} / {clock(END)}</span>
        <button className={'btn ghost sm icon-only' + (cc ? ' on' : '')} onClick={() => setCc((x) => !x)} aria-pressed={cc} aria-label="Captions" title="Captions"><span className="df-cc">CC</span></button>
        <button className="btn ghost sm icon-only" onClick={() => setMuted((m) => !m)} aria-pressed={muted} aria-label={muted ? 'Sound on' : 'Mute'} title={muted ? 'Sound on' : 'Mute'}><Speaker off={muted} /></button>
        <button className="btn ghost sm icon-only" onClick={fullscreen} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'}><Icon name={full ? 'shrink' : 'expand'} size={14} /></button>
      </div>
      {credit && <p className="df-credit">{credit}</p>}
    </div>
  );
}

function Speaker({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      {off ? <><path d="m23 9-6 6" /><path d="m17 9 6 6" /></> : <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>}
    </svg>
  );
}

/** the spoken line, as a caption */
function Caption({ t }: { t: number }) {
  const n = beatAt(t); if (!n) return null;
  const o = Math.min(prog(t, n.beat.at, 0.35), 1 - prog(t, n.end - 0.3, 0.3));
  return <div className="df-caption" key={n.beat.id} style={rise(o, 8)}>{n.beat.text}</div>;
}

// ================================================================ 01 · the problem (0 – 20)

function ActProblem({ t }: { t: number }) {
  const o = span(t, 0, 20.6, 0.6);
  if (o <= 0) return null;
  const apart = prog(t, 9.0, 1.2) * 34;
  const fly = prog(t, 19.6, 1.0);
  const tokens: [string, string][] = [['NEAR', '1,204.50'], ['USDC', '3,880.00'], ['REF', '12,300'], ['wNEAR', '640.20'], ['?', 'claim-airdrop.near']];
  return (
    <div className="df-act" style={vis(o)}>
      <div className="df-card df-wallet" style={{ ...pop(prog(t, 0.5, 0.8)), transform: `translateX(${185 * (1 - prog(t, 4.4, 1.0)) - apart - fly * 160}px) scale(${(0.86 + 0.14 * prog(t, 0.5, 0.8)) * (1 - 0.4 * fly)})` }}>
        <div className="df-card-hd"><Icon name="wallet" size={16} />Your wallet<span className="df-tag">private</span></div>
        {tokens.map(([k, v], i) => <div key={k} className={'df-tok' + (k === '?' ? ' odd' : '')} style={rise(prog(t, 1.0 + i * 0.25, 0.4), 6)}><b>{k}</b><span>{v}</span></div>)}
        <div className="df-stamp bad" style={pop(prog(t, 14.0, 0.35))}><Icon name="eye" size={15} />shown → exposed</div>
      </div>
      <div className="df-card df-method" style={{ ...pop(prog(t, 4.6, 0.8)), transform: `translateX(${apart + fly * 160}px) scale(${(0.86 + 0.14 * prog(t, 4.6, 0.8)) * (1 - 0.4 * fly)})` }}>
        <div className="df-card-hd"><Icon name="fileText" size={16} />An expert’s method<span className="df-tag">secret</span></div>
        {['Look up who holds the keys', 'Compare with known scams', 'Ask a private AI model', 'Score the risk'].map((s, i) => (
          <div key={s} className="df-step" style={rise(prog(t, 5.2 + i * 0.3, 0.4), 6)}><i>{i + 1}</i><span>{s}</span></div>
        ))}
        <div className="df-stamp bad" style={pop(prog(t, 16.4, 0.35))}><Icon name="fileSearch" size={15} />shown → copied</div>
      </div>
      <svg className="df-trust" width={W} height={H} style={{ opacity: span(t, 9.0, 13.4, 0.4) }}>
        <line x1={W / 2 - 70} x2={W / 2 + 70} y1={232} y2={232} stroke="#f2687c" strokeWidth="2" strokeDasharray="6 7" strokeDashoffset={-t * 18} />
        <circle cx={W / 2} cy={232} r={22 + 3 * Math.sin(t * 5)} fill="rgba(242,104,124,.12)" stroke="#f2687c" />
        <text x={W / 2} y={240} textAnchor="middle" fontSize="22" fontWeight="700" fill="#ffb3bf">?</text>
      </svg>
    </div>
  );
}

// ================================================================ 02 · the box (20 – 31)

function ActBox({ t }: { t: number }) {
  const o = span(t, 20.0, 31.6, 0.5);
  if (o <= 0) return null;
  const close = prog(t, 21.6, 0.9);
  const stamp = prog(t, 26.6, 0.35);
  const settle = prog(t, 26.95, 0.5);
  const nobody = ['not you', 'not them', 'not even us'];
  return (
    <div className="df-act" style={vis(o)}>
      <div className="df-box" style={pop(prog(t, 20.2, 0.7))}>
        <div className="df-box-in" style={{ opacity: 1 - close }}>
          <span className="df-mini"><Icon name="wallet" size={14} />your data</span>
          <span className="df-mini"><Icon name="fileText" size={14} />their method</span>
        </div>
        <div className="df-lid" style={{ transform: `scaleY(${close.toFixed(3)})` }}><div style={{ opacity: 1 - stamp, display: 'grid', justifyItems: 'center', gap: 8 }}><Icon name="lock" size={30} /><span>sealed hardware</span></div></div>
        <div className="df-glow" style={{ opacity: 0.25 + 0.35 * close + 0.25 * Math.sin(t * 2.2) * close }} />
      </div>
      {nobody.map((s, i) => (
        <div key={s} className={'df-nobody n' + i} style={rise(span(t, 22.8 + i * 0.8, 26.6, 0.4), 10)}><Icon name="eye" size={14} /><s>{s}</s></div>
      ))}
      <div className="df-wax" style={{ opacity: stamp, transform: `translate(-50%,-50%) scale(${(2.4 - 1.4 * stamp + 0.06 * Math.sin(settle * Math.PI)).toFixed(3)}) rotate(${(-14 * (1 - stamp)).toFixed(1)}deg)` }}><BrandMark size={128} /></div>
      <div className="df-brand" style={rise(prog(t, 27.4, 0.7), 12)}><b>Sealed Recipes</b><span>an expert’s method, run on your data, inside hardware nobody can open</span></div>
    </div>
  );
}

// ================================================================ 03 – 07 · the app, through the camera (31 – 106)

function Win({ at, w, h, url, children }: { at: { x: number; y: number }; w: number; h: number; url: string; children: ReactNode }) {
  return (
    <div className="df-win" style={{ left: at.x, top: at.y, width: w, height: h }}>
      <div className="df-bar"><i /><i /><i /><span className="df-url"><Icon name="lock" size={10} />app.sealedrecipes.xyz/{url}</span></div>
      <div className="df-page">{children}</div>
    </div>
  );
}
function AppTop({ active }: { active: string }) {
  return (
    <div className="df-top"><BrandMark size={20} /><b>Sealed Recipes</b>
      <nav>{['Recipes', 'Compose', 'Wallet', 'Docs'].map((n) => <span key={n} className={n === active ? 'on' : ''}>{n}</span>)}</nav>
      <em><i />Live · testnet</em>
    </div>
  );
}

function World({ t, cam, d }: { t: number; cam: { x: number; y: number; z: number }; d: FilmData }) {
  const o = span(t, 31.0, 106.4, 0.6);
  if (o <= 0) return null;
  return (
    <div className="df-world-clip" style={vis(o)}>
      <div className="df-world" style={{ transform: `translate(${(W / 2 - cam.x * cam.z).toFixed(2)}px, ${(H / 2 - cam.y * cam.z).toFixed(2)}px) scale(${cam.z.toFixed(4)})` }}>
        <ScreenRecipes t={t} d={d} />
        <ScreenQuote t={t} d={d} />
        <ScreenRunner t={t} />
        <ScreenResult t={t} d={d} />
      </div>
    </div>
  );
}

function ScreenRecipes({ t, d }: { t: number; d: FilmData }) {
  return (
    <Win at={WX.R} w={900} h={520} url="#/recipes">
      <AppTop active="Recipes" />
      <div className="df-h"><h4>Recipes</h4><span>Expert methods you can run. The method stays sealed.</span></div>
      {d.recipes.slice(0, 3).map((r, i) => (
        <div key={r.ticker} className={'df-row' + (i === 0 && t > 38.8 ? ' hot' : '')} style={{ top: 122 + i * 86 }}>
          <Seal ticker={r.ticker} kind={r.kind} size={44} />
          <div className="df-row-t"><b>{r.ticker}</b><span>{r.name}</span></div>
          <div className="df-chips"><span className="ok">{r.risk} risk</span><span>{r.runs} runs on-chain</span><span className="lockchip"><Icon name="lock" size={10} />method sealed</span></div>
          <div className="df-price">{usd(r.price)}<small>tUSDC / run</small></div>
        </div>
      ))}
      <div className="df-foot">Prices and track records come from the contract, live.</div>
    </Win>
  );
}

function ScreenQuote({ t, d }: { t: number; d: FilmData }) {
  const r = d.recipes[0];
  const sealed = prog(t, 48.4, 0.7);
  const checks = ['Intel TDX quote · verified in this browser', 'Runner keys match the contract', 'Code hash = the audited release', 'Image matches the pinned compose'];
  const quoted = prog(t, 59.0, 0.6);
  const paid = t >= 64.8;
  const coin = clamp((t - 64.6) / 0.9);
  return (
    <Win at={WX.Q} w={900} h={520} url={`#/quote/${r.ticker}`}>
      <AppTop active="Recipes" />
      <div className="df-h"><h4>{r.ticker}</h4><span>{r.name}</span></div>
      <div className="df-field" style={{ left: 36, top: 122 }}>
        <label>Contract you’re about to use</label>
        <div className={'df-input' + (sealed > 0.5 ? ' sealed' : '')}>
          <span className="df-plain" style={{ opacity: 1 - sealed }}>{typed('wrap.near', t, 44.6, 1.6)}{t > 44.4 && t < 48.2 && <i className="df-caret" />}</span>
          <span className="df-cipher" style={{ opacity: sealed }}><Icon name="lock" size={13} />{decode('9f3a7c21 e0b455d8 a91c4e0f', t, 48.4, 2.2)}…</span>
        </div>
        <div className="df-note" style={{ opacity: sealed }}><Icon name="lock" size={11} />sealed in this browser to the runner’s key</div>
      </div>
      <div className="df-checks" style={{ left: 36, top: 268 }}>
        <div className="hd"><Icon name="shieldCheck" size={14} />Runner verified</div>
        {checks.map((c, i) => <div key={c} className="ck" style={rise(prog(t, 54.2 + i * 0.55, 0.35), 6)}><Icon name="check" size={12} />{c}</div>)}
      </div>
      <div className="df-quote" style={{ left: 482, top: 112 }}>
        {quoted < 0.02 ? (
          <div className="wait"><span className="df-spin" />{t > 49 ? 'Dry run inside the sealed runner…' : 'Your quote appears here'}</div>
        ) : (
          <div style={rise(quoted, 10)}>
            <div className="hd"><Icon name="receipt" size={15} />Signed quote<span><Icon name="check" size={11} />signature verified</span></div>
            <div className="big">{usd(r.price)} <small>tUSDC, locked</small></div>
            {[['Valid for', '10 minutes · one use'], ['Signed by', 'tee.sealedrecipes.testnet'], ['Dry run says', 'wrap.near · medium risk']].map(([k, v], i) => (
              <div key={k} className="qrow" style={rise(prog(t, 59.4 + i * 0.25, 0.4), 6)}><span>{k}</span><b>{v}</b></div>
            ))}
          </div>
        )}
      </div>
      <div className={'df-pay' + (paid ? ' paid' : '')} style={{ left: 482, top: 380, opacity: prog(t, 59.8, 0.5) }}>
        {paid ? <><Icon name="vault" size={16} />Escrowed in the contract<small>{usd(r.price)} tUSDC</small></> : <><Icon name="wallet" size={16} />Pay {usd(r.price)} tUSDC</>}
        <i className="df-coin" style={{ opacity: t > 64.5 && t < 65.6 ? 1 : 0, transform: `translate(${(-40 + coin * 290).toFixed(1)}px, ${(-36 * Math.sin(coin * Math.PI)).toFixed(1)}px)` }} />
      </div>
      <div className="df-refund" style={rise(prog(t, 68.6, 0.5), 8)}><Icon name="refresh" size={13} />Refunded automatically if the run fails</div>
    </Win>
  );
}

function ScreenRunner({ t }: { t: number }) {
  const parts = [
    { id: 'near.contract-facts', who: 'builder · on-chain data', c: '#79a8ff' },
    { id: 'ai.contract-risk', who: 'builder · private AI', c: '#f0b44c' },
    { id: 'report.contract', who: 'builder · report', c: '#9aa6c2' },
  ];
  const svcs = ['NEAR RPC', 'FastNEAR', 'NEAR AI Cloud · TEE'];
  const hush = span(t, 84.4, 90.6, 0.5);
  return (
    <div className="df-tee" style={{ left: WX.X.x, top: WX.X.y, width: 900, height: 500 }}>
      <div className="df-tee-hd"><Icon name="cpu" size={16} />Runner · Intel TDX<span><Icon name="lock" size={11} />sealed hardware · tee.sealedrecipes.testnet</span></div>
      <div className="df-tee-checks">
        {['Recipe matches its on-chain hash', 'Your answers match what you paid for', 'Parts match the public list'].map((c, i) => <span key={c} style={rise(prog(t, 75.4 + i * 0.5, 0.4), 6)}><Icon name="check" size={11} />{c}</span>)}
      </div>
      <div className="df-parts" style={{ left: 50, top: 130 }}>
        {parts.map((p, i) => {
          const on = prog(t, 76.4 + i * 0.45, 0.45);
          const glow = 0.5 + 0.5 * Math.sin(t * 2.6 + i * 2.1);
          return (
            <div key={p.id} className="df-part" style={{ ...rise(on, 10), ['--cc' as never]: p.c, boxShadow: t > 78.4 ? `0 0 ${(8 + glow * 14).toFixed(1)}px rgba(240,180,76,${(0.1 + glow * 0.18).toFixed(2)})` : 'none' }}>
              <i /><b>{p.id}</b><span>{p.who}</span>
            </div>
          );
        })}
        <div className="df-order" style={{ opacity: prog(t, 79.6, 0.5) }}><Icon name="lock" size={11} />run order sealed</div>
      </div>
      <svg className="df-wires" width={900} height={500}>
        {svcs.map((_, i) => {
          const x1 = 200 + i * 250, x2 = 160 + i * 290, p = clamp((t - 80.2 - i * 0.5) / 0.8);
          return <path key={i} d={`M${x1} 326 C ${x1} 360, ${x2} 360, ${x2} 392`} stroke="#3a4766" strokeWidth="1.5" fill="none" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} />;
        })}
      </svg>
      <div className="df-svcs">
        {svcs.map((s, i) => <span key={s} style={rise(prog(t, 80.4 + i * 0.5, 0.4), 6)}><i className="ping" style={{ animationDelay: `${i * 0.45}s` }} />{s}</span>)}
        <span className="deny" style={rise(prog(t, 82.4, 0.4), 6)}><Icon name="x" size={11} />anything else: blocked</span>
      </div>
      <div className="df-hush" style={vis(hush)}>
        <svg width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /><path d="M3 3l18 18" style={{ strokeDasharray: 26, strokeDashoffset: 26 * (1 - prog(t, 84.8, 0.6)) }} /></svg>
        <b>No logs. No observers.</b><span>not the marketplace · not the creator · not the operator</span>
      </div>
    </div>
  );
}

function ScreenResult({ t, d }: { t: number; d: FilmData }) {
  const s = d.split;
  const segs = [
    { who: 'Part builders', sub: '3 parts, paid per run', v: s.parts, c: '#79a8ff' },
    { who: 'Runner', sub: 'sealed hardware', v: s.runner, c: '#a98bff' },
    { who: 'Protocol', sub: '2%', v: s.protocol, c: '#56658a' },
    { who: 'Creator', sub: 'the method’s author', v: s.creator, c: '#ffd58a' },
    ...(s.reserve > 0 ? [{ who: 'Guarantee deposit', sub: 'backs future promises', v: s.reserve, c: '#3ccb9a' }] : []),
  ];
  const total = segs.reduce((a, b) => a + b.v, 0) || 1;
  const grow = clamp((t - 97.0) / 1.8);
  let acc = 0;
  const lines = ['Source code: verified (NEP-330)', '2 full-access keys can replace the code', 'Widely used token contract'];
  return (
    <Win at={WX.S} w={900} h={500} url={`#/quote/${d.recipes[0].ticker}`}>
      <AppTop active="Recipes" />
      <div className="df-h"><h4>Run complete</h4><span>Settled on NEAR testnet</span></div>
      <div className="df-result" style={{ left: 40, top: 130 }}>
        <div className="hd"><Icon name={t > 90.6 ? 'unlock' : 'lock'} size={14} />{t > 90.6 ? 'Opened with your browser’s key' : 'Sealed to your browser'}</div>
        <h5>{decode('wrap.near · medium risk', t, 90.8, 1.4)}</h5>
        {lines.map((l, i) => <div key={l} className="rl" style={{ opacity: 0.35 + 0.65 * prog(t, 91.8 + i * 0.35, 0.4) }}>{decode(l, t, 91.6 + i * 0.35, 1.0)}</div>)}
      </div>
      <div className="df-split" style={{ left: 482, top: 140 }}>
        <div className="hd">{usd(s.price)} tUSDC · one receipt</div>
        <div className="bar">{segs.map((g, i) => { const st = acc / total; acc += g.v; const w = clamp((grow - st) / (g.v / total)) * (g.v / total) * 100; return <i key={i} style={{ width: `${w}%`, background: g.c }} />; })}</div>
        {segs.map((g, i) => <div key={g.who} className="lg" style={rise(prog(t, 97.6 + i * 0.25, 0.4), 6)}><i style={{ background: g.c }} /><b>{g.who}</b><span>{g.sub}</span><em>{(g.v * clamp((t - 97.6 - i * 0.25) / 0.8)).toFixed(4)}</em></div>)}
      </div>
      <div className="df-settled" style={rise(prog(t, 101.8, 0.5), 8)}><Icon name="check" size={13} />Settled on-chain · every payout in one transaction</div>
    </Win>
  );
}

/** dims everything but one region of the world, with a short label beside it */
function Spotlight({ t, cam }: { t: number; cam: { x: number; y: number; z: number } }) {
  const s = SPOTS.find((x) => t >= x.a - 0.1 && t < x.b + 0.4); if (!s) return null;
  const o = span(t, s.a, s.b, 0.4);
  if (o <= 0) return null;
  const pad = 8;
  const p0 = toStage(cam, s.x - pad, s.y - pad), p1 = toStage(cam, s.x + s.w + pad, s.y + s.h + pad);
  const x = p0.x, y = p0.y, w = p1.x - p0.x, h = p1.y - p0.y;
  const below = (s.side ?? 'below') === 'below';
  const lx = Math.max(150, Math.min(W - 150, x + w / 2));
  const ly = below ? Math.min(H - 110, y + h + 14) : Math.max(56, y - 14);
  return (
    <div className="df-spot" style={{ opacity: o }}>
      <svg width={W} height={H}>
        <defs><mask id="df-hole"><rect width={W} height={H} fill="white" /><rect x={x} y={y} width={w} height={h} rx={14} fill="black" /></mask></defs>
        <rect width={W} height={H} fill="rgba(4,8,16,.62)" mask="url(#df-hole)" />
        <rect x={x} y={y} width={w} height={h} rx={14} fill="none" stroke="#f0b44c" strokeWidth="2" opacity={0.85} />
      </svg>
      <div className={'df-label' + (below ? ' below' : ' above')} style={{ left: lx, top: ly, ...rise(prog(t, s.a + 0.25, 0.4), below ? -6 : 6) }}><i />{s.label}</div>
    </div>
  );
}

// ================================================================ 08 · proof (106 – 117)

function ActProof({ t }: { t: number }) {
  const o = span(t, 106.0, 117.4, 0.5);
  if (o <= 0) return null;
  const dark = prog(t, 112.0, 0.8);
  const cards = [
    { icon: 'cpu', h: 'The hardware', p: 'Intel TDX quote, checked against Intel’s keys in your own browser' },
    { icon: 'code', h: 'The code', p: 'The runner proves it runs the audited release, hash on-chain' },
    { icon: 'link', h: 'The money', p: 'Every payment and payout is a real transaction you can look up' },
  ];
  return (
    <div className="df-act" style={vis(o)}>
      <div className="df-proof" style={{ opacity: 1 - 0.85 * dark, transform: `scale(${(1 - 0.06 * dark).toFixed(3)})` }}>
        {cards.map((c, i) => (
          <div key={c.h} className="df-pcard" style={rise(prog(t, 106.6 + i * 0.6, 0.5), 16)}>
            <span className="ic"><Icon name={c.icon} size={20} /></span>
            <b>{c.h}</b><p>{c.p}</p>
            <em style={pop(prog(t, 107.6 + i * 0.6, 0.35))}><Icon name="check" size={13} />verified</em>
          </div>
        ))}
      </div>
      <div className="df-drop" style={{ opacity: dark }} />
    </div>
  );
}

// ================================================================ 09 · agents (117 – 148)

function ActAgents({ t, d }: { t: number; d: FilmData }) {
  const o = span(t, 117.0, 148.4, 0.5);
  if (o <= 0) return null;
  const title = span(t, 117.2, 121.2, 0.4);
  const main = prog(t, 120.8, 0.6);
  const kb = 1 + 0.05 * clamp((t - 121) / 27);
  const [a, b, c] = d.recipes;
  const lines: { at: number; s: string; k?: 'cmd' | 'ok' | 'pick' | 'dim' }[] = [
    { at: 121.6, s: '$ npm run agent -- --live --wallet v2.ref-finance.near', k: 'cmd' },
    { at: 123.0, s: 'marketplace app.sealedrecipes.xyz (live, NEAR testnet)', k: 'dim' },
    { at: 124.0, s: 'runner attestation verified: 7 checks (Intel TDX)', k: 'ok' },
    { at: 125.2, s: 'inputs sealed in this process → runner key 41c8…7770', k: 'dim' },
    { at: 128.8, s: `quote ${a.ticker.padEnd(6)} ${usd(a.price)} tUSDC  signature ✔` },
    { at: 129.6, s: `quote ${b.ticker.padEnd(6)} ${usd(b.price)} tUSDC  signature ✔` },
    { at: 130.4, s: `quote ${c.ticker.padEnd(6)} ${usd(c.price)} tUSDC  signature ✔` },
    { at: 132.2, s: `policy (cheapest, risk ≤ low) picks ${a.ticker}`, k: 'pick' },
    { at: 135.8, s: `paid ${usd(a.price)} tUSDC · ft_transfer_call`, k: 'dim' },
    { at: 137.2, s: '✔ runner signature matches its on-chain key', k: 'ok' },
    { at: 138.0, s: '✔ output hash matches the sealed result', k: 'ok' },
    { at: 138.8, s: '✔ settled on-chain · 4 payees', k: 'ok' },
  ];
  const nos = ['No account manager', 'No API key', 'No trust needed'];
  return (
    <div className="df-act" style={vis(o)}>
      <div className="df-agent-title" style={{ ...vis(title), transform: `scale(${(1.08 - 0.08 * prog(t, 117.2, 1.2)).toFixed(3)})` }}>
        <span className="ic"><Icon name="cpu" size={30} /></span><b>For AI agents</b><span>The same marketplace, no human in the loop</span>
      </div>
      <div className="df-agents" style={{ opacity: main, transform: `scale(${kb.toFixed(4)})` }}>
        <div className="df-term">
          <div className="df-term-bar"><i /><i /><i /><span>agent · scripts/agent-buyer.ts</span></div>
          <div className="df-term-body">
            {lines.filter((l) => t >= l.at).map((l) => <div key={l.at} className={'df-tl ' + (l.k ?? '')}>{l.k === 'cmd' ? typed(l.s, t, l.at, 1.2) : l.s}{l.k === 'cmd' && t < l.at + 1.4 && <i className="df-caret" />}</div>)}
            {t > 125.4 && t < 128.8 && <div className="df-tl dim"><span className="df-spin" />asking 3 recipes for signed quotes…</div>}
          </div>
        </div>
        <div className="df-side">
          <div className="df-table" style={rise(prog(t, 128.6, 0.5), 12)}>
            <div className="hd"><span>Recipe</span><span>Price</span><span>Risk</span><span>Quote</span></div>
            {[a, b, c].map((r, i) => (
              <div key={r.ticker} className={'tr' + (i === 0 && t >= 132.2 ? ' pick' : '')} style={rise(prog(t, 128.8 + i * 0.8, 0.4), 6)}>
                <span><Seal ticker={r.ticker} kind={r.kind} size={20} /><b>{r.ticker}</b></span><span>{usd(r.price)}</span><span>{r.risk}</span><span className="ok"><Icon name="check" size={11} />signed</span>
              </div>
            ))}
            <div className="pol" style={{ opacity: prog(t, 131.8, 0.4) }}>policy: <code>{'{ sort: "price", maxRisk: "low" }'}</code></div>
          </div>
          <div className="df-verify" style={rise(prog(t, 137.0, 0.5), 12)}>
            {['Signature = the runner’s on-chain key', 'Output hash = the sealed result', 'Settlement found on-chain'].map((v, i) => <div key={v} style={rise(prog(t, 137.2 + i * 0.8, 0.35), 6)}><Icon name="check" size={12} />{v}</div>)}
          </div>
        </div>
      </div>
      <div className="df-nos">{nos.map((n, i) => <span key={n} style={pop(span(t, 142.8 + i * 0.7, 148.2, 0.35))}><Icon name="x" size={13} />{n}</span>)}</div>
    </div>
  );
}

// ================================================================ 10 · your turn (148 – 157)

function ActEnd({ t }: { t: number }) {
  const o = prog(t, 148.0, 0.7);
  if (o <= 0) return null;
  const lines = ['Your data stays yours.', 'Their method stays theirs.', 'Everyone gets paid.'];
  return (
    <div className="df-act df-end" style={vis(o)}>
      <div className="df-end-mark" style={pop(prog(t, 148.2, 0.7))}><BrandMark size={74} /></div>
      {lines.map((l, i) => <div key={l} className="df-end-line" style={rise(prog(t, 148.6 + i * 1.3, 0.6), 12)}>{l}</div>)}
      <div className="df-end-try" style={rise(prog(t, 153.8, 0.6), 10)}>Try a recipe, live on NEAR testnet<span>app.sealedrecipes.xyz</span></div>
    </div>
  );
}
