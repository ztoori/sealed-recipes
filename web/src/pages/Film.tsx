/**
 * The guided demo in the local demo (`npm run demo`, and the sandbox at sealedrecipes.xyz/demo): the same film as the
 * live site (components/FilmPage.tsx, DemoFilm.tsx), with the same narration, score, captions and speed control. The
 * film shows the live testnet recipes; its end card and links open this demo's own pages. Under it, the hands-on tour
 * (App.tsx, story-machine.ts) drives this app through the same loop for real, on this machine.
 */
import { useApp } from '../App';
import { FilmPageView } from '../components/FilmPage';
import { Icon } from '../icons';

/** the film's live tickers, and the same recipes in this demo */
const LOCAL: Record<string, string> = { CHECK: 'CHEK', SAFE3: 'SAFE', AUDIT3: 'AUDT' };

const TODAY: [string, string][] = [
  ['This demo', 'Everything runs on this machine, with the same code as the live site: a mirror of the contract, the runner without a hardware TEE, and stand-ins for NEAR Intents, NEAR AI Cloud and NEAR RPC. Its transaction hashes are simulated.'],
  ['What the film shows', 'The three recipes live on NEAR testnet, CHECK, SAFE3 and AUDIT3, in a test token. Here they are CHEK, SAFE and AUDT, next to eight more that move funds or ask you to sign.'],
  ['On the live site', 'The same recipes on NEAR testnet, real transactions, and a runner in Intel TDX that your own browser checks: sealedrecipes.xyz.'],
];

export function Film() {
  const { go, story } = useApp();
  return (
    <FilmPageView today={TODAY} tryLabel="Try CHEK in this demo" links={{
      quote: (t) => go({ page: 'quote', ticker: LOCAL[t] ?? t }), recipes: () => go({ page: 'recipes' }), spec: () => go({ page: 'docs', sub: 'spec' }),
      composeRecipe: () => go({ page: 'compose', sub: 'recipe' }), composePart: () => go({ page: 'compose', sub: 'part' }),
      runner: () => go({ page: 'docs', sub: 'runner' }), trust: () => go({ page: 'docs', sub: 'trust' }),
    }} after={story.tour && (
      <div className="df-tour">
        <div><b>Rather click through it?</b><span>The hands-on tour drives this app for you, in seven captioned chapters: a creator composes and seals a recipe, a buyer gets a signed quote, pays and runs it, and everyone is paid in one receipt.</span></div>
        <button className="btn ghost" onClick={story.tour}><Icon name="play" size={14} fill />Take the hands-on tour</button>
      </div>
    )} />
  );
}
