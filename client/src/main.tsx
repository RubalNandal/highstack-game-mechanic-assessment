import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { money, parseStake } from './money';
import './style.css';

type Outcome = { triggered: boolean; multiplier: number; baseWin: number; finalWin: number; capped: boolean; configVersion: string };
type Round = { roundId: string; state: 'betting' | 'running' | 'crashed'; seq: number; multiplier?: number; bettingEndsAt?: number;
  serverSeedHash: string; nonce: number; configVersion: string; bonus?: Pick<Outcome, 'triggered' | 'multiplier'> };
type Bet = { id: string; roundId: string; roundState: string; amount: number; status: string; payout: number | null; payoutStatus: string; outcome: Outcome | null };
type State = { balance: number; round: Round | null; bets: Bet[]; engineOnline: boolean };
type Example = { label: string; seed: { serverSeed: string; nonce: number }; bet: { amount: number; baseWin: number }; config: object; outcome: Outcome };
type Replay = { matches: boolean; outcome: Outcome; storedOutcome: Outcome; seed: object; bet: object; config: object; configHash: string };
type Pending = { requestId: string; roundId: string; amount: number; autoCashout?: number };

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Request failed'), { status: response.status });
  return result;
}
function readPending(): Pending | null {
  try { return JSON.parse(sessionStorage.getItem('pending-bet') ?? 'null'); } catch { return null; }
}
function App() {
  const [state, setState] = useState<State | null>(null);
  const [stake, setStake] = useState('10.00'), [auto, setAuto] = useState('1.25');
  const [busy, setBusy] = useState(false), [cashoutBusy, setCashoutBusy] = useState<string | null>(null);
  const [message, setMessage] = useState(''), [connected, setConnected] = useState(false);
  const [examples, setExamples] = useState<Example[]>([]), [selected, setSelected] = useState<Example | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null), [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<Pending | null>(readPending);
  const pendingRef = useRef(pending), requestSequence = useRef(0), dialog = useRef<HTMLDialogElement>(null);
  const [points, setPoints] = useState<[number, number][]>([[0, 1]]);
  const persistPending = useCallback((value: Pending | null) => {
    pendingRef.current = value; setPending(value);
    if (value) sessionStorage.setItem('pending-bet', JSON.stringify(value)); else sessionStorage.removeItem('pending-bet');
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const data = await api<State>('/api/state');
      if (sequence !== requestSequence.current) return;
      setState(current => ({ ...data, round: current && current.round && data.round && current.round.roundId === data.round.roundId && current.round.seq > data.round.seq ? current.round : data.round }));
      const saved = data.bets.find(bet => bet.id === pendingRef.current?.requestId);
      if (saved && saved.status !== 'pending') persistPending(null);
    } catch (error) { setMessage((error as Error).message); }
  }, [persistPending]);
  useEffect(() => {
    void refresh();
    void api<{ examples: Example[] }>('/api/examples').then(data => setExamples(data.examples)).catch(error => setMessage(error.message));
    const poll = setInterval(() => void refresh(), 2000), clock = setInterval(() => setNow(Date.now()), 200);
    const events = new EventSource('/api/events');
    events.onopen = () => { setConnected(true); void refresh(); };
    events.onerror = () => setConnected(false);
    events.onmessage = event => {
      const value = JSON.parse(event.data);
      if (value.type === 'tick') {
        setState(current => {
          if (!current || !current.round || current.round.roundId !== value.data.roundId || current.round.state !== 'running' || value.seq <= current.round.seq) return current;
          return { ...current, round: { ...current.round, multiplier: value.data.multiplier, seq: value.seq } };
        });
        setPoints(current => [...current, [value.data.t, value.data.multiplier] as [number, number]].slice(-500));
      } else {
        if (value.type === 'round.betting' || value.type === 'resync') setPoints([[0, 1]]);
        void refresh();
      }
    };
    return () => { clearInterval(poll); clearInterval(clock); events.close(); };
  }, [refresh]);
  useEffect(() => { if (replay) dialog.current?.showModal(); }, [replay]);

  const round = state?.round;
  const active = state?.bets.filter(bet => bet.status === 'active' && bet.roundId === round?.roundId) ?? [];
  const countdown = Math.max(0, Math.ceil(((round?.bettingEndsAt ?? now) - now) / 1000));
  const liveMultiplier = round?.multiplier ?? 1;
  const maxTime = Math.max(points.at(-1)?.[0] ?? 0, 12_000), maxMultiplier = Math.max(liveMultiplier * 1.1, 2);
  const curve = points.map(([t, multiplier], i) => `${i ? 'L' : 'M'} ${24 + t / maxTime * 640} ${236 - (multiplier - 1) / (maxMultiplier - 1) * 210}`).join(' ');

  async function placeBet(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (!round) throw new Error('Wait for the engine to connect.');
      const autoCashout = auto.trim() ? Number(auto) : undefined;
      if (autoCashout !== undefined && (!Number.isFinite(autoCashout) || autoCashout < 1.01 || Math.abs(autoCashout * 100 - Math.round(autoCashout * 100)) > 1e-8))
        throw new Error('Auto cash-out must be at least 1.01, with at most two decimals.');
      const request = pendingRef.current ?? { requestId: crypto.randomUUID(), roundId: round.roundId, amount: parseStake(stake), autoCashout };
      persistPending(request);
      const result = await api<{ status: string }>('/api/bets', request);
      if (result.status !== 'pending') persistPending(null);
      setMessage(result.status === 'active' ? 'Bet accepted. Good luck.' : result.status === 'pending' ? 'Confirming your bet. Please keep the same request when retrying.' : 'Bet updated; check the result below.');
      await refresh();
    } catch (error) {
      if ((error as { status?: number }).status && (error as { status: number }).status < 500) persistPending(null);
      setMessage((error as Error).message);
    } finally { setBusy(false); }
  }
  async function cashOut(id: string) {
    setCashoutBusy(id); setMessage('');
    try { await api(`/api/bets/${id}/cashout`, {}); setMessage('Cash-out recorded. Your wallet payment is being confirmed.'); await refresh(); }
    catch (error) { setMessage((error as Error).message); await refresh(); }
    finally { setCashoutBusy(null); }
  }
  async function showReplay(id: string) {
    try { setReplay(await api<Replay>(`/api/replay/${id}`)); } catch (error) { setMessage((error as Error).message); }
  }

  return <div className="app">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark">H</span> highstack<span className="brand-light">/ bonus lab</span></a>
      <span className="connection"><i className={connected && state?.engineOnline ? 'dot' : 'dot offline'}/>{connected && state?.engineOnline ? 'Live connection' : 'Reconnecting'}</span></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">ONE ROUND. A LITTLE EXTRA POSSIBILITY.</p><h1>The bonus is in the details.</h1><p className="intro">Place a bet, cash out before the crash, and see if your round unlocks a bonus.</p></div><span className="demo-pill">DEMO PLAY</span></div>
      <section className="game-layout">
        <div className={`game-panel ${round?.state === 'crashed' ? 'crashed' : ''}`}>
          <div className="panel-top"><span className="eyebrow">CRASH / LIVE ROUND</span><span className={`state-pill ${round?.state ?? ''}`}>{!state?.engineOnline ? 'Connecting' : round?.state === 'betting' ? 'Bets open' : round?.state === 'running' ? 'In flight' : 'Crashed'}</span></div>
          <div className="multiplier"><span>{round?.state === 'betting' ? '1.00' : liveMultiplier.toFixed(2)}</span><small>×</small></div>
          <p className="round-caption">{!state?.engineOnline ? 'Waiting for the game engine…' : round?.state === 'betting' ? `Next flight in ${countdown}s · Place your bet` : round?.state === 'running' ? 'Cash out before the flight ends' : 'Round complete. The next flight is on its way.'}</p>
          <svg className="chart" viewBox="0 0 700 260" aria-label="Live multiplier chart" role="img"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="currentColor" stopOpacity=".16"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
            {[60, 120, 180, 236].map(y => <line key={y} x1="24" y1={y} x2="676" y2={y} className="grid-line"/>)}
            <path d={`${curve} L ${24 + (points.at(-1)?.[0] ?? 0) / maxTime * 640} 236 L 24 236 Z`} fill="url(#fill)"/>
            <path d={curve} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            <text x="24" y="257">0s</text><text x="650" y="257">{Math.round(maxTime / 1000)}s</text></svg>
          <div className="round-footer"><span>Round <b>{round?.nonce ?? '—'}</b></span><span>{round?.configVersion ?? 'Loading config'}</span>
            {round?.state === 'crashed' && <span className={round.bonus?.triggered ? 'bonus-text' : ''}>{round.bonus?.triggered ? `Bonus triggered · ${round.bonus.multiplier}×` : 'No bonus this round'}</span>}</div>
        </div>
        <aside className="wallet-panel"><p className="eyebrow">YOUR DEMO BALANCE</p><div className="balance">{money(state?.balance ?? 0)}</div><p className="muted">Player / demo</p><hr/>
          <form onSubmit={placeBet}><label htmlFor="stake">Bet amount</label><div className="input-wrap"><span>$</span><input id="stake" inputMode="decimal" value={stake} onChange={e => setStake(e.target.value)} disabled={busy || !!pending} required/></div>
            <label htmlFor="auto">Auto cash-out <span className="muted">optional</span></label><div className="input-wrap"><input id="auto" inputMode="decimal" value={auto} onChange={e => setAuto(e.target.value)} disabled={busy || !!pending}/><span>×</span></div>
            <button className="primary" disabled={busy || !state?.engineOnline || (!pending && round?.state !== 'betting')}>{busy ? 'Confirming…' : pending ? 'Retry same bet' : round?.state === 'betting' ? 'Place bet ↗' : 'Next round opens soon'}</button>
          </form>
          {active.map(bet => <button key={bet.id} className="cashout" onClick={() => void cashOut(bet.id)} disabled={round?.state !== 'running' || cashoutBusy !== null}>{cashoutBusy === bet.id ? 'Recording…' : `Cash out · ${money(bet.amount * liveMultiplier)}`}</button>)}
          <p className="small muted">A winning round may multiply your payout. The final win always respects the configured cap.</p>
        </aside>
      </section>
      <div className="message" role="status" aria-live="polite">{message || 'Your balance and settled payments are saved automatically.'}</div>
      <section className="results-section"><div className="section-heading"><div><p className="eyebrow">YOUR LAST ROUNDS</p><h2>Every result, accounted for.</h2></div><span className="muted small">Replay becomes available after the round ends.</span></div>
        <div className="table-wrap"><table><thead><tr><th>Bet</th><th>Result</th><th>Base win</th><th>Bonus</th><th>Final win</th><th>Payment</th><th><span className="sr-only">Replay</span></th></tr></thead><tbody>
          {!state?.bets.length ? <tr><td colSpan={7} className="empty">Your first round starts with a bet. Results will appear here.</td></tr> : state.bets.slice(0, 8).map(bet => <tr key={bet.id}><td>{money(bet.amount)}</td><td><span className={`result ${bet.status}`}>{bet.status.replaceAll('_', ' ')}</span></td><td>{bet.outcome ? money(bet.outcome.baseWin) : '—'}</td>
            <td>{bet.outcome?.triggered ? <span className="bonus-badge">{bet.outcome.multiplier}× bonus</span> : bet.outcome ? 'No bonus' : '—'}</td>
            <td>{bet.outcome ? <><b>{money(bet.outcome.finalWin)}</b>{bet.outcome.capped && <small className="cap-tag">CAPPED</small>}</> : bet.status === 'refunded' ? money(bet.payout ?? 0) : '—'}</td>
            <td>{bet.payoutStatus === 'paid' ? <span className="paid">✓ {bet.status === 'refunded' ? 'Refunded' : 'Paid'}</span> : bet.payoutStatus === 'pending' ? 'Confirming…' : bet.status === 'lost' ? 'No payout' : '—'}</td>
            <td>{bet.outcome && ['crashed', 'cancelled'].includes(bet.roundState) && <button className="text-button" onClick={() => void showReplay(bet.id)}>Replay ↗</button>}</td></tr>)}</tbody></table></div>
      </section>
      <section className="examples-section"><div className="section-heading"><div><p className="eyebrow">EXPLORE THE MECHANIC</p><h2>A closer look at the bonus.</h2></div><span className="muted small">Repeatable examples · Your balance stays the same</span></div>
        <div className="example-cards">{examples.map(example => <button key={example.label} className={`example-card ${selected?.label === example.label ? 'selected' : ''}`} onClick={() => setSelected(example)}><span className="example-icon">{example.label === 'Win cap' ? '↥' : example.outcome.triggered ? '✦' : '○'}</span><strong>{example.label}</strong><span>{money(example.outcome.baseWin)} → {money(example.outcome.finalWin)}</span><small>Inspect example ↗</small></button>)}</div>
        {selected && <div className="example-detail"><div><span className="eyebrow">{selected.outcome.configVersion} / NONCE {selected.seed.nonce}</span><h3>{selected.label}</h3><p>Base win {money(selected.bet.baseWin)} · Multiplier {selected.outcome.multiplier}× · Final win <b>{money(selected.outcome.finalWin)}</b>{selected.outcome.capped ? ' · Win cap applied.' : '.'}</p><p className="small muted">The same seed, bet and config reproduce this result. This example makes no wallet transaction.</p></div><button className="text-button" onClick={() => setSelected(null)}>Close</button></div>}
      </section>
      <footer><span>HIGHSTACK / BONUS LAB</span><span>Deterministic outcomes. Clear records.</span></footer>
    </main>
    <dialog ref={dialog} onClose={() => setReplay(null)}><button className="dialog-close" onClick={() => dialog.current?.close()} aria-label="Close replay">×</button><p className="eyebrow">ROUND REPLAY</p><h2>{replay?.matches ? 'Same inputs. Same result.' : 'Replay needs investigation.'}</h2><p className={replay?.matches ? 'paid' : ''}>{replay?.matches ? '✓ Saved outcome matches the recalculated outcome.' : 'The saved and recalculated outcomes differ.'}</p>
      {replay && <><div className="replay-summary"><span>Base win<b>{money(replay.outcome.baseWin)}</b></span><span>Bonus<b>{replay.outcome.triggered ? `${replay.outcome.multiplier}×` : 'None'}</b></span><span>Final win<b>{money(replay.outcome.finalWin)}</b></span></div><p className="small muted">Replaying only verifies the result. It never pays the wallet again.</p><details><summary>Recorded inputs and result</summary><pre>{JSON.stringify(replay, null, 2)}</pre></details></>}</dialog>
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
