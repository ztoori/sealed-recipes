import { useMemo } from 'react';
import { Marked, type Tokens } from 'marked';
import spec from '../../../docs/SRS-1.md?raw';
import { validatePartManifest } from '../../../core/src/partkit';
import type { Catalog } from '../../../core/src/srs';
import { usePoll } from '../api';
import { useApp } from '../App';
import { Icon } from '../icons';
import { Stat, Tip } from '../ui';
import { partTier, type Tier } from '../../../core/src/review';
import { TierTable } from '../components/Admission';

/**
 * Documentation › Spec: SRS-1, the format every part and recipe here is written in. The full text is
 * docs/SRS-1.md itself (rendered, not copied), next to the live registries it defines: types and parts.
 */
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const md = new Marked({
  renderer: {
    heading(this: any, t: Tokens.Heading) { const text = this.parser.parseInline(t.tokens); return `<h${t.depth} id="srs-${slug(t.text)}">${text}</h${t.depth}>`; },
    // links into the repository become file references (the repository is the source of truth); web links open normally
    link(this: any, t: Tokens.Link) {
      const text = this.parser.parseInline(t.tokens);
      if (/^https?:/.test(t.href)) return `<a href="${t.href}" target="_blank" rel="noreferrer">${text}</a>`;
      if (t.href.startsWith('#')) return `<a href="#" data-anchor="srs-${slug(t.href.slice(1))}">${text}</a>`;
      return `<span class="repo" title="in the repository: ${t.href.replace(/^\.\.\//, '')}">${text}</span>`;
    },
  },
});

export function Spec() {
  const { go } = useApp();
  const [cat] = usePoll<Catalog>('/api/catalog', 60000);
  const [listings] = usePoll<any[]>('/api/listings', 10000);
  const html = useMemo(() => md.parse(spec) as string, []);
  const toc = useMemo(() => [...spec.matchAll(/^## (.+)$/gm)].map((m) => ({ id: 'srs-' + slug(m[1]), label: m[1] })), []);
  const parts = cat?.parts ?? [];
  const conform = cat ? parts.filter((p) => !validatePartManifest(p, cat).some((d) => d.severity === 'error')).length : 0;
  const authors = new Set(parts.map((p) => p.author)).size;
  const tierCounts = parts.reduce<Partial<Record<Tier, number>>>((c, p) => { const t = partTier(p).tier; c[t] = (c[t] ?? 0) + 1; return c; }, {});
  const usedBy = (t: string) => parts.filter((p) => [...Object.values(p.inputs), ...Object.values(p.outputs)].some((s) => s.type === t)).length;
  const download = () => {
    const blob = new Blob([JSON.stringify({ srs: '1.0', types: cat?.types, parts }, null, 2)], { type: 'application/json' });
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
              <p className="lede">One shared format, so parts from different builders snap together into recipes, and every builder is paid in one settlement. <Tip wide>A part declares its typed inputs and outputs, what it may reach and what it discloses. A recipe wires parts together and is sealed. A signed quote prices one buyer’s sealed inputs. A listing is all the market ever sees. The spec is open so other marketplaces, runners, wallets and agents can adopt it.</Tip></p>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn primary" onClick={() => go({ page: 'compose', sub: 'part' })}><Icon name="code" size={15} />Build a part</button>
              <button className="btn ghost" onClick={() => go({ page: 'compose', sub: 'recipe' })}><Icon name="compose" size={15} />Compose a recipe</button>
              <button className="btn ghost icon-only" aria-label="Download the catalog (JSON)" title="Download the catalog (JSON)" disabled={!cat} onClick={download}><Icon name="download" size={15} /></button>
            </div>
          </div>
          <div className="std-stats">
            <Stat icon="link" value={Object.keys(cat?.types ?? {}).length} label="types" />
            <Stat icon="box" value={parts.length} label={`parts · ${authors} builders`} />
            <Stat icon="market" value={listings?.length ?? 0} label="recipes listed" />
            <Stat icon="shieldCheck" value={`${conform}/${parts.length}`} label="conform" tone={conform === parts.length ? 'gain' : 'loss'} tip="Parts passing the §9 conformance checks, run in this browser." />
          </div>
        </div>
      </div>

      <div className="grid std-docs">
        {[
          ['box', 'Part manifest', 'by a builder', 'Typed ports, declared capabilities, a fee, a disclosure of model and layers, and per-run limits. Registered on-chain by hash.', '§2'],
          ['lock', 'Recipe', 'sealed by a creator', 'A typed graph of parts with the creator’s settings and prompts. Encrypted to the attested runner; only its hash is on-chain.', '§3, §5'],
          ['eye', 'Public listing', 'derived, never typed', 'Form, parts, price and the risk and privacy labels computed from the parts. All a buyer or marketplace sees.', '§4'],
          ['receipt', 'Signed quote', 'by the runner', 'A price for one buyer’s sealed inputs, from a dry run. For a recipe that delivers swapped funds it also promises a value, backed by the guarantee deposit.', '§7'],
        ].map(([ic, t, who, d, ref]) => (
          <div key={t} className="panel"><div className="body"><span className="dico"><Icon name={ic} size={18} /></span><b>{t} <Tip>{d}</Tip></b><span className="small muted">{who} · {ref}</span></div></div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', alignItems: 'start' }}>
        <div className="panel">
          <header><Icon name="link" size={16} className="hd-ic" /><h2>Type registry</h2><span className="small muted">§1</span></header>
          <table className="small fixed"><thead><tr><th style={{ width: '30%' }}>Type</th><th>Meaning</th><th style={{ width: '14%' }} className="r">Parts</th></tr></thead><tbody>
            {Object.entries(cat?.types ?? {}).map(([k, t]) => <tr key={k}><td><code>{k}</code>{t.extends && <div className="muted">extends <code>{t.extends}</code></div>}</td><td>{t.description}</td><td className="r">{usedBy(k)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="panel">
          <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>Admission tiers</h2><span className="small muted">§11</span><Tip wide>A part runs inside other people’s sealed recipes, on buyers’ wallets. How much it must prove before it runs depends on what its manifest lets it do. Automated checks for everything; people only for what a sandbox cannot judge. Every decision is in the release log that the runner’s code hash covers.</Tip><span className="spacer" /><button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'review' })}>Review queue</button></header>
          <div className="body"><TierTable counts={tierCounts} /></div>
        </div>
      </div>

      <div className="grid std-text">
        <nav className="panel toc" aria-label="Spec contents">
          <header><Icon name="docs" size={16} className="hd-ic" /><h2>Contents</h2></header>
          <ol>{toc.map((t) => <li key={t.id}><button onClick={() => jump(t.id)}>{t.label.replace(/^\d+\.\s*/, '')}</button></li>)}</ol>
          <div className="small muted" style={{ padding: '0 16px 14px' }}>Rendered from docs/SRS-1.md</div>
        </nav>
        <article className="panel spec" onClick={(e) => { const a = (e.target as HTMLElement).closest('a[data-anchor]'); if (a) { e.preventDefault(); jump(a.getAttribute('data-anchor')!); } }}
          dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
