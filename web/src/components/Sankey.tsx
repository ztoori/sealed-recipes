import { usd } from '../api';

const COLORS: Record<string, string> = { protocol: '#8592a8', runner: '#5b6b84', creator_royalty: '#b77a06', shareholders: '#0f7a66' };

/** Where one run's payment went: a single settlement split into every payee. */
export function SettlementFlow({ price, payouts, pool }: { price: number; payouts: { account_id: string; role: string; amount: string }[]; pool: number }) {
  const items = [...payouts.map((p) => ({ label: p.role.startsWith('part:') ? `${p.account_id}` : p.account_id, sub: p.role.startsWith('part:') ? p.role.slice(6).split('@')[0] : p.role.replace('_', ' '), amount: Number(p.amount), color: p.role.startsWith('part:') ? '#2f6fdb' : COLORS[p.role] ?? '#5b6b84' })),
    { label: 'all shareholders', sub: 'dividend, pro rata', amount: pool, color: COLORS.shareholders }];
  const H = 430, W = 660, gap = 5, x0 = 150, x1 = 400;
  const total = items.reduce((s, i) => s + i.amount, 0) || 1;
  const usable = H - gap * (items.length - 1);
  // right side: proportional but with a minimum slot so every payee stays legible
  const raw = items.map((it) => Math.max(28, (it.amount / total) * usable));
  const k = usable / raw.reduce((a, b) => a + b, 0);
  let yL = (H - usable * 0.9) / 2, yR = 0;
  const bands = items.map((it, i) => {
    const h = raw[i] * k;
    const lh = (it.amount / total) * usable * 0.9;
    const b = { ...it, yl: yL, lh, yr: yR, h };
    yL += lh; yR += h + gap;
    return b;
  });
  return (
    <svg className="sankey" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Settlement split">
      <rect x={x0 - 18} y={(H - usable * 0.9) / 2} width={18} height={usable * 0.9} fill="#15233f" rx={2} />
      <text x={x0 - 26} y={H / 2 - 8} textAnchor="end" style={{ fontWeight: 650, fontSize: 15 }}>{usd(price, 2)}</text>
      <text x={x0 - 26} y={H / 2 + 10} textAnchor="end" className="muted">one run</text>
      {bands.map((b, i) => (
        <g key={i}>
          <path d={`M${x0},${b.yl} C${(x0 + x1) / 2},${b.yl} ${(x0 + x1) / 2},${b.yr} ${x1},${b.yr} L${x1},${b.yr + b.h} C${(x0 + x1) / 2},${b.yr + b.h} ${(x0 + x1) / 2},${b.yl + b.lh} ${x0},${b.yl + b.lh} Z`} fill={b.color} opacity={0.28} />
          <rect x={x1} y={b.yr} width={10} height={b.h} fill={b.color} />
          <text x={x1 + 18} y={b.yr + b.h / 2 - 2} dominantBaseline="middle"><tspan style={{ fontWeight: 650 }}>{usd(b.amount)}</tspan> <tspan>{b.label}</tspan></text>
          <text x={x1 + 18} y={b.yr + b.h / 2 + 11} dominantBaseline="middle" style={{ fill: '#5b6b84', fontSize: 10.5 }}>{b.sub}</text>
        </g>
      ))}
    </svg>
  );
}
