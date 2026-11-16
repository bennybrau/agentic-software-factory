import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { setupFlags } from '../setup-flags';
import { LocalWorkerHelp } from '../components/LocalWorkerHelp';
import { aiQ, approvalsQ, codeQ, spendingQ, ticketsQ, ticketConnections, QTip, type Question } from '../components/q/questions';
import { useSettingsStore, type SettingsStore } from '../components/q/ui';

/**
 * /setup: the first-run wizard (#83, redesigned as a questionnaire). A few
 * plain-language questions, one per screen, then a finish screen that waits for a
 * worker to come online. Every answer is an ordinary org setting, so it shows up
 * (and can be changed) on /settings. Engineers can skip it and set `.env` instead.
 *
 * "Where does your code live?" is always asked, because nothing can start without
 * a repository to put the work in, unless GitHub tickets already answered it (the
 * repo and token are the same). Sample tickets still need a real repository.
 */
export function Setup() {
  const store = useSettingsStore();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  const githubTickets = ticketConnections(store.byKey).includes('github');
  const steps: Question[] = [ticketsQ, ...(githubTickets ? [] : [codeQ]), aiQ, approvalsQ, spendingQ];
  const total = steps.length;
  const leave = () => { setupFlags.dismiss(); navigate('/'); };

  if (!store.loaded) return <div className="wizard"><p className="muted">{store.err ? `Couldn’t load settings: ${store.err}` : 'Loading…'}</p></div>;

  return (
    <div className="wizard">
      <div className="row between wizard-top">
        <div className="progress" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => <i key={i} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''} />)}
        </div>
        <button className="linkish" onClick={leave}>I’ll do this later</button>
      </div>

      {step === 0 && (
        <section className="wstep">
          <div className="kicker">Welcome</div>
          <h1>Let’s get your factory building.</h1>
          <p className="why">A few quick questions, about three minutes. You can change any answer later in Settings.</p>
          <ol className="agenda">
            <li>Where your tickets and code live</li>
            <li>Which AI does the work</li>
            <li>When it should check with you</li>
            <li>How much it can spend</li>
          </ol>
          <div className="wnav"><span /><button className="btn" onClick={() => setStep(1)}>Let’s go</button></div>
        </section>
      )}

      {step >= 1 && step <= total && (() => {
        const q = steps[step - 1];
        return (
          <section className="wstep" key={q.id}>
            <div className="kicker">Question {step} of {total}</div>
            <h1>{q.title}<QTip id={q.id} byKey={store.byKey} note={q.tipNote} /></h1>
            <p className="why">{q.why}</p>
            <q.Body store={store} firstRun actions={({ save, busy, error }) => (
              <>
                {error && <div className="bad" style={{ marginTop: 14 }}>{error}</div>}
                <div className="wnav">
                  <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>
                  <button className="btn" disabled={busy} onClick={async () => { if (await save()) setStep(step + 1); }}>
                    {busy ? 'Saving…' : step === total ? 'Finish' : 'Continue'}
                  </button>
                </div>
              </>
            )} />
          </section>
        );
      })()}

      {step > total && <Done steps={steps} store={store} onBack={() => setStep(total)} onGo={() => { setupFlags.dismiss(); navigate('/backlog'); }} />}
    </div>
  );
}

const SUMMARY_LABEL: Record<string, string> = { tickets: 'Tickets', code: 'Code', ai: 'AI', approvals: 'Check-ins', spending: 'Spending' };

function Done({ steps, store, onBack, onGo }: { steps: Question[]; store: SettingsStore; onBack: () => void; onGo: () => void }) {
  const { data } = useQuery({
    queryKey: ['setup-status'], queryFn: api.setupStatus,
    refetchInterval: (q) => (q.state.data?.items.find((i) => i.id === 'worker')?.done ? false : 5_000),
  });
  const worker = data?.items.find((i) => i.id === 'worker');
  const scm = data?.items.find((i) => i.id === 'scm');
  const ready = Boolean(worker?.done && scm?.done);
  return (
    <section className="wstep">
      <div className="kicker">{worker?.done ? 'All set' : 'Almost there'}</div>
      <h1>{worker?.done ? 'Your factory is ready to build.' : 'Your answers are saved.'}</h1>
      <div className="summary">
        {steps.map((q) => (
          <div key={q.id}><span className="t">{SUMMARY_LABEL[q.id]}</span><span>{q.summary(store.byKey)}</span><span className="ok">✓</span></div>
        ))}
      </div>
      {worker?.done ? (
        <div className="ready go"><span className="ok big">●</span><div><b>A worker is online.</b><div className="muted small">Your AI team is ready for its first ticket.</div></div></div>
      ) : (
        <div className="ready wait"><span className="pulse" /><div>
          <b>Waiting for a worker to come online…</b>
          <div className="muted small" style={{ marginBottom: 8 }}>The worker is the computer that runs the AI. This page updates by itself.</div>
          <LocalWorkerHelp />
        </div></div>
      )}
      <div className="wnav">
        <button className="btn ghost" onClick={onBack}>Back</button>
        {scm && !scm.done && <span className="bad small">No repository yet: {scm.reason} <Link to={scm.link}>Fix it</Link></span>}
        <button className="btn" disabled={!ready} onClick={onGo}>Pick your first ticket →</button>
      </div>
    </section>
  );
}
