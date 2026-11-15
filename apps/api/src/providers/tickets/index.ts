import type { TicketProvider } from '@asf/shared';
import { cfg } from '../../settings.js';
import { TicketSet } from './set.js';
import { resolveProviderSecret } from './secrets.js';
import { MockTicketProvider } from './mock.js';
import { GithubTicketProvider, parseBucketMap } from './github.js';
import { JiraTicketProvider, parseJiraBucketMap, parseJiraTeams } from './jira/jira.js';
import { TrelloTicketProvider, parseListBucketMap } from './trello/trello.js';
import { AdhocTicketProvider } from './adhoc.js';

/**
 * One factory, keyed by TICKET_PROVIDER. Adding a tracker = one file here that
 * implements TicketProvider, plus a case below. Nothing outside this directory
 * may import a provider directly.
 *
 * Config is read through `cfg()` (env > org > default), NOT `resolve()` — the
 * provider kind and its per-provider config are org-settable so the operator can
 * pick and configure the tracker in the UI and have it take effect without a
 * redeploy (white-label WP A/C). The build is async because a UI-entered
 * credential may be a `secret://org/...` pointer resolved at build time (WP B).
 */
export async function buildTicketProvider(kind: string): Promise<TicketProvider> {
  switch (kind) {
    case 'mock': return new MockTicketProvider();
    case 'github': return new GithubTicketProvider({
      token: await resolveProviderSecret(cfg('GITHUB_TOKEN')),
      repos: cfg('GITHUB_REPOS').split(',').map((s) => s.trim()).filter(Boolean),
      bucketMap: parseBucketMap(cfg('GITHUB_BUCKET_MAP')),
      apiUrl: cfg('GITHUB_API_URL'),
    });
    case 'jira': return new JiraTicketProvider({
      baseUrl: cfg('JIRA_BASE_URL').replace(/\/+$/, ''),
      email: cfg('JIRA_EMAIL'),
      apiToken: await resolveProviderSecret(cfg('JIRA_API_TOKEN')),
      projects: cfg('JIRA_PROJECTS').split(',').map((s) => s.trim()).filter(Boolean),
      boards: cfg('JIRA_BOARDS').split(',').map((s) => s.trim()).filter(Boolean),
      teams: parseJiraTeams(cfg('JIRA_TEAMS')),
      jqlTemplate: cfg('JIRA_JQL_TEMPLATE'),
      bucketMap: parseJiraBucketMap(cfg('JIRA_BUCKET_MAP')),
    });
    case 'trello': return new TrelloTicketProvider({
      key: await resolveProviderSecret(cfg('TRELLO_KEY')),
      token: await resolveProviderSecret(cfg('TRELLO_TOKEN')),
      boards: cfg('TRELLO_BOARDS').split(',').map((s) => s.trim()).filter(Boolean),
      listBucketMap: parseListBucketMap(cfg('TRELLO_LIST_BUCKET_MAP')),
    });
    default: throw new Error(`Unknown TICKET_PROVIDER: ${kind}`);
  }
}

/**
 * The api's trackers (M12 WP3): one hot-swappable registry per connection in
 * TICKET_PROVIDERS (or just TICKET_PROVIDER). Routes and the scheduler are
 * injected `ticketSet.live` (a stable proxy that routes each ticket to its
 * tracker) and never hold a fixed instance; the admin route calls
 * `ticketSet.invalidate()` after a settings write so the next request rebuilds
 * from the new config.
 */
export const ticketSet = new TicketSet(buildTicketProvider);

/**
 * Ad-hoc tasks (#179) live in the registry, not the tracker, so they are not a
 * TICKET_PROVIDER choice: one read-only instance sits beside whichever tracker is
 * configured, and tickets/route.ts sends every `adhoc:` id to it.
 */
export const adhocTickets = new AdhocTicketProvider();
