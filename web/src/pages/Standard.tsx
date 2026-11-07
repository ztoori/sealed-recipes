import { useMemo } from 'react';
import { Marked, type Tokens } from 'marked';
import spec from '../../../docs/SRS-1.md?raw';
import { validatePartManifest } from '../../../core/src/partkit';
import type { Catalog } from '../../../core/src/srs';
import { usePoll } from '../api';
import { useApp } from '../App';

/**
 * Documentation › Standard: SRS-1, the format every part, job and recipe here is written in. The full text is
 * docs/SRS-1.md itself (rendered, not copied), next to the live registries it defines: types, job types, parts.
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

export function Standard() {
  const { go } = useApp();
  const [cat] = usePoll<Catalog>('/api/catalog', 60000);
  const [listings] = usePoll<any[]>('/api/listings', 10000);
  const html = useMemo(() => md.parse(spec) as string, []);
  const toc = useMemo(() => [...spec.matchAll(/^## (.+)$/gm)].map((m) => ({ id: 'srs-' + slug(m[1]), label: m[1] })), []);
  const parts = cat?.parts ?? [];
  const conform = cat ? parts.filter((p) => !validatePartManifest(p, cat).some((d) => d.severity === 'error')).length : 0;
  const authors = new Set(parts.map((p) => p.author)).size;
  const usedBy = (t: string) => parts.filter((p) => [...Object.values(p.inputs), ...Object.values(p.outputs)].some((s) => s.type === t)).length;
  const download = () => {
    const blob = new Blob([JSON.stringify({ srs: '1.0', types: cat?.types, jobs: cat?.jobs, parts }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'srs-1-catalog.json'; a.click();
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="grid">
      <div className="panel std-hero">
        <div className="body grid" style={{ gap: 12 }}>
          <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
            <div style={{ maxWidth: 820 }}>
              <div className="small muted">Open standard · v1.0 · MIT licensed</div>
              <h1 className="listing-name">SRS-1: the Sealed Recipe Standard</h1>
              <p style={{ margin: '8px 0 0' }}>Everything in this app is written in one format. A <b>part</b> declares its typed inputs and outputs, what it may reach and what it discloses. A <b>job type</b> is a request any wallet or agent can post. A <b>recipe</b> wires parts together and is sealed. A <b>listing</b> is all the market ever sees. Because the format is shared, parts from different builders snap together, rival recipes can be compared on the same job, and every builder can be paid in one settlement.</p>
              <p className="muted" style={{ margin: '8px 0 0' }}>The marketplace is only as useful as the number of parts, recipes and clients that speak SRS-1. It is open so that anyone can adopt it: other marketplaces, runners, wallets and agents, not only this one.</p>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn" onClick={() => go({ page: 'compose', sub: 'part' })}>Build a part</button>
              <button className="btn ghost" onClick={() => go({ page: 'compose', sub: 'recipe' })}>Compose a recipe</button>
              <button className="btn ghost" disabled={!cat} onClick={download}>Download the catalog (JSON)</button>
            </div>
          </div>
          <div className="std-stats">
            <div><b>{Object.keys(cat?.types ?? {}).length}</b><span>standard types</span></div>
            <div><b>{cat?.jobs?.length ?? 0}</b><span>job types</span></div>
            <div><b>{parts.length}</b><span>parts by {authors} builders</span></div>
            <div><b>{listings?.length ?? 0}</b><span>recipes listed</span></div>
            <div><b className={conform === parts.length ? 'gain' : 'loss'}>{conform}/{parts.length}</b><span>parts pass the conformance checks (§9), checked in this browser</span></div>
          </div>
        </div>
      </div>

      <div className="grid std-docs">
        {[
          ['Part manifest', 'published by a builder', 'Typed ports, declared capabilities, a fee, a disclosure of model and layers, and per-run limits. Registered on-chain by hash.', '§2'],
          ['Job type', 'a public interface', 'A standard request: inputs, output and how value is measured. Recipes compete to fulfil it with signed quotes.', '§7'],
          ['Recipe', 'written by a creator, sealed', 'A typed graph of parts with the creator’s settings and prompts. Encrypted to the attested runner; only its hash is on-chain.', '§3, §5'],
          ['Public listing', 'derived, never typed in', 'Form, parts, price and the risk and privacy labels computed from the parts. All a buyer or marketplace sees.', '§4'],
        ].map(([t, who, d, ref]) => (
          <div key={t} className="panel"><div className="body"><b>{t}</b> <span className="small muted">{who}</span><p className="small" style={{ margin: '6px 0 0' }}>{d}</p><div className="small muted" style={{ marginTop: 6 }}>{ref}</div></div></div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', alignItems: 'start' }}>
        <div className="panel">
          <header><h2>Type registry</h2><span className="small muted">§1 · nominal subtyping</span></header>
          <table className="small fixed"><thead><tr><th style={{ width: '30%' }}>Type</th><th>Meaning</th><th style={{ width: '14%' }} className="r">Parts</th></tr></thead><tbody>
            {Object.entries(cat?.types ?? {}).map(([k, t]) => <tr key={k}><td><code>{k}</code>{t.extends && <div className="muted">extends <code>{t.extends}</code></div>}</td><td>{t.description}</td><td className="r">{usedBy(k)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="panel">
          <header><h2>Job types</h2><span className="small muted">§7 · what buyers can ask for</span></header>
          <table className="small fixed"><thead><tr><th style={{ width: '34%' }}>Job</th><th>Buyer gives → gets</th><th style={{ width: '16%' }} className="r">Recipes</th></tr></thead><tbody>
            {(cat?.jobs ?? []).map((j) => {
              const n = (listings ?? []).filter((l) => l.implements === j.id).length;
              return <tr key={j.id}><td><b>{j.name}</b><div className="muted"><code>{j.id}</code></div></td><td>{Object.values(j.inputs).map((f: any) => <code key={f.label} title={f.label}>{f.type}</code>).reduce((a: any[], c, i) => (i ? [...a, ', ', c] : [c]), [])} → <code>{j.output}</code>{j.metric && <div className="muted">value measured as {j.metric.name}</div>}</td><td className="r">{n || <span className="muted">open demand</span>}</td></tr>;
            })}
          </tbody></table>
        </div>
      </div>

      <div className="grid std-text">
        <nav className="panel toc" aria-label="Standard contents">
          <header><h2>Contents</h2></header>
          <ol>{toc.map((t) => <li key={t.id}><button onClick={() => jump(t.id)}>{t.label.replace(/^\d+\.\s*/, '')}</button></li>)}</ol>
          <div className="small muted" style={{ padding: '0 14px 12px' }}>Source: docs/SRS-1.md in the repository. This page renders that file.</div>
        </nav>
        <article className="panel spec" onClick={(e) => { const a = (e.target as HTMLElement).closest('a[data-anchor]'); if (a) { e.preventDefault(); jump(a.getAttribute('data-anchor')!); } }}
          dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
