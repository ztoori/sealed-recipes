import { SPEEDS, useSpeed } from '../pace';

/** Slower or faster: a small segmented control, remembered per kind of playback. */
export function SpeedControl({ kind, label = 'Speed' }: { kind: 'film' | 'demo'; label?: string }) {
  const [speed, setSpeed] = useSpeed(kind);
  return (
    <div className="speed" role="radiogroup" aria-label={`${label}: ${speed}×`}>
      <span aria-hidden>{label}</span>
      {SPEEDS.map((s) => (
        <button key={s} role="radio" aria-checked={s === speed} className={s === speed ? 'on' : ''} onClick={(e) => { e.stopPropagation(); setSpeed(s); }}>{s}×</button>
      ))}
    </div>
  );
}
