/// <reference types="vite/client" />
import { useEffect, useMemo } from 'react';
import { demoMs } from '../pace';
import { renderToStaticMarkup } from 'react-dom/server';
import { Marked, type Tokens } from 'marked';
import spec from '../../../docs/SRS-1.md?raw';
import type { Catalog } from '../../../core/src/srs';
import { usePoll } from '../api';
import { useApp } from '../App';
import { Icon } from '../icons';
import { Tip } from '../ui';
import { TierTable } from '../components/Admission';

/**
 * Documentation › Spec: SRS-1, the format every part and recipe here is written in. The full text is
 * docs/SRS-1.md itself (rendered, not copied), next to the type vocabulary and the admission tiers it defines.
 */
/** the diagrams in docs/media, inlined so they render in the app exactly as on GitHub */
const FIGURES = import.meta.glob('../../../docs/media/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const figure = (href: string) => Object.entries(FIGURES).find(([k]) => k.endsWith('/' + href.split('/').pop()))?.[1];
/** each section's mark, in the page and in the contents */
const SECTION_ICON: Record<string, string> = { why: 'sparkles', conventions: 'sliders', '1': 'link', '2': 'box', '3': 'compose', '4': 'eye', '5': 'lock', '6': 'cpu', '7': 'receipt', '8': 'clock', '9': 'shieldCheck', '10': 'globe', '11': 'shield', '12': 'layers', '13': 'flag' };
const sectionKey = (title: string) => title.match(/^(\d+)\./)?.[1] ?? title.split(' ')[0].toLowerCase();
const iconFor = (title: string) => SECTION_ICON[sectionKey(title)] ?? 'docs';
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const md = new Marked({
  renderer: {
    heading(this: any, t: Tokens.Heading) {
      const text = this.parser.parseInline(t.tokens);
      if (t.depth !== 2) return `<h${t.depth} id="srs-${slug(t.text)}">${text}</h${t.depth}>`;
      const n = t.text.match(/^(\d+)\.\s*(.*)$/);
      const mark = renderToStaticMarkup(<Icon name={iconFor(t.text) as never} size={18} />);
      return `<h2 id="srs-${slug(t.text)}"><span class="secmark">${mark}</span><span class="sectitle">${n ? n[2] : text}</span>${n ? `<span class="secnum">§${n[1]}</span>` : ''}</h2>`;
    },
    image(t: Tokens.Image) {
      const svg = figure(t.href);
      return svg ? `<figure class="figure" aria-label="${t.text.replace(/"/g, '&quot;')}">${svg}</figure>` : `<img src="${t.href}" alt="${t.text}">`;
    },
    // links into the repository become file references (the repository is the source of truth); web links open normally
    link(this: any, t: Tokens.Link) {
      const text = this.parser.parseInline(t.tokens);
      if (/^https?:/.test(t.href)) return `<a href="${t.href}" target="_blank" rel="noreferrer">${text}</a>`;
      if (t.href.startsWith('#')) return `<a href="#" data-anchor="srs-${slug(t.href.slice(1))}">${text}</a>`;
      return `<span class="repo" title="in the repository: ${t.href.replace(/^\.\.\//, '')}">${text}</span>`;
    },
  },
});

/** small visual touches on the rendered text: level pills, the comparison column, the four promises as cards */
function polish(html: string): string {
  return html
    .replace(/<td>(error|warning)<\/td>/g, (_m, l) => `<td><span class="lvl ${l}">${l}</span></td>`)
    .replace(/<table>(\s*<thead>(?:(?!<\/thead>)[\s\S])*<th>SRS-1<\/th>)/, '<table class="compare">$1')
    .replace(/(<p>Four promises hold for every recipe:<\/p>\s*)<ol>/, '$1<ol class="promises">');
}

export function Spec() {
  const { go, story } = useApp();
  // demo story, chapter 7: the four promises every recipe keeps
  useEffect(() => {
    if (story.step !== 7) return;
    const t = setTimeout(() => document.querySelector('ol.promises')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), demoMs(1500));
    return () => clearTimeout(t);
  }, [story.step, story.run]);
  const [cat] = usePoll<Catalog>('/api/catalog', 60000);
  const html = useMemo(() => polish(md.parse(spec) as string), []);
  const toc = useMemo(() => [...spec.matchAll(/^## (.+)$/gm)].map((m) => ({ id: 'srs-' + slug(m[1]), label: m[1] })), []);
  const parts = cat?.parts ?? [];
  const download = () => {
    const blob = new Blob([JSON.stringify({ srs: cat?.srs ?? '1.0', types: cat?.types, parts }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'srs-1-catalog.json'; a.click();
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="grid">
      <div className="panel std-hero">
        <div className="body grid" style={{ gap: 12 }}>
          <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
            <div style={{ maxWidth: 820 }}>
              <div className="tags" style={{ marginTop: 0 }}><span className="tag"><Icon name="globe" size={13} />Open spec</span><span className="tag">v1.0</span><span className="tag">MIT</span></div>
              <h1 className="listing-name">SRS-1: the Sealed Recipe Spec</h1>
              <p className="lede">Build a workflow from other people’s parts without writing code. Sell runs of it without showing how it works. Everyone who built a part is paid, every time it runs. <Tip wide>Parts declare what they take, return, reach and cost. A recipe wires them together and is sealed to the runner. A signed quote prices one buyer’s sealed inputs before they pay. The listing is all the market ever sees. The spec is open, so any marketplace, runner, wallet or agent can speak it.</Tip></p>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn primary" onClick={() => go({ page: 'compose', sub: 'part' })}><Icon name="code" size={15} />Build a part</button>
              <button className="btn ghost" onClick={() => go({ page: 'compose', sub: 'recipe' })}><Icon name="compose" size={15} />Compose a recipe</button>
              <button className="btn ghost icon-only" aria-label="Download the catalog (JSON)" title="Download the catalog (JSON)" disabled={!cat} onClick={download}><Icon name="download" size={15} /></button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid std-docs">
        {[
          ['box', 'Part manifest', 'by a builder', 'Typed ports, declared capabilities, a fee, a disclosure of model and layers, and per-run limits. Registered on-chain by hash.', '§2'],
          ['lock', 'Recipe', 'sealed by a creator', 'A typed graph of parts with the creator’s conditions, fallbacks, settings and prompts. Encrypted to the attested runner; only its hash is on-chain.', '§3, §5'],
          ['eye', 'Public listing', 'derived, never typed', 'Form, parts, price and the risk and privacy labels computed from the parts. All a buyer or marketplace sees.', '§4'],
          ['receipt', 'Signed quote', 'by the runner', 'A price for one buyer’s sealed inputs, from a dry run. For a recipe that delivers swapped funds it also promises a value, backed by the guarantee deposit.', '§7'],
        ].map(([ic, t, who, d, ref]) => (
          <div key={t} className="panel"><div className="body"><span className="dico"><Icon name={ic} size={18} /></span><b>{t} <Tip>{d}</Tip></b><span className="small muted">{who} · {ref}</span></div></div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', alignItems: 'start' }}>
        <div className="panel">
          <header><Icon name="link" size={16} className="hd-ic" /><h2>Type registry</h2><span className="small muted">§1</span></header>
          <table className="small fixed"><thead><tr><th style={{ width: '32%' }}>Type</th><th>Meaning</th></tr></thead><tbody>
            {Object.entries(cat?.types ?? {}).map(([k, t]) => <tr key={k}><td><code>{k}</code>{t.extends && <div className="muted">extends <code>{t.extends}</code></div>}</td><td>{t.description}</td></tr>)}
          </tbody></table>
        </div>
        <div className="panel">
          <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>Admission tiers</h2><span className="small muted">§11</span><Tip wide>A part runs inside other people’s sealed recipes, on buyers’ wallets. How much it must prove before it runs depends on what its manifest lets it do. Automated checks for everything; people only for what a sandbox cannot judge. Every decision is in the release log that the runner’s code hash covers.</Tip><span className="spacer" /><button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'review' })}>Review queue</button></header>
          <div className="body"><TierTable /></div>
        </div>
      </div>

      <div className="grid std-text">
        <nav className="panel toc" aria-label="Spec contents">
          <header><Icon name="docs" size={16} className="hd-ic" /><h2>Contents</h2></header>
          <ol className="toc-list">{toc.map((t) => <li key={t.id}><button onClick={() => jump(t.id)}><Icon name={iconFor(t.label) as never} size={14} />{t.label.replace(/^\d+\.\s*/, '')}</button></li>)}</ol>
          <div className="small muted" style={{ padding: '0 16px 14px' }}>Rendered from docs/SRS-1.md</div>
        </nav>
        <article className="panel spec" onClick={(e) => { const a = (e.target as HTMLElement).closest('a[data-anchor]'); if (a) { e.preventDefault(); jump(a.getAttribute('data-anchor')!); } }}
          dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
