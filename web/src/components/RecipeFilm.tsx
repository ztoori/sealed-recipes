/**
 * A recipe film: a short, code-rendered motion piece that shows how a buyer uses one recipe, every part of the stack
 * it touches in the order it touches them, and who is paid. It is drawn from the recipe's public listing and the
 * part catalog (plus a short story in film-scripts.ts), so it is a few kilobytes, sharp at any size, and can never
 * reveal more than a buyer already sees. The run order of the parts stays sealed, on screen as on-chain.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Catalog, PartManifest } from '../../../core/src/srs';
import { ASSET_LABEL, money, currencyName } from '../api';
import { Icon } from '../icons';
import { Seal } from '../ui';
import { FILM_SCRIPTS, exampleInput, type FilmScript } from './film-scripts';
import { SpeedControl } from './SpeedControl';
import { useSpeed } from '../pace';

const W = 960, H = 540;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
/** 0 → 1 over d seconds from a */
const prog = (t: number, a: number, d = 0.6) => ease((t - a) / d);
/** visible from a to b, fading at both ends */
const span = (t: number, a: number, b: number, f = 0.45) => Math.min(prog(t, a, f), 1 - prog(t, b - f, f));
const rise = (o: number, px = 14): CSSProperties => ({ opacity: o, transform: `translateY(${((1 - o) * px).toFixed(2)}px)` });
const dollars = (n: number, dp = 2) => money(n, dp);

const CHAPTERS = [
  { id: 'story', label: 'Story', a: 0, b: 4.6 },
  { id: 'ask', label: 'Ask', a: 4.6, b: 9.8 },
  { id: 'quote', label: 'Quote', a: 9.8, b: 15.2 },
  { id: 'pay', label: 'Pay', a: 15.2, b: 19.8 },
  { id: 'run', label: 'Run', a: 19.8, b: 29.8 },
  { id: 'result', label: 'Result', a: 29.8, b: 33.8 },
  { id: 'settle', label: 'Settle', a: 33.8, b: 39.6 },
  { id: 'why', label: 'Why', a: 39.6, b: 47 },
] as const;
const END = 47;
/** film seconds per real second at 1×: a calm pace, about 72 seconds a film */
const PACE = 0.65;
const clock = (x: number) => { const s = Math.round(x / PACE); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

type NodeId = 'browser' | 'wallet' | 'intents' | 'contract' | 'market' | 'runner' | 'services';
const RAIL: { id: NodeId; label: string; sub: string; icon: string }[] = [
  { id: 'browser', label: 'Your browser', sub: 'asks · seals · opens', icon: 'user' },
  { id: 'wallet', label: 'Your wallet', sub: 'pays · approves', icon: 'wallet' },
  { id: 'intents', label: 'NEAR Intents', sub: 'pay from any chain', icon: 'zap' },
  { id: 'contract', label: 'Contract', sub: 'escrows · settles', icon: 'vault' },
  { id: 'market', label: 'Marketplace', sub: 'relays ciphertext', icon: 'market' },
  { id: 'runner', label: 'Runner · TEE', sub: 'quotes · runs', icon: 'cpu' },
  { id: 'services', label: 'Services', sub: 'declared hosts only', icon: 'globe' },
];
const RAIL_Y = 462;
const nodeX = (id: NodeId) => 78 + RAIL.findIndex((n) => n.id === id) * 134;

interface Hop { at: number; from: NodeId; to: NodeId; text: string; n: number }

/** the services a recipe can reach, named for people, from its declared capabilities */
const SERVICE_NAMES: Record<string, string> = {
  'api.fastnear.com': 'FastNEAR', 'rpc.mainnet.fastnear.com': 'FastNEAR', '1click.chaindefuser.com': '1Click',
  'solver-relay-v2.chaindefuser.com': 'Intents solver relay', 'cloud-api.near.ai': 'NEAR AI Cloud · TEE', 'nras.attestation.nvidia.com': 'NVIDIA attestation',
};

function buildHops(approves: boolean): Hop[] {
  const raw: Omit<Hop, 'n'>[] = [
    { at: 6.0, from: 'browser', to: 'browser', text: 'Your browser seals your answers' },
    { at: 10.0, from: 'browser', to: 'market', text: 'The marketplace relays ciphertext it can’t read' },
    { at: 11.2, from: 'market', to: 'runner', text: 'The runner dry-runs the recipe, read-only' },
    { at: 13.2, from: 'runner', to: 'browser', text: 'A signed quote comes back, sealed to you' },
    { at: 15.6, from: 'browser', to: 'wallet', text: 'You pay from your wallet, on any chain' },
    { at: 16.6, from: 'wallet', to: 'intents', text: 'NEAR Intents delivers the exact price' },
    { at: 17.8, from: 'intents', to: 'contract', text: 'The contract holds it in escrow' },
    { at: 20.2, from: 'contract', to: 'runner', text: 'The runner checks the chain, then decrypts' },
    { at: 23.0, from: 'runner', to: 'services', text: 'Each part reaches only its declared services' },
    ...(approves ? [{ at: 25.8, from: 'runner' as NodeId, to: 'wallet' as NodeId, text: 'You approve the transfers, and nothing else' }] : []),
    { at: 30.0, from: 'runner', to: 'browser', text: 'The result is sealed to your browser' },
    { at: 34.0, from: 'runner', to: 'contract', text: 'One signed report settles the run' },
  ];
  return raw.map((h, i) => ({ ...h, n: i + 1 }));
}

/** a hop's arc above the rail: longer hops arc higher, return hops higher still, so numbers never collide */
function arc(h: Hop) {
  const x1 = nodeX(h.from), x2 = nodeX(h.to), dx = Math.abs(x2 - x1);
  const lift = Math.min(x2 > x1 ? 150 : 172, (x2 > x1 ? 22 : 38) + dx * (x2 > x1 ? 0.17 : 0.22));
  const cx = (x1 + x2) / 2, cy = RAIL_Y - 22 - lift;
  const at = (p: number) => ({ x: (1 - p) ** 2 * x1 + 2 * (1 - p) * p * cx + p * p * x2, y: (1 - p) ** 2 * (RAIL_Y - 22) + 2 * (1 - p) * p * cy + p * p * (RAIL_Y - 22) });
  return { d: `M${x1} ${RAIL_Y - 22}Q${cx} ${cy} ${x2} ${RAIL_Y - 22}`, at };
}

export interface FilmListing {
  ticker: string; name: string; creator: string; description: string; form: { id: string; label: string; type: string; placeholder?: string; default?: unknown; generator?: string }[];
  parts: string[]; capabilities: string[]; output_type: string; risk: string; privacy: string; settle_mode?: string;
  record: { pricePerRun: number; deposit: { available: number }; perRun: { price: number; protocol: number; runner: number; parts: { part: string; amount: number }[]; creator: number; reserve: number } };
}

export function RecipeFilm({ listing: l, catalog, onQuote }: { listing: FilmListing; catalog: Catalog; onQuote: () => void }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(1);
  const frame = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [speed] = useSpeed('film');
  const speedRef = useRef(speed); speedRef.current = speed;
  const [full, setFull] = useState(false);
  useEffect(() => { const on = () => setFull(document.fullscreenElement === root.current); document.addEventListener('fullscreenchange', on); return () => document.removeEventListener('fullscreenchange', on); }, []);
  // full screen; on a phone, also turn to landscape where the browser allows it
  const fullscreen = () => {
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    void root.current?.requestFullscreen?.().then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {})).catch(() => {});
  };
  const seen = useRef(false);
  const reduce = useMemo(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  // a new recipe starts its film from the top
  useEffect(() => { setT(0); setPlaying(seen.current && !reduce); }, [l.ticker]);
  // fit the 960×540 stage to the panel
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / W)); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // start when it scrolls into view; pause when it leaves or the tab hides
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !seen.current) { seen.current = true; if (!reduce) setPlaying(true); } if (!e.isIntersecting) setPlaying(false); }, { threshold: 0.5 });
    io.observe(el);
    const vis = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', vis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  }, []);
  // the clock
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (Math.min(0.1, (now - last) / 1000)) * PACE * speedRef.current; last = now;
      setT((x) => { const n = x + dt; if (n >= END) { setPlaying(false); return END; } return n; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const parts = useMemo(() => l.parts.map((id) => catalog.parts.find((p) => p.id === id)).filter(Boolean) as PartManifest[], [l, catalog]);
  const approves = l.capabilities.includes('wallet:approve');
  const hops = useMemo(() => buildHops(approves), [approves]);
  const services = useMemo(() => [...new Set(l.capabilities.filter((c) => c.startsWith('net:')).map((c) => SERVICE_NAMES[c.slice(4)] ?? c.slice(4)))], [l]);
  const s: FilmScript = FILM_SCRIPTS[l.ticker] ?? { situation: l.description, result: { title: l.output_type === 'swap.receipts' ? 'Funds delivered to your recipient' : 'A report, sealed to you', lines: [] }, buyerWin: l.description };
  const measured = l.output_type === 'swap.receipts' && !!s.quote;
  const builders = new Set(parts.map((p) => p.author)).size;
  const live = [...hops].reverse().find((h) => t >= h.at);
  const toggle = () => { if (t >= END) setT(0); setPlaying((p) => !p); };
  // on a small screen the stage's own text gets too small to read, so the words also run underneath it, full size
  const small = scale < 0.62;
  const chapter = CHAPTERS.find((c) => t >= c.a && t < c.b) ?? CHAPTERS[CHAPTERS.length - 1];
  const [subHead, subText] = COPY[chapter.id]({ l, s, n: l.parts.length, b: builders, measured });

  return (
    <div className={'film' + (full ? ' full' : '')} ref={root}>
      <div className="film-frame" ref={frame} role="region" aria-label={`Film: how ${l.name} works, step by step`} style={{ aspectRatio: `${W} / ${H}` }} onClick={(e) => { if ((e.target as HTMLElement).closest('button')) return; toggle(); }}>
        <div className="film-stage" style={{ width: W, height: H, transform: `scale(${scale})` }} aria-hidden={false}>
          <Backdrop t={t} />
          <LeftColumn t={t} l={l} s={s} builders={builders} live={live} total={hops.length} />
          <div className="film-right">
            <TitleScene t={t} l={l} parts={parts} />
            <AskScene t={t} l={l} s={s} />
            <QuoteScene t={t} l={l} s={s} measured={measured} />
            <PayScene t={t} l={l} measured={measured} />
            <RunScene t={t} parts={parts} services={services} approves={approves} />
            <ResultScene t={t} s={s} />
            <SettleScene t={t} l={l} parts={parts} />
            <WhyScene t={t} l={l} s={s} builders={builders} parts={parts.length} measured={measured} onQuote={onQuote} />
          </div>
          <Rail t={t} hops={hops} approves={approves} />
        </div>
        {!playing && (t < 0.05 || t >= END) && <button className="film-bigplay" aria-label={t >= END ? 'Replay' : 'Play'} onClick={toggle}><Icon name={t >= END ? 'refresh' : 'play'} size={26} /></button>}
      </div>
      {small && (
        <div className="film-subs" aria-live="polite">
          <div className="film-kicker">{String(CHAPTERS.indexOf(chapter) + 1).padStart(2, '0')} · {chapter.label}</div>
          <b>{subHead}</b><p>{subText}</p>
          {live && <div className="film-step"><b>{live.n}</b><span>of {hops.length}</span>{live.text}</div>}
        </div>
      )}
      <div className="film-controls">
        <button className="btn ghost sm icon-only" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'stop' : t >= END ? 'refresh' : 'play'} size={14} /></button>
        <div className="film-track" role="slider" aria-label="Position in the film" aria-valuemin={0} aria-valuemax={END} aria-valuenow={Math.round(t)} tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') setT((x) => Math.min(END, x + 3)); if (e.key === 'ArrowLeft') setT((x) => Math.max(0, x - 3)); if (e.key === ' ') { e.preventDefault(); toggle(); } }}
          onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); const seek = (x: number) => setT(clamp((x - r.left) / r.width) * END); seek(e.clientX); const mv = (ev: PointerEvent) => seek(ev.clientX); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); }}>
          {CHAPTERS.map((c) => (
            <div key={c.id} className={'film-seg' + (t >= c.b ? ' done' : t >= c.a ? ' on' : '')} style={{ flexGrow: c.b - c.a }}>
              <i style={{ width: `${clamp((t - c.a) / (c.b - c.a)) * 100}%` }} />
              <span>{c.label}</span>
            </div>
          ))}
        </div>
        <span className="film-time">{clock(t)} / {clock(END)}</span>
        <SpeedControl kind="film" />
        <button className="btn ghost sm icon-only" onClick={fullscreen} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'}><Icon name={full ? 'shrink' : 'expand'} size={14} /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- frame

function Backdrop({ t }: { t: number }) {
  const hue = [214, 38, 260, 160, 38, 214, 150, 38][CHAPTERS.findIndex((c) => t >= c.a && t < c.b) === -1 ? 7 : CHAPTERS.findIndex((c) => t >= c.a && t < c.b)];
  return <div className="film-bg" style={{ ['--h' as never]: hue }} />;
}

const COPY: Record<string, (x: { l: FilmListing; s: FilmScript; n: number; b: number; measured: boolean }) => [string, string]> = {
  story: ({ l, s }) => [l.name, s.situation],
  ask: () => ['Ask in plain words', 'One short form. The answers are sealed in your browser before they leave it.'],
  quote: ({ measured }) => ['A signed quote, before you pay', measured ? 'The runner dry-runs the recipe on your sealed answers. Nothing moves, and the promise is backed by a deposit.' : 'The runner dry-runs the recipe on your sealed answers. Nothing moves, and you see the price first.'],
  pay: () => ['Pay from any chain', 'NEAR Intents delivers the exact price. The contract holds it until the run reports.'],
  run: ({ n, b }) => ['The sealed recipe runs', `${n} parts from ${b} builder${b > 1 ? 's' : ''}, inside sealed hardware. Which part runs when stays sealed, even here.`],
  result: () => ['Only you can open the result', 'Logs and the result are encrypted to a key your browser made for this run.'],
  settle: ({ b }) => ['Everyone paid in one receipt', `The price splits between ${b > 1 ? `${b} builders` : 'the builder'}, the runner, the protocol and the creator, in a single transaction.`],
  why: () => ['Why everyone shows up', 'Buyers get a guarantee. Creators sell a method without giving it away. Builders are paid every time.'],
};

function LeftColumn({ t, l, s, builders: b, live, total }: { t: number; l: FilmListing; s: FilmScript; builders: number; live?: Hop; total: number }) {
  const n = l.parts.length;
  const measured = l.output_type === 'swap.receipts' && !!s.quote;
  return (
    <div className="film-left">
      {CHAPTERS.map((c, i) => {
        const o = span(t, c.a + (i ? 0.1 : 0), c.b, 0.4);
        if (o <= 0.001 && !(i === CHAPTERS.length - 1 && t >= c.a)) return null;
        const [h, sub] = COPY[c.id]({ l, s, n, b, measured });
        return (
          <div key={c.id} className="film-copy" style={{ opacity: i === CHAPTERS.length - 1 ? prog(t, c.a, 0.4) : o }}>
            <div className="film-kicker" style={rise(prog(t, c.a, 0.5), 8)}>{String(i + 1).padStart(2, '0')} · {c.label}{i === 0 ? <span className="film-example">example run</span> : null}</div>
            <h3 style={rise(prog(t, c.a + 0.12, 0.6), 12)}>{h}</h3>
            <p style={rise(prog(t, c.a + 0.3, 0.6), 10)}>{sub}</p>
          </div>
        );
      })}
      {live && <div className="film-step" key={live.n} style={rise(prog(t, live.at, 0.4), 6)}><b>{live.n}</b><span>of {total}</span>{live.text}</div>}
    </div>
  );
}

function Rail({ t, hops, approves }: { t: number; hops: Hop[]; approves: boolean }) {
  const touched = new Set<NodeId>(hops.filter((h) => t >= h.at + 0.8).flatMap((h) => [h.from, h.to]));
  const cur = [...hops].reverse().find((h) => t >= h.at && t < h.at + 1.6);
  return (
    <svg className="film-rail" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <radialGradient id="pk"><stop offset="0" stopColor="#ffe3a8" /><stop offset="0.5" stopColor="#f0b44c" /><stop offset="1" stopColor="#f0b44c" stopOpacity="0" /></radialGradient>
      </defs>
      <line x1={nodeX('browser')} x2={nodeX('services')} y1={RAIL_Y} y2={RAIL_Y} stroke="#212d47" strokeWidth={2} />
      {hops.filter((h) => h.from !== h.to && t >= h.at).map((h) => {
        const a = arc(h), p = prog(t, h.at, 0.85), done = t >= h.at + 0.85, apex = a.at(0.5), pt = a.at(p);
        return (
          <g key={h.n}>
            <path d={a.d} fill="none" stroke={done ? '#2f3b57' : '#f0b44c'} strokeWidth={done ? 1.2 : 2} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} />
            {!done && <circle cx={pt.x} cy={pt.y} r={9} fill="url(#pk)" />}
            {done && <g opacity={prog(t, h.at + 0.85, 0.4)}><circle cx={apex.x} cy={apex.y} r={9} fill="#172238" stroke={cur?.n === h.n ? '#f0b44c' : '#3a4766'} /><text x={apex.x} y={apex.y + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill={cur?.n === h.n ? '#ffd58a' : '#8592ae'}>{h.n}</text></g>}
          </g>
        );
      })}
      {RAIL.map((nd) => {
        const x = nodeX(nd.id);
        const active = cur && (cur.to === nd.id || (cur.from === nd.id && cur.from === cur.to));
        const on = touched.has(nd.id) || active;
        const dim = nd.id === 'wallet' && !approves && t < 15.6;
        return (
          <g key={nd.id} opacity={dim ? 0.55 : 1}>
            {active && <circle cx={x} cy={RAIL_Y} r={30 + 6 * Math.sin(t * 6)} fill="#f0b44c" opacity={0.12} />}
            <circle cx={x} cy={RAIL_Y} r={20} fill={active ? '#2a2312' : '#111a2c'} stroke={active ? '#f0b44c' : on ? '#56658a' : '#2c3a5a'} strokeWidth={1.6} />
            <foreignObject x={x - 9} y={RAIL_Y - 9} width={18} height={18}><div style={{ color: active ? '#f0b44c' : on ? '#bcc5da' : '#56658a', display: 'flex' }}><Icon name={nd.icon} size={18} /></div></foreignObject>
            <text x={x} y={RAIL_Y + 38} textAnchor="middle" fontSize="12" fontWeight="650" fill={active ? '#ffd58a' : on ? '#e9edf6' : '#8592ae'}>{nd.label}</text>
            <text x={x} y={RAIL_Y + 53} textAnchor="middle" fontSize="10.5" fill="#56658a">{nd.sub}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- scenes (each fills the right-hand panel, 520 × 300)

const scene = (t: number, a: number, b: number, last = false): CSSProperties => {
  const o = last ? prog(t, a, 0.45) : span(t, a, b);
  return { opacity: o, visibility: o < 0.01 ? 'hidden' : 'visible', pointerEvents: o > 0.5 ? 'auto' : 'none' };
};

function TitleScene({ t, l, parts }: { t: number; l: FilmListing; parts: PartManifest[] }) {
  const k = prog(t, 0.1, 1.1);
  const privacy = l.privacy === 'confidential' ? 'confidential swaps' : l.privacy === 'public' ? 'public swap route' : 'no funds move';
  return (
    <div className="scene title" style={scene(t, 0, 4.6)}>
      <div className="seal-wrap" style={{ transform: `scale(${0.7 + 0.3 * k}) rotate(${(1 - k) * -18}deg)`, opacity: k }}><Seal ticker={l.ticker} kind={l.output_type} size={150} /></div>
      <div className="tk" style={rise(prog(t, 0.7, 0.6))}>{l.ticker}<span>by {l.creator}</span></div>
      <div className="chips" style={rise(prog(t, 1.1, 0.6))}>
        <span>{dollars(l.record.pricePerRun)} a run</span><span>{l.risk} withdrawal risk</span><span>{privacy}</span><span>{parts.length} parts</span>
      </div>
    </div>
  );
}

function AskScene({ t, l, s }: { t: number; l: FilmListing; s: FilmScript }) {
  const fields = l.form.slice(0, 4);
  const sealed = prog(t, 8.5, 0.6);
  return (
    <div className="scene ask" style={scene(t, 4.6, 9.8)}>
      <div className="fcard" style={{ transform: `scale(${1 - 0.05 * sealed})`, ...rise(prog(t, 4.8, 0.6)) }}>
        <div className="fhd"><Icon name="user" size={14} />Your answers<span>{l.ticker}</span></div>
        {fields.map((f, i) => {
          const raw = s.inputs?.[f.id] ?? exampleInput(f);
          const shown = raw === 'fresh' ? 'a3f9…71c2 (brand new)' : f.type === 'asset.id' ? (ASSET_LABEL[raw] ?? raw) : raw;
          const typed = shown.slice(0, Math.round(shown.length * clamp((t - (5.3 + i * 0.75)) / 0.7)));
          return (
            <div key={f.id} className="frow" style={rise(prog(t, 5.0 + i * 0.5, 0.5), 6)}>
              <span>{f.label}</span><b>{typed}<i className={t > 5.3 + i * 0.75 && t < 6.1 + i * 0.75 ? 'caret' : ''} /></b>
            </div>
          );
        })}
        <div className="fseal" style={{ opacity: sealed }}><Icon name="lock" size={16} />Sealed to the runner<span>X25519 · XSalsa20-Poly1305</span></div>
      </div>
    </div>
  );
}

function QuoteScene({ t, l, s, measured }: { t: number; l: FilmListing; s: FilmScript; measured: boolean }) {
  const dry = span(t, 10.2, 12.9, 0.35);
  const card = prog(t, 12.8, 0.6);
  const cover = s.quote ? Math.min(s.quote.promised, l.record.deposit.available) : 0;
  const rows: [string, string][] = measured && s.quote
    ? [['Price', dollars(l.record.pricePerRun)], ['You should receive', '≈ ' + dollars(s.quote.expected)], ['Promised, at least', dollars(s.quote.promised)], ['Guaranteed by the deposit', dollars(cover)]]
    : [['Price', dollars(l.record.pricePerRun)], ['Promise', 'none needed: a report moves no funds']];
  return (
    <div className="scene quote" style={scene(t, 9.8, 15.2)}>
      <div className="dry" style={{ opacity: dry }}>
        <Icon name="cpu" size={22} /><b>Dry run inside the runner</b><span>read-only · live prices · no approvals</span>
        <div className="bar"><i style={{ width: `${clamp((t - 10.4) / 2.2) * 100}%` }} /></div>
      </div>
      <div className="qcard" style={rise(card, 18)}>
        <div className="qhd"><Icon name="receipt" size={16} />Signed quote<span className="ok"><Icon name="check" size={12} />signature verified in your browser</span></div>
        {rows.map(([k, v], i) => <div key={k} className={'qrow' + (i === rows.length - 1 && measured ? ' strong' : '')} style={rise(prog(t, 13.1 + i * 0.25, 0.4), 6)}><span>{k}</span><b>{v}</b></div>)}
        <div className="qft">valid for 2 minutes · one use · bound to your sealed answers</div>
      </div>
    </div>
  );
}

function PayScene({ t, l, measured }: { t: number; l: FilmListing; measured: boolean }) {
  const boxes = [
    { icon: 'wallet', h: 'Your wallet', p: currencyName() === 'tUSDC' ? 'tUSDC on NEAR testnet' : 'USDC from any chain', at: 15.6 },
    { icon: 'zap', h: 'NEAR Intents', p: 'delivers the exact price', at: 16.6 },
    { icon: 'vault', h: 'Contract', p: measured ? 'run escrowed · cover locked' : 'run escrowed', at: 17.8 },
  ];
  const coin = clamp((t - 15.7) / 2.2);
  return (
    <div className="scene pay" style={scene(t, 15.2, 19.8)}>
      <div className="amount" style={rise(prog(t, 15.3, 0.5))}>{dollars(l.record.pricePerRun)}<span>one run, paid once</span></div>
      <div className="lane">
        {boxes.map((b, i) => (
          <div key={b.h} className={'pbox' + (t >= b.at ? ' on' : '')} style={rise(prog(t, 15.3 + i * 0.2, 0.5))}>
            <Icon name={b.icon} size={20} /><b>{b.h}</b><span>{b.p}</span>
          </div>
        ))}
        <i className="coin" style={{ left: `${8 + coin * 76}%`, opacity: t > 15.6 && t < 18.2 ? 1 : 0 }} />
      </div>
    </div>
  );
}

const CAT_COLOR: Record<string, string> = { source: '#79a8ff', guard: '#f0b44c', transform: '#a98bff', action: '#3ccb9a', sink: '#9aa6c2' };

function RunScene({ t, parts, services, approves }: { t: number; parts: PartManifest[]; services: string[]; approves: boolean }) {
  const checks = ['The recipe’s hash matches the chain', 'Your answers match what you paid for', 'The parts match the public list'];
  const approved = t >= 27.2;
  return (
    <div className="scene run" style={scene(t, 19.8, 29.8)}>
      <div className="tee">
        <div className="teehd"><Icon name="cpu" size={15} />Runner · Intel TDX<span><Icon name="lock" size={12} />sealed hardware</span></div>
        <div className="checks">{checks.map((c, i) => <div key={c} style={rise(prog(t, 20.4 + i * 0.45, 0.4), 6)}><Icon name="check" size={12} />{c}</div>)}</div>
        <div className={'parts' + (parts.length > 4 ? ' many' : '')}>
          {parts.map((p, i) => {
            const shimmer = 0.5 + 0.5 * Math.sin(t * 2.4 + i * 2.1);
            return (
              <div key={p.id + i} className="pchip" style={{ ...rise(prog(t, 22.0 + i * 0.22, 0.45), 8), ['--cc' as never]: CAT_COLOR[p.category], boxShadow: t > 23 ? `0 0 ${(6 + shimmer * 10).toFixed(1)}px rgba(240,180,76,${(0.08 + shimmer * 0.16).toFixed(2)})` : 'none' }}>
                <i /><b>{p.name}</b><span>{p.author}</span>
              </div>
            );
          })}
        </div>
        <div className="order" style={{ opacity: prog(t, 23.4, 0.5) }}><Icon name="lock" size={12} />run order sealed</div>
      </div>
      <div className="svc">
        {services.map((sv, i) => (
          <div key={sv} className="schip" style={rise(prog(t, 23.0 + i * 0.3, 0.45), 6)}>
            <i className="ping" style={{ animationDelay: `${i * 0.4}s` }} />{sv}
          </div>
        ))}
        {!services.length && <div className="schip" style={{ opacity: prog(t, 23, 0.4) }}>no network at all</div>}
      </div>
      {approves && (
        <div className={'approve' + (approved ? ' done' : '')} style={rise(span(t, 25.8, 29.6, 0.4), 20)}>
          <Icon name={approved ? 'check' : 'wallet'} size={16} />
          <div><b>{approved ? 'Approved in your wallet' : 'Approve in your wallet'}</b><span>{approved ? 'the runner can’t sign anything itself' : 'exactly these transfers, nothing else'}</span></div>
        </div>
      )}
    </div>
  );
}

function ResultScene({ t, s }: { t: number; s: FilmScript }) {
  return (
    <div className="scene result" style={scene(t, 29.8, 33.8)}>
      <div className="rcard" style={rise(prog(t, 30.2, 0.6), 16)}>
        <div className="rhd"><Icon name="unlock" size={15} />Opened in your browser</div>
        <h4>{s.result.title}</h4>
        {s.result.lines.map(([a, b], i) => <div key={a + i} className="rrow" style={rise(prog(t, 30.8 + i * 0.3, 0.45), 6)}><b>{a}</b><span>{b}</span></div>)}
      </div>
    </div>
  );
}

function SettleScene({ t, l, parts }: { t: number; l: FilmListing; parts: PartManifest[] }) {
  const pr = l.record.perRun;
  const byId = new Map(parts.map((p) => [p.id, p]));
  // a part used by several nodes is paid per node; show it once, with a count
  const merged = new Map<string, { n: number; v: number }>();
  for (const x of pr.parts) { const m = merged.get(x.part) ?? { n: 0, v: 0 }; merged.set(x.part, { n: m.n + 1, v: m.v + x.amount }); }
  const segs = [
    ...[...merged].map(([id, x]) => ({ who: (byId.get(id)?.name ?? id) + (x.n > 1 ? ` ×${x.n}` : ''), sub: byId.get(id)?.author ?? '', v: x.v, c: CAT_COLOR[byId.get(id)?.category ?? 'sink'] })),
    { who: 'Runner', sub: 'sealed hardware', v: pr.runner, c: '#a98bff' },
    { who: 'Protocol', sub: '2%', v: pr.protocol, c: '#56658a' },
    { who: 'Creator', sub: l.creator, v: pr.creator, c: '#ffd58a' },
    ...(pr.reserve > 0 ? [{ who: 'Guarantee deposit', sub: 'tops up the bond', v: pr.reserve, c: '#3ccb9a' }] : []),
  ];
  const total = segs.reduce((a, b) => a + b.v, 0) || 1;
  const grow = clamp((t - 34.4) / 1.8);
  let acc = 0;
  return (
    <div className="scene settle" style={scene(t, 33.8, 39.6)}>
      <div className="price" style={rise(prog(t, 34.0, 0.5))}>{dollars(pr.price)}<span>split by the contract, in one receipt</span></div>
      <div className="sbar">
        {segs.map((sg, i) => {
          const start = acc / total; acc += sg.v;
          const w = clamp((grow - start) / (sg.v / total)) * (sg.v / total) * 100;
          return <i key={i} style={{ width: `${w}%`, background: sg.c }} />;
        })}
      </div>
      <div className={'legend' + (segs.length > 6 ? ' two' : '')}>
        {segs.map((sg, i) => (
          <div key={i} style={rise(prog(t, 35.0 + i * 0.18, 0.4), 6)}>
            <i style={{ background: sg.c }} /><b>{sg.who}</b><span>{sg.sub}</span><em>{dollars(sg.v * clamp((t - 35.0 - i * 0.18) / 0.8), 4)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function WhyScene({ t, l, s, builders, parts, measured, onQuote }: { t: number; l: FilmListing; s: FilmScript; builders: number; parts: number; measured: boolean; onQuote: () => void }) {
  const pr = l.record.perRun;
  const partsTotal = pr.parts.reduce((a, b) => a + b.amount, 0);
  const cards = [
    { icon: 'user', who: 'The buyer', big: dollars(pr.price), unit: 'a run', line: s.buyerWin, foot: measured ? `backed by a ${dollars(l.record.deposit.available, 0)} deposit` : 'refunded if the run fails' },
    { icon: 'compose', who: 'The creator', big: dollars(pr.creator, 3), unit: 'a run', line: 'Earns from a method nobody else can read, copy or resell.', foot: 'no code written' },
    { icon: 'box', who: `${builders} part builder${builders > 1 ? 's' : ''}`, big: dollars(partsTotal, 3), unit: 'a run', line: `Paid for ${parts} part${parts > 1 ? 's' : ''} every time this recipe runs, and in every other recipe that uses them.`, foot: 'paid in the same receipt' },
  ];
  return (
    <div className="scene why" style={scene(t, 39.6, END, true)}>
      <div className="cards">
        {cards.map((c, i) => (
          <div key={c.who} className="wcard" style={rise(prog(t, 39.9 + i * 0.35, 0.55), 16)}>
            <span className="wic"><Icon name={c.icon} size={16} /></span>
            <b>{c.who}</b>
            <div className="big">{c.big}<span>{c.unit}</span></div>
            <p>{c.line}</p>
            <em>{c.foot}</em>
          </div>
        ))}
      </div>
      <button className="btn primary film-cta" style={rise(prog(t, 41.6, 0.5), 8)} onClick={onQuote}><Icon name="receipt" size={15} />Get a quote for {l.ticker}</button>
    </div>
  );
}
