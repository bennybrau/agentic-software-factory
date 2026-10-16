import { useEffect, useState, type ReactNode } from 'react';
import {
  MODELS, PIPELINE_STAGES, QUESTIONS, detectApprovalPreset, applyApprovalPreset, setFactoryMerges, effectiveStages, detectTeamAi, teamAiWrites,
  MODEL_GROUPS, OLLAMA_CLOUD_USAGE_URL, modelGroup, teamAis, runtimeForPick, allowlistWith,
  BUDGET_PRESETS, detectBudgetPreset, subscriptionSharingWarning, vertexWrites, vertexTier, CLAUDE_TERMS_URL, CLAUDE_USAGE_DOC_URL, type ApprovalPreset, type PipelineStage, type StageConfig,
} from '@asf/shared/ui';
import { api } from '../../api';
import { setupFlags } from '../../setup-flags';
import { lookQ } from '../ThemeSettings';
import { VertexSetup, initialVertexDraft, vertexDraftProblem, type VertexDraft } from './vertex';
import { OllamaModels, emptyOllamaDraft, type OllamaDraft } from './ollama';
import { Choices, Field, SecretField, CheckButton, Locked, Tip, HealthNote, str, secretIsSet, unanswered, needsFix, type ByKey, type SettingsStore } from './ui';

/**
 * The questions themselves. Each one has:
 *   - `title`/`why`: the plain-language question (no setting keys, ever)
 *   - `summary(byKey)`: the current answer in a sentence, for the collapsed row
 *   - `Body`: the editor. It keeps its own draft and hands a `save()` to the
 *     caller's `actions` render prop, so the same body works as a wizard step
 *     ("Continue") and as an inline Settings editor ("Save" / "Cancel").
 *
 * Which keys a question covers lives in @asf/shared QUESTIONS (tested against the
 * catalogue); the ⓘ tooltip reads them from there.
 */

export type Actions = (a: { save: () => Promise<boolean>; busy: boolean; error: string | null }) => ReactNode;

export interface QuestionProps {
  store: SettingsStore;
  actions: Actions;
  /** In the first-run wizard: pick sensible defaults, show more hand-holding. */
  firstRun?: boolean;
}

export interface Question {
  id: string;
  title: string;
  why: string;
  tipNote?: string;
  summary: (b: ByKey) => ReactNode;
  /** Highlight in amber on the Settings page. */
  attention?: (b: ByKey) => boolean;
  Body: (p: QuestionProps) => JSX.Element;
}

/** The keys a question covers, from the test-guarded shared map (so the ⓘ can't drift). */
export function questionKeys(id: string): string[] {
  return [...(QUESTIONS.find((q) => q.id === id)?.keys ?? [])];
}

export function QTip({ id, byKey, note }: { id: string; byKey: ByKey; note?: string }) {
  return <Tip keys={questionKeys(id)} byKey={byKey} note={note} />;
}

/** Shared save plumbing: a draft → an ordered list of writes. */
function useSaver(store: SettingsStore) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (entries: [string, unknown][], validate?: () => string | null): Promise<boolean> => {
    const bad = validate?.();
    if (bad) { setError(bad); return false; }
    setBusy(true); setError(null);
    const e = await store.saveMany(entries.filter(([k]) => !store.byKey[k]?.envPinned));
    setBusy(false);
    if (e) { setError(e); return false; }
    return true;
  };
  return { busy, error, setError, run };
}

/** Only send a secret when one was typed (never re-send / blank a saved one). */
const secretEntry = (key: string, v: string): [string, unknown][] => (v.trim() ? [[key, v.trim()]] : []);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

// ── 1. Tickets ───────────────────────────────────────────────────────────────

/** The token each tracker / code host is checked with (credential health, #139). */
const TOKEN: Record<string, { key: string; name: string }> = {
  github: { key: 'GITHUB_TOKEN', name: 'GitHub token' }, jira: { key: 'JIRA_API_TOKEN', name: 'Jira API token' },
  trello: { key: 'TRELLO_TOKEN', name: 'Trello token' }, gitlab: { key: 'GITLAB_TOKEN', name: 'GitLab token' },
};
const tokenHealth = (b: ByKey, kind: string) => (TOKEN[kind] ? <HealthNote s={b[TOKEN[kind].key]} name={TOKEN[kind].name} /> : null);
const tokenNeedsFix = (b: ByKey, kind: string) => !!TOKEN[kind] && needsFix(b[TOKEN[kind].key]);

const TRACKER_LABEL: Record<string, string> ={ github: 'GitHub', jira: 'Jira', trello: 'Trello', mock: 'Sample tickets', gitlab: 'GitLab', linear: 'Linear', monday: 'monday.com', todoist: 'Todoist' };

export const ticketsQ: Question = {
  id: 'tickets',
  title: 'Where do your tickets live?',
  why: 'The factory picks up tickets from here and moves them along your board as the work happens.',
  summary: (b) => {
    const kind = str(b.TICKET_PROVIDER);
    if (kind === 'mock') return <><b>Sample tickets</b> (practice mode)</>;
    const n = list(str(kind === 'github' ? b.GITHUB_REPOS : kind === 'jira' ? b.JIRA_PROJECTS : b.TRELLO_BOARDS)).length;
    const unit = kind === 'github' ? ['repository', 'repositories'] : kind === 'jira' ? ['project', 'projects'] : ['board', 'boards'];
    return <><b>{TRACKER_LABEL[kind] ?? kind}</b>{n > 0 && ` · ${n} ${unit[n > 1 ? 1 : 0]}`}{tokenHealth(b, kind)}</>;
  },
  attention: (b) => tokenNeedsFix(b, str(b.TICKET_PROVIDER)),
  Body: function TicketsBody({ store, actions, firstRun }) {
    const b = store.byKey;
    const pinned = b.TICKET_PROVIDER?.envPinned;
    const current = str(b.TICKET_PROVIDER);
    const [kind, setKind] = useState<string | null>(firstRun && current === 'mock' && unanswered(b.TICKET_PROVIDER) ? null : current);
    const [f, setF] = useState(() => ({
      GITHUB_REPOS: str(b.GITHUB_REPOS), GITHUB_TOKEN: '',
      JIRA_BASE_URL: str(b.JIRA_BASE_URL), JIRA_EMAIL: str(b.JIRA_EMAIL), JIRA_API_TOKEN: '', JIRA_PROJECTS: str(b.JIRA_PROJECTS),
      TRELLO_KEY: '', TRELLO_TOKEN: '', TRELLO_BOARDS: str(b.TRELLO_BOARDS),
    }));
    const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
    const { busy, error, run } = useSaver(store);

    const entries = (): [string, unknown][] => {
      const e: [string, unknown][] = [];
      if (kind === 'github') e.push(['GITHUB_REPOS', f.GITHUB_REPOS.trim()], ...secretEntry('GITHUB_TOKEN', f.GITHUB_TOKEN));
      if (kind === 'jira') e.push(['JIRA_BASE_URL', f.JIRA_BASE_URL.trim().replace(/\/+$/, '')], ['JIRA_EMAIL', f.JIRA_EMAIL.trim()], ...secretEntry('JIRA_API_TOKEN', f.JIRA_API_TOKEN), ['JIRA_PROJECTS', f.JIRA_PROJECTS.trim().toUpperCase()]);
      if (kind === 'trello') e.push(...secretEntry('TRELLO_KEY', f.TRELLO_KEY), ...secretEntry('TRELLO_TOKEN', f.TRELLO_TOKEN), ['TRELLO_BOARDS', f.TRELLO_BOARDS.trim()]);
      if (kind) e.push(['TICKET_PROVIDER', kind]);
      // GitHub tickets almost always mean GitHub code: follow along unless the code host was chosen already.
      if (kind === 'github' && str(b.SCM_PROVIDER) === 'mock') e.push(['SCM_PROVIDER', 'github']);
      return e;
    };
    const validate = (): string | null => {
      if (!kind) return 'Pick one to continue.';
      if (kind === 'github') {
        if (!f.GITHUB_REPOS.trim()) return 'Which repository? For example acme/website.';
        if (list(f.GITHUB_REPOS).some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) return 'Write repositories as owner/name, e.g. acme/website (separate several with commas).';
        if (!f.GITHUB_TOKEN.trim() && !secretIsSet(b.GITHUB_TOKEN)) return 'Paste a GitHub access token.';
      }
      if (kind === 'jira') {
        if (!/^https?:\/\//.test(f.JIRA_BASE_URL.trim())) return 'Your Jira address should look like https://yourcompany.atlassian.net';
        if (!f.JIRA_EMAIL.includes('@')) return 'Enter the email you sign in to Jira with.';
        if (!f.JIRA_API_TOKEN.trim() && !secretIsSet(b.JIRA_API_TOKEN)) return 'Paste a Jira API token.';
        if (!f.JIRA_PROJECTS.trim()) return 'Which project? Use its short key, like KAN or WEB.';
      }
      if (kind === 'trello') {
        if (!f.TRELLO_KEY.trim() && !secretIsSet(b.TRELLO_KEY)) return 'Paste your Trello API key.';
        if (!f.TRELLO_TOKEN.trim() && !secretIsSet(b.TRELLO_TOKEN)) return 'Paste your Trello token.';
        if (!f.TRELLO_BOARDS.trim()) return 'Which board? Paste its id from the board’s address.';
      }
      return null;
    };
    const save = () => run(entries(), validate);

    return (
      <>
        {pinned ? <Locked>Your admin connected <b>{TRACKER_LABEL[current] ?? current}</b> in the server’s configuration.</Locked> : (
          <Choices value={kind} onPick={setKind} opts={[
            { v: 'github', title: 'GitHub', sub: 'Issues in a GitHub repository' },
            { v: 'jira', title: 'Jira', sub: 'Atlassian Jira Cloud' },
            { v: 'trello', title: 'Trello', sub: 'Cards on a Trello board' },
            { v: 'mock', title: 'I’m just exploring', sub: 'Practice with sample tickets. No account needed' },
          ]} />
        )}
        {kind === 'github' && <>
          <Field s={b.GITHUB_REPOS} label="Which repository?" placeholder="owner/repo, e.g. acme/website" value={f.GITHUB_REPOS} onChange={set('GITHUB_REPOS')} help="Several? Separate them with commas." />
          <SecretField s={b.GITHUB_TOKEN} label="GitHub access token" placeholder="Starts with ghp_ or github_pat_" value={f.GITHUB_TOKEN} onChange={set('GITHUB_TOKEN')} howTo={[
            <>Open <a href="https://github.com/settings/tokens/new?scopes=repo&description=Software%20Factory" target="_blank" rel="noreferrer">GitHub → Settings → Tokens</a>.</>,
            <>Tick <b>repo</b>, give it a name like “Software Factory”, and click <b>Generate token</b>.</>,
            'Copy the token and paste it here.',
          ]} />
          <CheckButton save={save} run={api.ticketPreflight} />
        </>}
        {kind === 'jira' && <>
          <Field s={b.JIRA_BASE_URL} label="Your Jira address" placeholder="https://yourcompany.atlassian.net" value={f.JIRA_BASE_URL} onChange={set('JIRA_BASE_URL')} />
          <Field s={b.JIRA_EMAIL} label="Your Jira email" placeholder="you@company.com" value={f.JIRA_EMAIL} onChange={set('JIRA_EMAIL')} />
          <SecretField s={b.JIRA_API_TOKEN} label="Jira API token" value={f.JIRA_API_TOKEN} onChange={set('JIRA_API_TOKEN')} howTo={[
            <>Open <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Atlassian → Security → API tokens</a>.</>,
            <>Click <b>Create API token</b>, name it, and copy it here.</>,
          ]} />
          <Field s={b.JIRA_PROJECTS} label="Which project?" placeholder="e.g. KAN" value={f.JIRA_PROJECTS} onChange={set('JIRA_PROJECTS')} help="The short key before each ticket number (KAN in KAN-12). Several? Separate them with commas." />
          <CheckButton save={save} run={api.ticketPreflight} />
        </>}
        {kind === 'trello' && <>
          <SecretField s={b.TRELLO_KEY} label="Trello API key" value={f.TRELLO_KEY} onChange={set('TRELLO_KEY')} howTo={[
            <>Open <a href="https://trello.com/power-ups/admin" target="_blank" rel="noreferrer">Trello → Power-Ups admin</a> and create a Power-Up (any name).</>,
            <>Under <b>API key</b>, click <b>Generate a new API key</b> and paste it here.</>,
            <>Next to it, click <b>Token</b>, allow access, and paste the token below.</>,
          ]} />
          <SecretField s={b.TRELLO_TOKEN} label="Trello token" value={f.TRELLO_TOKEN} onChange={set('TRELLO_TOKEN')} />
          <Field s={b.TRELLO_BOARDS} label="Which board?" placeholder="e.g. AbCd1234" value={f.TRELLO_BOARDS} onChange={set('TRELLO_BOARDS')} help="The code in your board’s address: trello.com/b/Ui6009UV/…" />
          <CheckButton save={save} run={api.ticketPreflight} />
        </>}
        {kind === 'mock' && <p className="ok" style={{ marginTop: 14 }}>✓ You’ll get a handful of sample tickets to practise on. Connect your real tracker any time. You’ll still connect a repository next, so the work has somewhere to go.</p>}
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 2. Code ──────────────────────────────────────────────────────────────────

export const codeQ: Question = {
  id: 'code',
  title: 'Where does your code live?',
  why: 'The factory works in a copy of your code and opens a pull request here for you to see.',
  summary: (b) => {
    const k = str(b.SCM_PROVIDER);
    if (k === 'mock' || !k) return <><b>Not connected yet</b>. Nothing can start until you add a repository</>;
    return <><b>{k === 'github' ? 'GitHub' : 'GitLab'}</b>. Pull requests open there{tokenHealth(b, k)}</>;
  },
  // No repository = nothing can start (the api refuses every dispatch), so this always needs attention.
  attention: (b) => str(b.SCM_PROVIDER) === 'mock' || !str(b.SCM_PROVIDER) || tokenNeedsFix(b, str(b.SCM_PROVIDER)),
  Body: function CodeBody({ store, actions }) {
    const b = store.byKey;
    const pinned = b.SCM_PROVIDER?.envPinned;
    // The old "practice repository" was a path on the server that a fresh install never
    // has, so a run started against it had nowhere to put code. It is no longer offered:
    // pick a real host.
    const [kind, setKind] = useState<string | null>(['github', 'gitlab'].includes(str(b.SCM_PROVIDER)) ? str(b.SCM_PROVIDER) : null);
    const [f, setF] = useState(() => ({
      GITHUB_REPOS: str(b.GITHUB_REPOS), GITHUB_TOKEN: '',
      GITLAB_BASE_URL: str(b.GITLAB_BASE_URL), GITLAB_TOKEN: '', GITLAB_REPOS: str(b.GITLAB_REPOS),
    }));
    const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
    const { busy, error, run } = useSaver(store);
    const sharesGithub = kind === 'github' && str(b.TICKET_PROVIDER) === 'github';

    const validate = (): string | null => {
      if (!kind) return 'Pick where your code lives. The factory needs a repository to put its work in.';
      if (kind === 'github' && !sharesGithub) {
        if (!f.GITHUB_REPOS.trim()) return 'Which repository? For example acme/website.';
        if (!f.GITHUB_TOKEN.trim() && !secretIsSet(b.GITHUB_TOKEN)) return 'Paste a GitHub access token.';
      }
      if (kind === 'gitlab') {
        if (!f.GITLAB_REPOS.trim()) return 'Which project? For example my-group/website.';
        if (!f.GITLAB_TOKEN.trim() && !secretIsSet(b.GITLAB_TOKEN)) return 'Paste a GitLab access token.';
      }
      return null;
    };
    const save = () => run([
      ...(kind === 'github' && !sharesGithub ? [['GITHUB_REPOS', f.GITHUB_REPOS.trim()] as [string, unknown], ...secretEntry('GITHUB_TOKEN', f.GITHUB_TOKEN)] : []),
      ...(kind === 'gitlab' ? [['GITLAB_BASE_URL', f.GITLAB_BASE_URL.trim().replace(/\/+$/, '') || 'https://gitlab.com'] as [string, unknown], ...secretEntry('GITLAB_TOKEN', f.GITLAB_TOKEN), ['GITLAB_REPOS', f.GITLAB_REPOS.trim()] as [string, unknown]] : []),
      ...(kind ? [['SCM_PROVIDER', kind] as [string, unknown]] : []),
    ], validate);

    return (
      <>
        {pinned ? <Locked /> : (
          <Choices value={kind} onPick={setKind} opts={[
            { v: 'github', title: 'GitHub', sub: sharesGithub ? 'Uses your GitHub connection above' : 'github.com or GitHub Enterprise' },
            { v: 'gitlab', title: 'GitLab', sub: 'gitlab.com or your own GitLab' },
          ]} />
        )}
        {kind === 'github' && !sharesGithub && <>
          <Field s={b.GITHUB_REPOS} label="Which repository?" placeholder="owner/repo, e.g. acme/website" value={f.GITHUB_REPOS} onChange={set('GITHUB_REPOS')} />
          <SecretField s={b.GITHUB_TOKEN} label="GitHub access token" placeholder="Starts with ghp_ or github_pat_" value={f.GITHUB_TOKEN} onChange={set('GITHUB_TOKEN')} howTo={[
            <>Open <a href="https://github.com/settings/tokens/new?scopes=repo&description=Software%20Factory" target="_blank" rel="noreferrer">GitHub → Settings → Tokens</a>.</>,
            <>Tick <b>repo</b> and click <b>Generate token</b>. Paste it here.</>,
          ]} />
        </>}
        {kind === 'gitlab' && <>
          <Field s={b.GITLAB_BASE_URL} label="GitLab address" placeholder="https://gitlab.com" value={f.GITLAB_BASE_URL} onChange={set('GITLAB_BASE_URL')} help="Leave as gitlab.com unless your company runs its own." />
          <Field s={b.GITLAB_REPOS} label="Which project?" placeholder="group/project, e.g. acme/website" value={f.GITLAB_REPOS} onChange={set('GITLAB_REPOS')} />
          <SecretField s={b.GITLAB_TOKEN} label="GitLab access token" placeholder="Starts with glpat-" value={f.GITLAB_TOKEN} onChange={set('GITLAB_TOKEN')} howTo={[
            <>In GitLab open <b>Preferences → Access tokens</b>.</>,
            <>Add a token with the <b>api</b> scope. You need Developer access or higher on the project.</>,
            'Copy it and paste it here.',
          ]} />
        </>}
        {kind && <CheckButton save={save} run={api.scmPreflight} />}
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 3. AI ────────────────────────────────────────────────────────────────────

const AI_LABEL: Record<string, string> = { 'oauth-token': 'Claude subscription', 'api-key': 'Claude API key', vertex: 'Claude on Google Cloud (Vertex AI)', bedrock: 'Claude on AWS Bedrock', openai: 'ChatGPT / OpenAI API key' };

/** The choice on screen: a Claude auth mode, or 'openai' (the whole team on Codex + GPT). */
type AiChoice = 'oauth-token' | 'api-key' | 'vertex' | 'openai';

const OPENAI_STEPS: ReactNode[] = [
  <>Go to <a href="https://platform.openai.com/signup" target="_blank" rel="noreferrer">platform.openai.com</a> and sign in, or create a free account. This is separate from a ChatGPT subscription.</>,
  <>Add credit: open <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">Settings → Billing</a> and add a payment method or prepaid credit. $10–20 is plenty to start.</>,
  <>Make a project just for this: open <a href="https://platform.openai.com/settings/organization/projects" target="_blank" rel="noreferrer">Settings → Projects</a> → <b>Create project</b>, and name it “Software Factory”. Under the project’s <b>Limits</b> you can set a monthly budget so it can never spend more than you expect.</>,
  <>In that project open <b>API keys</b> → <b>Create new secret key</b>. For <b>Owned by</b> choose <b>Service account</b> (the key keeps working if you leave the company, and it only touches this project). Name it “Software Factory”.</>,
  'Copy the key (it starts with sk-) and paste it below. OpenAI only shows it once.',
];

export const aiQ: Question = {
  id: 'ai',
  title: 'Which AI should do the work?',
  why: 'Pick what your company already pays for.',
  tipNote: 'Claude on Google Cloud uses the Google login of the computer running the factory (gcloud auth application-default login); docs/VERTEX.md. Bedrock is set up in .env only (AGENT_AUTH_MODE=bedrock). A Claude subscription is for one person’s own use (docs/CLAUDE_USAGE.md). Choosing ChatGPT / OpenAI runs every step on Codex with GPT models; you can still pick per ticket when you send it.',
  summary: (b) => {
    // M11 WP5: roles on different AIs (per-role picker) read as the mix, not just the implementer's.
    const ais = teamAis((k) => b[k]?.value, catalogueCache);
    if (ais.length > 1) return <><b>Mixed: {ais.join(' + ')}</b> · each job’s AI is under <b>Which AI model does each job?</b></>;
    if (detectTeamAi((k) => b[k]?.value) === 'openai') {
      return <><b>{AI_LABEL.openai}</b>{!secretIsSet(b.OPENAI_API_KEY) && <span className="warn"> · no key saved yet</span>}</>;
    }
    const m = str(b.AGENT_AUTH_MODE);
    const key = m === 'oauth-token' ? b.CLAUDE_CODE_OAUTH_TOKEN : m === 'api-key' ? b.ANTHROPIC_API_KEY : undefined;
    if (m === 'vertex') {
      return <><b>{AI_LABEL.vertex}</b>{str(b.ANTHROPIC_VERTEX_PROJECT_ID)
        ? <> · project {str(b.ANTHROPIC_VERTEX_PROJECT_ID)} ({str(b.CLOUD_ML_REGION) || 'global'})</>
        : <span className="warn"> · no project set yet</span>}</>;
    }
    return <><b>{AI_LABEL[m] ?? m}</b>{key && !secretIsSet(key) && <span className="warn"> · no key saved yet</span>}
      {subscriptionSharingWarning(m, str(b.AUTH_MODE)) && <span className="warn"> · shared subscription (see Anthropic’s terms)</span>}
      {m === 'oauth-token' && <HealthNote s={b.CLAUDE_CODE_OAUTH_TOKEN} name="Claude subscription token" />}</>;
  },
  attention: (b) => {
    if (detectTeamAi((k) => b[k]?.value) === 'openai') return !secretIsSet(b.OPENAI_API_KEY);
    const m = str(b.AGENT_AUTH_MODE);
    const key = m === 'oauth-token' ? b.CLAUDE_CODE_OAUTH_TOKEN : m === 'api-key' ? b.ANTHROPIC_API_KEY : undefined;
    if (m === 'vertex') return !str(b.ANTHROPIC_VERTEX_PROJECT_ID);
    return (!!key && (!secretIsSet(key) || needsFix(key))) || !!subscriptionSharingWarning(m, str(b.AUTH_MODE));
  },
  Body: function AiBody({ store, actions }) {
    const b = store.byKey;
    const get = (k: string) => b[k]?.value;
    const onOpenai = detectTeamAi(get) === 'openai';
    const models = useCatalogue();
    const current = str(b.AGENT_AUTH_MODE);
    const envOnly = !onOpenai && current === 'bedrock';
    const [choice, setChoice] = useState<AiChoice>(onOpenai ? 'openai' : (current as AiChoice));
    const [secret, setSecret] = useState('');
    const [vdraft, setVdraft] = useState<VertexDraft>(() => initialVertexDraft(b));
    const { busy, error, run } = useSaver(store);
    const locked = !!b.AGENT_AUTH_MODE?.envPinned || envOnly;
    const save = () => {
      if (choice === 'vertex') {
        const savedOk = current === 'vertex' && !onOpenai && vdraft.projectId.trim() === str(b.ANTHROPIC_VERTEX_PROJECT_ID)
          && (vdraft.region.trim() || 'global') === (str(b.CLOUD_ML_REGION) || 'global') && !!str(b.MODEL_ALLOWLIST);
        // The roles land on the ticked models: the catalogue they're checked against is exactly those.
        const narrowed = vdraft.selected.map((id) => models.find((m) => m.id === id) ?? MODELS.find((m) => m.id === id) ?? { id, tier: vertexTier(id), runtimes: ['claude-code'] });
        return run([...vertexWrites({ projectId: vdraft.projectId, region: vdraft.region, selected: vdraft.selected, existingExtra: b.MODEL_CATALOG_EXTRA?.value }),
          ...teamAiWrites('claude', get, narrowed)], () => vertexDraftProblem(vdraft, savedOk));
      }
      // Leaving Claude on Google Cloud: its model list (Vertex ids) no longer applies, so
      // clear it and move every role off a Vertex-only id onto a built-in model.
      const leavingVertex = current === 'vertex' && !onOpenai;
      const leave: [string, unknown][] = leavingVertex ? [['MODEL_ALLOWLIST', '']] : [];
      const pool = leavingVertex ? MODELS : models;
      if (choice === 'openai') {
        return run([...secretEntry('OPENAI_API_KEY', secret), ['AGENT_AUTH_OPENAI_MODE', 'api-key'], ...leave, ...teamAiWrites('openai', get, pool)],
          () => (!secret.trim() && !secretIsSet(b.OPENAI_API_KEY) ? 'Paste your OpenAI API key.' : secret.trim() && !secret.trim().startsWith('sk-') ? 'That doesn’t look like an OpenAI key. It starts with sk-.' : null));
      }
      const credKey = choice === 'oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
      return run([...secretEntry(credKey, secret), ['AGENT_AUTH_MODE', choice], ...leave, ...teamAiWrites('claude', get, pool)],
        () => (!envOnly && !secret.trim() && !secretIsSet(b[credKey]) ? (choice === 'oauth-token' ? 'Paste your subscription token.' : 'Paste your API key.') : null));
    };
    return (
      <>
        {locked && choice !== 'openai' ? <Locked>Your admin set this up as <b>{AI_LABEL[current] ?? current}</b> in the server’s configuration.</Locked> : (
          <Choices value={choice} onPick={(v) => { setChoice(v); setSecret(''); }} opts={[
            { v: 'api-key', title: 'Claude API key', sub: 'Recommended. Pay only for what you use, with a cost for every job' },
            { v: 'oauth-token', title: 'Claude subscription', sub: 'Your own Pro or Max plan, for your personal use only' },
            { v: 'vertex', title: 'Claude on Google Cloud', sub: 'Your company’s Vertex AI project, billed to Google Cloud' },
            { v: 'openai', title: 'ChatGPT / OpenAI', sub: 'An OpenAI API key. Pay only for what you use' },
          ]} />
        )}
        {!locked && choice === 'oauth-token' && (
          <SecretField s={b.CLAUDE_CODE_OAUTH_TOKEN} label="Subscription token" placeholder="Starts with sk-ant-oat" value={secret} onChange={setSecret} howTo={[
            <>On any computer with Claude Code installed, run <span className="mono">claude setup-token</span>.</>,
            'Approve access in the browser window that opens.',
            'Paste the token it prints here. It lasts about a year.',
          ]} />
        )}
        {!locked && choice === 'oauth-token' && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Use your own subscription, for work you run yourself. Anthropic’s terms don’t allow one subscription to be shared
            by several people, and plan limits assume ordinary, individual use. If others use this factory too, choose an API key.{' '}
            <a href={CLAUDE_USAGE_DOC_URL} target="_blank" rel="noreferrer">Why</a> ·{' '}
            <a href={CLAUDE_TERMS_URL} target="_blank" rel="noreferrer">Anthropic’s terms</a>
          </p>
        )}
        {choice === 'oauth-token' && subscriptionSharingWarning(current, str(b.AUTH_MODE)) && (
          <p className="warn small" style={{ marginTop: 8 }}>⚠ {subscriptionSharingWarning(current, str(b.AUTH_MODE))}</p>
        )}
        {!locked && choice === 'api-key' && (
          <SecretField s={b.ANTHROPIC_API_KEY} label="Anthropic API key" placeholder="Starts with sk-ant-api" value={secret} onChange={setSecret} howTo={[
            <>Open <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console → API keys</a>.</>,
            <>Click <b>Create key</b> and paste it here.</>,
          ]} />
        )}
        {!locked && choice === 'vertex' && <VertexSetup b={b} draft={vdraft} setDraft={setVdraft} />}
        {choice === 'openai' && <>
          <SecretField s={b.OPENAI_API_KEY} label="OpenAI API key" placeholder="Starts with sk-" value={secret} onChange={setSecret} howTo={OPENAI_STEPS} />
          <p className="muted small" style={{ marginTop: 8 }}>
            Every step (planning, coding, testing and review) will run on OpenAI: GPT-6 Astra plans and writes the code, GPT-6 Sol tests and reviews.
            You can change the models under <b>Which AI model does each job?</b>
          </p>
          <CheckButton save={save} run={api.openaiCheck} />
        </>}
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 4. Approvals ─────────────────────────────────────────────────────────────

const PRESET_TEXT: Record<ApprovalPreset, { title: string; sub: string }> = {
  'every-step': { title: 'At every step', sub: 'Planning, coding, testing, review and merge each wait for you. Good for your first week.' },
  'start-and-end': { title: 'Before it starts, and before it merges', sub: 'You approve the plan and the finished change. Everything in between just runs.' },
  'end-only': { title: 'Only before it merges', sub: 'It goes straight to a finished change for you to approve. Fastest.' },
};
const STEP_LABEL: Record<PipelineStage, string> = {
  plan: 'Plan the approach', implement: 'Write the code', test: 'Test it', review: 'Review it', create_mr: 'Open the pull request', merge: 'Merge it',
};
const GATE_LABEL = [
  { v: 'required', label: 'Wait for me' },
  { v: 'notify', label: 'Tell me' },
  { v: 'auto', label: 'Just go' },
] as const;

export const approvalsQ: Question = {
  id: 'approvals',
  title: 'When should it check with you?',
  why: 'An AI team plans, writes, tests and reviews each change. You choose where it stops and waits for a person. You can always stop a run.',
  tipNote: 'Stored as the org setting PIPELINE_STAGES. It can’t be set from .env, so relaxing the check before merge is always a deliberate choice made here.',
  summary: (b) => {
    const st = b.PIPELINE_STAGES?.value as never;
    const p = detectApprovalPreset(st);
    const merges = effectiveStages(st).merge.enabled;
    return <><b>{p === 'custom' ? 'Your own step-by-step choices' : PRESET_TEXT[p].title}</b>{!merges && ' · a person merges'}</>;
  },
  Body: function ApprovalsBody({ store, actions, firstRun }) {
    const stored = store.byKey.PIPELINE_STAGES?.value as never;
    const detected = detectApprovalPreset(stored);
    const [choice, setChoice] = useState<ApprovalPreset | 'custom'>(firstRun && detected === 'every-step' && unanswered(store.byKey.PIPELINE_STAGES) ? 'start-and-end' : detected);
    const [stages, setStages] = useState<Record<PipelineStage, StageConfig>>(() => effectiveStages(stored));
    const { busy, error, run } = useSaver(store);
    const merges = stages.merge.enabled;

    const pick = (v: ApprovalPreset | 'custom') => {
      setChoice(v);
      if (v !== 'custom') setStages(applyApprovalPreset(stages, v));
    };
    const setStage = (k: PipelineStage, patch: Partial<StageConfig>) => { setChoice('custom'); setStages((s) => ({ ...s, [k]: { ...s[k], ...patch } })); };

    const save = async () => {
      const next = choice === 'custom' ? stages : applyApprovalPreset(stages, choice);
      const ok = await run([['PIPELINE_STAGES', next]]);
      if (ok) setupFlags.markPipelineReviewed();
      return ok;
    };

    return (
      <>
        <Choices column value={choice} onPick={pick} opts={[
          { v: 'every-step', ...PRESET_TEXT['every-step'] },
          { v: 'start-and-end', ...PRESET_TEXT['start-and-end'], badge: 'Recommended' },
          { v: 'end-only', ...PRESET_TEXT['end-only'] },
          { v: 'custom', title: 'Let me choose step by step', sub: 'For each step: wait for me, tell me and keep going, or just go.' },
        ]} />
        {choice === 'custom' && (
          <div className="steps">
            {PIPELINE_STAGES.filter((k) => k !== 'merge' || merges).map((k) => {
              const c = stages[k];
              const canSkip = k === 'plan' || k === 'test' || k === 'review' || (k === 'create_mr' && !merges);
              return (
                <div className="step-row" key={k}>
                  <span className={c.enabled ? '' : 'muted'}>{STEP_LABEL[k]}</span>
                  <div className="seg" role="radiogroup" aria-label={STEP_LABEL[k]}>
                    {GATE_LABEL.map((g) => (
                      <button type="button" key={g.v} className={c.enabled && c.gate === g.v ? 'on' : ''} onClick={() => setStage(k, { enabled: true, gate: g.v })}>{g.label}</button>
                    ))}
                    {canSkip && <button type="button" className={!c.enabled ? 'on' : ''} onClick={() => setStage(k, { enabled: false })}>Skip</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="sub-q">
          <div className="lbl">Who merges the finished change?</div>
          <Choices value={merges ? 'factory' : 'person'} onPick={(v) => setStages(setFactoryMerges(stages, v === 'factory'))} opts={[
            { v: 'factory', title: 'The factory', sub: 'After you approve it, as above' },
            { v: 'person', title: 'A person, in GitHub/GitLab', sub: 'The factory stops at a ready pull request' },
          ]} />
        </div>
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 5. Spending ──────────────────────────────────────────────────────────────

const money = (n: number) => `$${n.toLocaleString()}`;

export const spendingQ: Question = {
  id: 'spending',
  title: 'How much can it spend?',
  why: 'A typical ticket costs $1–5. A ticket that reaches its limit stops and waits for you.',
  tipNote: 'ORG_MONTHLY_BUDGET_USD=0 means no monthly limit.',
  summary: (b) => {
    const per = Number(b.ORG_MAX_COST_USD?.value ?? 0), mo = Number(b.ORG_MONTHLY_BUDGET_USD?.value ?? 0);
    return <>Up to <b>{money(per)} a ticket</b> · {mo > 0 ? <b>{money(mo)} a month</b> : <b className="warn">no monthly limit</b>}</>;
  },
  attention: (b) => Number(b.ORG_MONTHLY_BUDGET_USD?.value ?? 0) === 0,
  Body: function SpendingBody({ store, actions, firstRun }) {
    const b = store.byKey;
    const pinned = b.ORG_MAX_COST_USD?.envPinned || b.ORG_MONTHLY_BUDGET_USD?.envPinned;
    const detected = detectBudgetPreset(b.ORG_MAX_COST_USD?.value, b.ORG_MONTHLY_BUDGET_USD?.value);
    const [choice, setChoice] = useState<string>(firstRun && detected === 'custom' && unanswered(b.ORG_MAX_COST_USD) && unanswered(b.ORG_MONTHLY_BUDGET_USD) ? 'standard' : detected);
    const [per, setPer] = useState(str(b.ORG_MAX_COST_USD));
    const [mo, setMo] = useState(Number(b.ORG_MONTHLY_BUDGET_USD?.value ?? 0) > 0 ? str(b.ORG_MONTHLY_BUDGET_USD) : '');
    const [spent, setSpent] = useState<number | null>(null);
    useEffect(() => { api.fleet().then((f) => setSpent(f.monthCostUsd)).catch(() => {}); }, []);
    const { busy, error, run } = useSaver(store);

    const save = () => {
      const p = choice === 'custom' ? { perTicket: Number(per), monthly: mo.trim() ? Number(mo) : 0 } : BUDGET_PRESETS[choice as keyof typeof BUDGET_PRESETS];
      return run([['ORG_MAX_COST_USD', p.perTicket], ['ORG_MONTHLY_BUDGET_USD', p.monthly]], () =>
        !(p.perTicket > 0) ? 'Set a per-ticket limit above $0.' : p.monthly < 0 || Number.isNaN(p.monthly) ? 'The monthly limit must be a number (leave it blank for none).' : null);
    };
    return (
      <>
        {pinned && <Locked>Your admin set spending limits in the server’s configuration.</Locked>}
        {!pinned && <Choices value={choice} onPick={setChoice} opts={[
          { v: 'small', title: `Up to ${money(10)} a ticket`, sub: `and ${money(200)} a month` },
          { v: 'standard', title: `Up to ${money(25)} a ticket`, sub: `and ${money(500)} a month` },
          { v: 'custom', title: 'I’ll set my own', sub: 'Any amount' },
        ]} />}
        {!pinned && choice === 'custom' && (
          <div className="inline">
            <span>Stop a ticket at $</span><input type="number" min={1} value={per} onChange={(e) => setPer(e.target.value)} />
            <span>and stop new work after $</span><input type="number" min={0} value={mo} placeholder="no limit" onChange={(e) => setMo(e.target.value)} /><span>a month.</span>
          </div>
        )}
        {spent != null && <p className="muted small" style={{ marginTop: 12 }}>Spent so far this month: {money(Math.round(spent * 100) / 100)}.</p>}
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 6. Models ────────────────────────────────────────────────────────────────

const ROLES = [
  { role: 'PLANNER', label: 'Plans the approach' },
  { role: 'IMPLEMENTER', label: 'Writes the code' },
  { role: 'TESTER', label: 'Tests it' },
  { role: 'REVIEWER', label: 'Reviews it' },
] as const;
const EFFORT_LABEL: Record<string, string> = { low: 'Quick', medium: 'Normal', high: 'Thorough', xhigh: 'Very thorough', max: 'As hard as it can' };
const TIER_LABEL: Record<string, string> = { fast: 'Fastest', balanced: 'Balanced', max: 'Most capable' };
type CatalogueModel = { id: string; label: string; tier: string; runtimes: string[]; providerId?: string };
// The factory's runnable models (GET /api/models: built-ins + MODEL_CATALOG_EXTRA,
// narrowed to MODEL_ALLOWLIST). Starts as the built-in list so the first paint
// works; useCatalogue() swaps in the server's answer. Module-level so the
// collapsed-row summaries (plain functions, no hooks) read the same list.
let catalogueCache: CatalogueModel[] = MODELS;
function useCatalogue(): CatalogueModel[] {
  const [models, setModels] = useState<CatalogueModel[]>(catalogueCache);
  useEffect(() => {
    let live = true;
    const on = () => { if (live) setModels(catalogueCache); };
    catalogueListeners.add(on);
    api.models().then((r) => { catalogueCache = r.models; on(); }).catch(() => { /* keep the built-ins */ });
    return () => { live = false; catalogueListeners.delete(on); };
  }, []);
  return models;
}
/** Re-read the catalogue everywhere (after the Ollama question adds models). */
const catalogueListeners = new Set<() => void>();
function refreshCatalogue(): Promise<void> {
  return api.models().then((r) => { catalogueCache = r.models; catalogueListeners.forEach((f) => f()); }).catch(() => {});
}
const modelLabel = (id: string) => {
  const m = catalogueCache.find((x) => x.id === id);
  if (!m) return id;
  const g = modelGroup(m);
  if (g === 'Ollama on your computer' || g === 'Ollama Cloud') return `${m.id.replace(/^ollama(-cloud)?:/, '')} (free)`;
  return `${TIER_LABEL[m.tier] ?? m.tier} (${m.label.split(' — ')[0]})`;
};

export const modelsQ: Question = {
  id: 'models',
  title: 'Which AI model does each job?',
  why: 'Stronger models do better work on hard tickets, but cost more and take longer. You can still change this for a single ticket when you send it.',
  summary: (b) => {
    const tiers = ROLES.map((r) => { const id = str(b[`MODEL_DEFAULT_${r.role}`]); return catalogueCache.find((m) => m.id === id)?.tier ?? (id || '?'); });
    const ais = teamAis((k) => b[k]?.value, catalogueCache);
    if (ais.length > 1) return <>{ROLES.map((r) => `${r.label.toLowerCase()}: ${modelLabel(str(b[`MODEL_DEFAULT_${r.role}`]))}`).join(' · ')}</>;
    const plan = TIER_LABEL[tiers[0]] ?? tiers[0], rest = TIER_LABEL[tiers[2]] ?? tiers[2];
    return tiers[0] === tiers[1] && tiers[2] === tiers[3]
      ? <><b>{plan}</b> plans and writes code · <b>{rest}</b> tests and reviews</>
      : <>{ROLES.map((r, i) => `${r.label.toLowerCase()}: ${TIER_LABEL[tiers[i]] ?? tiers[i]}`).join(' · ')}</>;
  },
  Body: function ModelsBody({ store, actions }) {
    const b = store.byKey;
    const models = useCatalogue();
    const [d, setD] = useState<Record<string, string>>(() => Object.fromEntries(ROLES.flatMap((r) => [[`MODEL_DEFAULT_${r.role}`, str(b[`MODEL_DEFAULT_${r.role}`])], [`EFFORT_DEFAULT_${r.role}`, str(b[`EFFORT_DEFAULT_${r.role}`])], [`RUNTIME_DEFAULT_${r.role}`, str(b[`RUNTIME_DEFAULT_${r.role}`])]])));
    // M11 WP5: every model, grouped by the AI it runs on; picking one moves the role to a
    // runtime that can drive it (an Ollama model keeps claude-code; a GPT model, Codex).
    const pick = (role: string, id: string) => {
      const rk = `RUNTIME_DEFAULT_${role}`;
      const rt = b[rk]?.envPinned ? null : runtimeForPick(models.find((m) => m.id === id), d[rk] ?? '');
      setD({ ...d, [`MODEL_DEFAULT_${role}`]: id, ...(rt ? { [rk]: rt } : {}) });
    };
    const groups = MODEL_GROUPS.map((g) => ({ g, ms: models.filter((m) => modelGroup(m) === g) })).filter((x) => x.ms.length);
    const { busy, error, run } = useSaver(store);
    const save = () => run(Object.entries(d).filter(([k, v]) => v !== str(b[k])));
    return (
      <>
        <table className="mini"><tbody>
          <tr className="muted small"><td /><td>Model</td><td>How hard should it think?</td></tr>
          {ROLES.map((r) => {
            const mk = `MODEL_DEFAULT_${r.role}`, ek = `EFFORT_DEFAULT_${r.role}`;
            return (
              <tr key={r.role}>
                <td>{r.label}</td>
                <td><select value={d[mk]} disabled={b[mk]?.envPinned} onChange={(e) => pick(r.role, e.target.value)}>
                  {!models.some((m) => m.id === d[mk]) && <option value={d[mk]}>{d[mk] ? `${d[mk]} (not available)` : 'Choose a model'}</option>}
                  {groups.map(({ g, ms }) => (
                    <optgroup key={g} label={g}>{ms.map((m) => <option key={m.id} value={m.id}>{modelLabel(m.id)}</option>)}</optgroup>
                  ))}
                </select></td>
                <td><select value={d[ek]} disabled={b[ek]?.envPinned} onChange={(e) => setD({ ...d, [ek]: e.target.value })}>
                  {(b[ek]?.values ?? []).map((v) => <option key={v} value={v}>{EFFORT_LABEL[v] ?? v}</option>)}
                </select></td>
              </tr>
            );
          })}
        </tbody></table>
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 6b. Ollama (M11 WP5) ─────────────────────────────────────────────────────

const isOllama = (m: CatalogueModel) => { const g = modelGroup(m); return g === 'Ollama on your computer' || g === 'Ollama Cloud'; };

/** The collapsed row's answer. A component, not a plain read of catalogueCache: the row
 *  renders before anything has fetched /api/models, and the cache alone never re-renders it. */
function OllamaSummary({ b }: { b: ByKey }) {
  const n = useCatalogue().filter(isOllama).length;
  const where = [str(b.OLLAMA_BASE_URL) && `server at ${str(b.OLLAMA_BASE_URL)}`, secretIsSet(b.OLLAMA_API_KEY) && 'Ollama Cloud key saved'].filter(Boolean).join(' · ');
  if (!where && !n) return <span className="muted">Not set up</span>;
  return <><b>{n ? `${n} model${n === 1 ? '' : 's'} added` : 'No models added yet'}</b>{where && <> · {where}</>}</>;
}

export const ollamaQ: Question = {
  id: 'ollama',
  title: 'Use free models with Ollama?',
  why: 'Ollama runs open models on your own computer, or on Ollama Cloud. Jobs on them cost nothing. They are slower and less capable than Claude, so they suit simple tickets or one job (such as writing the code) in a mixed team.',
  tipNote: 'Local: Ollama 0.14.0 or newer, listening on all interfaces (OLLAMA_HOST=0.0.0.0). From the bundled containers the address is http://host.docker.internal:11434. Models need tool calling and 64k of context. Cloud keys only ever go to https://ollama.com. docs/OLLAMA.md',
  summary: (b) => <OllamaSummary b={b} />,
  Body: function OllamaBody({ store, actions }) {
    const b = store.byKey;
    const models = useCatalogue();
    const have = models.map((m) => m.id);
    const [url, setUrl] = useState(str(b.OLLAMA_BASE_URL));
    const [key, setKey] = useState('');
    const [mins, setMins] = useState(Number(b.RUN_MAX_MINUTES?.value ?? 0) > 0 ? str(b.RUN_MAX_MINUTES) : '');
    const [draft, setDraft] = useState<OllamaDraft>(emptyOllamaDraft);
    const { busy, error, setError, run } = useSaver(store);
    const [note, setNote] = useState<string | null>(null);
    const urlProblem = () => (url.trim() && !/^https?:\/\/[^\s/]+/.test(url.trim()) ? 'The server address starts with http:// (for example http://host.docker.internal:11434).' : null);
    const saveConnection = () => run([
      ...(url.trim() !== str(b.OLLAMA_BASE_URL) ? [['OLLAMA_BASE_URL', url.trim() || null] as [string, unknown]] : []),
      ...secretEntry('OLLAMA_API_KEY', key),
      ...((mins.trim() ? Number(mins) : 0) !== Number(b.RUN_MAX_MINUTES?.value ?? 0) ? [['RUN_MAX_MINUTES', mins.trim() ? Number(mins) : 0] as [string, unknown]] : []),
    ], () => urlProblem() ?? (mins.trim() && !(Number(mins) >= 0) ? 'The time limit is a number of minutes (leave it blank for none).' : null));
    const save = async (): Promise<boolean> => {
      if (!(await saveConnection())) return false;
      const picked = Object.values(draft.picked).filter((m) => !have.includes(m.id));
      if (!picked.length) return true;
      const r = await api.ollamaCatalogue(picked);
      if (r.status !== 200) { setError(r.body.reason ?? `Couldn’t add the models (${r.status}).`); return false; }
      const ids = picked.map((m) => m.id);
      const allow = allowlistWith(b.MODEL_ALLOWLIST?.value, ids);
      if (allow && b.MODEL_ALLOWLIST?.envPinned) setNote(`Added. Your admin limits the factory’s models in .env (MODEL_ALLOWLIST), so add ${ids.join(', ')} there too.`);
      else if (allow && !(await run([['MODEL_ALLOWLIST', allow]]))) return false;
      store.reload();
      await refreshCatalogue();
      setDraft(emptyOllamaDraft());
      return true;
    };
    const cloudSet = secretIsSet(b.OLLAMA_API_KEY) || !!key.trim();
    return (
      <>
        <h4 style={{ margin: '4px 0' }}>On your own computer</h4>
        <Field s={b.OLLAMA_BASE_URL} label="Ollama server address" placeholder="http://host.docker.internal:11434" value={url} onChange={setUrl}
          help={<>Install Ollama from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com</a>, pull a model that can use tools (e.g. <span className="mono">ollama pull qwen3-coder</span>), and start it with <span className="mono">OLLAMA_HOST=0.0.0.0</span> so the factory can reach it. Leave blank if you only use Ollama Cloud.</>} />
        {(url.trim() || str(b.OLLAMA_BASE_URL)) && <OllamaModels source="local" inCatalogue={have} draft={draft} setDraft={setDraft} beforeList={saveConnection} />}

        <h4 style={{ margin: '18px 0 4px' }}>On Ollama Cloud</h4>
        <SecretField s={b.OLLAMA_API_KEY} label="Ollama Cloud key" placeholder="Paste your key" value={key} onChange={setKey} howTo={[
          <>Sign in at <a href="https://ollama.com" target="_blank" rel="noreferrer">ollama.com</a> (the free plan includes models such as gpt-oss:120b).</>,
          <>Open <a href="https://ollama.com/settings/keys" target="_blank" rel="noreferrer">Settings → Keys</a>, click <b>Add key</b>, and paste it here.</>,
        ]} />
        {cloudSet && <OllamaModels source="cloud" inCatalogue={have} draft={draft} setDraft={setDraft} beforeList={saveConnection} />}
        {cloudSet && <p className="muted small">Ollama Cloud use is free in ASF’s spend, but your plan has hourly and weekly limits: see them on <a href={OLLAMA_CLOUD_USAGE_URL} target="_blank" rel="noreferrer">your Ollama account</a>.</p>}

        <h4 style={{ margin: '18px 0 4px' }}>Time limit</h4>
        <div className="inline">
          <span>Stop a ticket after its AI has worked</span>
          <input type="number" min={0} value={b.RUN_MAX_MINUTES?.envPinned ? str(b.RUN_MAX_MINUTES) : mins} disabled={b.RUN_MAX_MINUTES?.envPinned} placeholder="no limit" style={{ width: 90 }} onChange={(e) => setMins(e.target.value)} />
          <span>minutes.</span>
        </div>
        <p className="muted small">Ollama jobs cost nothing, so the spending limit never stops one, and a slow model can work for hours. 180 minutes is a good limit. Time waiting for you doesn’t count.</p>

        <p className="muted small" style={{ marginTop: 10 }}>
          Tick a model to check it: it must call tools, answer, and have at least 64k of context. Ticked models are added on Save, at no cost.
          Then choose which job uses them under <b>Which AI model does each job?</b>, or pick one for a single ticket when you send it.
        </p>
        {note && <p className="warn small">{note}</p>}
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 7. Board ─────────────────────────────────────────────────────────────────

const firstOf = (s: string) => list(s)[0] ?? '';

export const boardQ: Question = {
  id: 'board',
  title: 'Should it move tickets on your board?',
  why: 'As the work happens, the factory can move each ticket into the matching column.',
  tipNote: 'Each status accepts several comma-separated names; the first one your board has is used. Blank = don’t move.',
  summary: (b) => {
    const cols = [b.TICKET_STATUS_INPROGRESS, b.TICKET_STATUS_INREVIEW, b.TICKET_STATUS_DONE].map((s) => firstOf(str(s)));
    const assignee = str(b.TICKET_ASSIGNEE);
    return <>{cols.every((c) => !c) ? <b>No, tickets stay put</b> : <><b>Yes</b>: {cols.filter(Boolean).join(' → ')}</>}{assignee && ` · assigned to ${assignee}`}</>;
  },
  Body: function BoardBody({ store, actions }) {
    const b = store.byKey;
    const keys = ['TICKET_STATUS_INPROGRESS', 'TICKET_STATUS_INREVIEW', 'TICKET_STATUS_DONE'] as const;
    const allBlank = keys.every((k) => !str(b[k]));
    const [move, setMove] = useState(allBlank ? 'no' : 'yes');
    const [cols, setCols] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, str(b[k]) || String(b[k]?.default ?? '')])));
    const [assignee, setAssignee] = useState(str(b.TICKET_ASSIGNEE));
    const { busy, error, run } = useSaver(store);
    const save = () => run([
      ...keys.map((k) => [k, move === 'no' ? '' : cols[k].trim() === String(b[k]?.default ?? '') ? null : cols[k].trim()] as [string, unknown]),
      ['TICKET_ASSIGNEE', assignee.trim()],
    ]);
    const colLabel: Record<string, string> = { TICKET_STATUS_INPROGRESS: 'When work starts', TICKET_STATUS_INREVIEW: 'When the change is ready for review', TICKET_STATUS_DONE: 'When it’s merged' };
    return (
      <>
        <Choices value={move} onPick={setMove} opts={[
          { v: 'yes', title: 'Yes, move them', sub: 'Uses your board’s own column names' },
          { v: 'no', title: 'No, leave them', sub: 'Your team moves tickets by hand' },
        ]} />
        {move === 'yes' && keys.map((k) => (
          <Field key={k} s={b[k]} label={colLabel[k]} value={cols[k]} onChange={(v) => setCols({ ...cols, [k]: v })}
            help={k === 'TICKET_STATUS_INPROGRESS' ? 'Column name. If your boards differ, list a few separated by commas; the first match is used.' : undefined} />
        ))}
        <Field s={b.TICKET_ASSIGNEE} label="Assign tickets to (optional)" placeholder="e.g. the factory’s own account" value={assignee} onChange={setAssignee}
          help="A username (GitHub) or account id (Jira). Leave blank to not assign." />
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 8. Guidance ──────────────────────────────────────────────────────────────

export const guidanceQ: Question = {
  id: 'guidance',
  title: 'Anything your AI team should always know?',
  why: 'House rules added to every ticket, like “use TypeScript”, “never touch the billing folder”, or “write tests with Jest”.',
  summary: (b) => {
    const n = ROLES.filter((r) => str(b[`ROLE_SKILL_${r.role}`]).trim()).length;
    return n === 0 ? <><b>Nothing extra</b></> : <><b>House rules</b> for {n} of 4 jobs</>;
  },
  Body: function GuidanceBody({ store, actions }) {
    const b = store.byKey;
    const [d, setD] = useState<Record<string, string>>(() => Object.fromEntries(ROLES.map((r) => [`ROLE_SKILL_${r.role}`, str(b[`ROLE_SKILL_${r.role}`])])));
    const { busy, error, run } = useSaver(store);
    const save = () => run(Object.entries(d).filter(([k, v]) => v !== str(b[k])).map(([k, v]) => [k, v.trim() ? v : null]));
    const verb: Record<string, string> = { PLANNER: 'When planning', IMPLEMENTER: 'When writing code', TESTER: 'When testing', REVIEWER: 'When reviewing' };
    return (
      <>
        {ROLES.map((r) => {
          const k = `ROLE_SKILL_${r.role}`;
          return <Field key={k} s={b[k]} multiline label={verb[r.role]} value={d[k]} onChange={(v) => setD({ ...d, [k]: v })} placeholder="Optional" />;
        })}
        {actions({ save, busy, error })}
      </>
    );
  },
};

// ── 9. Alerts ────────────────────────────────────────────────────────────────

export const alertsQ: Question = {
  id: 'alerts',
  title: 'How should we reach you?',
  why: 'We let you know when something needs you: a plan to approve, a question, or a finished change.',
  tipNote: 'Telegram also needs TELEGRAM_BOT_TOKEN, which is set in .env only.',
  summary: (b) => {
    const tg = list(str(b.NOTIFY_SINKS)).includes('telegram');
    return <><b>In the app</b> (the bell){tg && <> and <b>Telegram</b></>}</>;
  },
  Body: function AlertsBody({ store, actions }) {
    const b = store.byKey;
    const botReady = secretIsSet(b.TELEGRAM_BOT_TOKEN);
    const [tg, setTg] = useState(list(str(b.NOTIFY_SINKS)).includes('telegram') ? 'yes' : 'no');
    const [chat, setChat] = useState(str(b.TELEGRAM_CHAT_ID));
    const [base, setBase] = useState(str(b.WEB_BASE_URL) || window.location.origin);
    const { busy, error, run } = useSaver(store);
    const save = () => {
      const sinks = ['web', ...list(str(b.NOTIFY_SINKS)).filter((s) => s !== 'web' && s !== 'telegram'), ...(tg === 'yes' ? ['telegram'] : [])];
      return run([['NOTIFY_SINKS', sinks.join(',')], ...(tg === 'yes' ? [['TELEGRAM_CHAT_ID', chat.trim()] as [string, unknown], ['WEB_BASE_URL', base.trim().replace(/\/+$/, '')] as [string, unknown]] : [])],
        () => (tg === 'yes' && !chat.trim() ? 'Enter the Telegram chat id to post to.' : null));
    };
    return (
      <>
        <Choices value={tg} onPick={setTg} disabled={b.NOTIFY_SINKS?.envPinned} opts={[
          { v: 'no', title: 'Just in the app', sub: 'The bell in the sidebar' },
          { v: 'yes', title: 'In the app and on Telegram', sub: botReady ? 'Messages from your team’s bot' : 'Your admin needs to connect a Telegram bot first', disabled: !botReady },
        ]} />
        {tg === 'yes' && <>
          <Field s={b.TELEGRAM_CHAT_ID} label="Telegram chat id" value={chat} onChange={setChat} help="Message @userinfobot on Telegram to find yours. Group ids start with a minus sign." />
          <Field s={b.WEB_BASE_URL} label="This app’s address" value={base} onChange={setBase} help="Used for the links in each message." />
        </>}
        {actions({ save, busy, error })}
      </>
    );
  },
};

export const ESSENTIALS: Question[] = [ticketsQ, codeQ, aiQ, approvalsQ, spendingQ];
export const LATER: Question[] = [ollamaQ, modelsQ, boardQ, guidanceQ, alertsQ, lookQ];
