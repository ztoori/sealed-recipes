/**
 * Narration for the guided demo film (web/src/components/DemoFilm.tsx), both cuts: one small MP3 per spoken line, plus
 * web/public/assets/film/voice.json, which the film reads to know they exist. Without them the film still plays,
 * with captions and its built-in score.
 *
 *   npx tsx scripts/film-voice.ts                 text-to-speech with Piper (offline, open source)
 *   npx tsx scripts/film-voice.ts --from DIR      your own recordings: DIR/b01.wav (or .mp3, .m4a) … one per line
 *   npx tsx scripts/film-voice.ts --script        print the lines with their ids and time windows (to record them)
 *   npx tsx scripts/film-voice.ts --check         check the clips in the repo against the screenplay (no Piper needed)
 *
 * Piper: pip install piper-tts && mkdir -p ~/.piper && cd ~/.piper && python3 -m piper.download_voices en_US-libritts-high
 *        The default voice, en_US-libritts-high, is trained on LibriTTS (CC BY 4.0), so the film credits it on its page
 *        and the README credits it too. It has 904 speakers: FILM_SPEAKER picks one by number (default 856, LibriTTS speaker p7665). Another Piper voice:
 *        FILM_VOICE=… FILM_VOICE_CREDIT='…' (check its MODEL_CARD for the dataset's licence and credit it).
 * Needs ffmpeg. Each clip is mono MP3 at 40 kb/s, normalised, with the silence trimmed: about 600 KB in all.
 * File names carry a hash of the line, so a changed line gets a new file and browsers never play a stale one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUTS, type Beat } from '../web/src/components/demo-film/script.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'web/public/assets/film');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
// every line of both cuts (the full film and the X cut share most of them), each with the shortest time it gets,
// measured in seconds of its clip: the real time until the next line, times how fast the narrator plays it there
const slots = new Map<string, { beat: Beat; window: number }>();
for (const c of Object.values(CUTS)) c.beats.forEach((b, i) => {
  const w = (c.real(c.beats[i + 1]?.at ?? c.end) - c.real(b.at)) * c.voice(b.at), had = slots.get(b.id);
  if (had && had.beat.text !== b.text) throw new Error(`${b.id} has two different lines`);
  slots.set(b.id, { beat: b, window: Math.min(w, had?.window ?? Infinity) });
});
const BEATS = [...slots.values()].map((s) => s.beat);
const window = (i: number) => slots.get(BEATS[i].id)!.window;
/** what the voice should say: the caption, with typographic marks a speech engine reads cleanly */
const spoken = (s: string) => s.replace(/[’‘]/g, "'").replace(/…/g, '...').replace(/ · /g, ', ').replace(/ — /g, ', ');

if (process.argv.includes('--script')) {
  BEATS.forEach((b, i) => console.log(`${b.id}  ${b.at.toFixed(1).padStart(5)} s  max ${window(i).toFixed(1)} s   ${spoken(b.text)}`));
  process.exit(0);
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// --check: measure the clips already in web/public/assets/film/ against the screenplay; exits 1 if a line is missing or too long
if (process.argv.includes('--check')) {
  const have = JSON.parse(readFileSync(join(OUT, 'voice.json'), 'utf8')) as { clips: Record<string, string> };
  let bad = 0;
  BEATS.forEach((b, i) => {
    const f = have.clips[b.id];
    if (!f || !existsSync(join(OUT, f))) { console.log(`${b.id}  no clip`); bad++; return; }
    const dur = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(OUT, f)]).trim());
    const ok = dur <= window(i) - 0.3; if (!ok) bad++;
    console.log(`${b.id}  ${dur.toFixed(2)} s of ${window(i).toFixed(1)} s${ok ? '' : '  ← too long for its beat'}`);
  });
  console.log(bad ? `${bad} line(s) need attention` : `all ${BEATS.length} lines fit`);
  process.exit(bad ? 1 : 0);
}
try { run('ffmpeg', ['-version']); } catch { console.error('ffmpeg is required (sudo apt install ffmpeg)'); process.exit(1); }
const from = arg('--from');
const voice = process.env.FILM_VOICE ?? 'en_US-libritts-high';
const speaker = process.env.FILM_SPEAKER ?? '856';
/** shown under the film when the narration is on (CC BY asks for credit where the work is used) */
const credit = from ? (process.env.FILM_VOICE_CREDIT ?? '') : (process.env.FILM_VOICE_CREDIT ?? (voice === 'en_US-libritts-high'
  ? `Narration: Piper voice en_US-libritts-high${speaker === '856' ? ' (speaker p7665)' : ` (speaker ${speaker})`}, trained on LibriTTS (Zen et al., 2019), CC BY 4.0`
  : `Narration: Piper voice ${voice}`));
const voiceDir = process.env.FILM_VOICE_DIR ?? join(homedir(), '.piper');
const tmp = mkdtempSync(join(tmpdir(), 'film-voice-'));
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^[abx]\d+-[0-9a-f]{8}\.mp3$/.test(f)) rmSync(join(OUT, f));

const clips: Record<string, string> = {};
let total = 0, late = 0;
BEATS.forEach((b, i) => {
  const text = spoken(b.text);
  let src: string;
  if (from) {
    const found = ['wav', 'mp3', 'm4a', 'ogg', 'flac'].map((e) => join(resolve(from), `${b.id}.${e}`)).find(existsSync);
    if (!found) { console.warn(`${b.id}: no recording in ${from}, skipped (the caption still shows)`); return; }
    src = found;
  } else {
    src = join(tmp, `${b.id}.wav`);
    try { run('python3', ['-m', 'piper', '-m', voice, '--data-dir', voiceDir, '--speaker', speaker, '-f', src, '--', text]); }
    catch (e) { console.error(`Piper failed on ${b.id}. Is it installed, with the voice downloaded?\n  pip install piper-tts\n  mkdir -p ${voiceDir} && cd ${voiceDir} && python3 -m piper.download_voices ${voice}\n${(e as Error).message.split('\n')[0]}`); process.exit(1); }
  }
  const name = `${b.id}-${createHash('sha256').update(voice + speaker + text).digest('hex').slice(0, 8)}.mp3`;
  // trim silence at both ends, even out loudness, mono 40 kb/s
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5:LRA=11', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '40k', join(OUT, name)]);
  const dur = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(OUT, name)]).trim());
  total += dur;
  const fits = dur <= window(i) - 0.3;
  if (!fits) late++;
  console.log(`${b.id}  ${dur.toFixed(2)} s of ${window(i).toFixed(1)} s ${fits ? '' : '  ← longer than its beat: shorten the line in web/src/components/demo-film/script.ts, or speak faster'}`);
  clips[b.id] = name;
});
writeFileSync(join(OUT, 'voice.json'), JSON.stringify({ voice: from ? 'recorded' : voice, speaker: from ? undefined : Number(speaker), credit, clips }, null, 1) + '\n');
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${Object.keys(clips).length} clips, ${total.toFixed(1)} s of speech → web/public/assets/film/ (${late ? late + ' too long' : 'all fit'}). Rebuild the site (npm run build) to ship them.`);
