import type { ScmProvider } from '@asf/shared';
import { cfg } from '../../settings.js';
import { ScmSet } from './set.js';
import { resolveProviderSecret } from '../secrets.js';
import { MockScmProvider } from './mock.js';
import { GithubScmProvider } from './github.js';
import { GitlabScmProvider } from './gitlab.js';

/** api.github.com → { graphql: …/graphql, host: github.com }; GHES → api at /api/v3, graphql at /api/graphql. */
function githubEndpoints(apiUrl: string): { graphqlUrl: string; host: string } {
  const u = new URL(apiUrl);
  if (u.hostname === 'api.github.com') {
    return { graphqlUrl: 'https://api.github.com/graphql', host: 'github.com' };
  }
  // GitHub Enterprise Server: api at https://ghe.example/api/v3, graphql at /api/graphql, clone host is the bare host.
  return { graphqlUrl: `${u.origin}/api/graphql`, host: u.hostname };
}

/**
 * One factory, keyed by SCM_PROVIDER. Adding an SCM = one file here implementing
 * ScmProvider, plus a case below. Nothing outside this directory may import a
 * provider directly.
 *
 * Config is read through `cfg()` (env > org > default), NOT `resolve()` — the
 * provider kind and its per-provider config are org-settable so the operator can
 * pick and configure the SCM in the UI and have it take effect without a
 * redeploy (white-label WP A/C). The build is async because a UI-entered
 * credential may be a `secret://org/...` pointer resolved at build time (WP B).
 */
export async function buildScmProvider(kind: string): Promise<ScmProvider> {
  switch (kind) {
    case 'mock': return new MockScmProvider(cfg('MOCK_REPO_PATH'));
    case 'github': {
      const apiUrl = cfg('GITHUB_API_URL');
      const { graphqlUrl, host } = githubEndpoints(apiUrl);
      return new GithubScmProvider({
        token: await resolveProviderSecret(cfg('GITHUB_TOKEN')),
        repos: cfg('GITHUB_REPOS').split(',').map((s) => s.trim()).filter(Boolean),
        apiUrl, graphqlUrl, host,
      });
    }
    case 'gitlab': return new GitlabScmProvider({
      baseUrl: cfg('GITLAB_BASE_URL'),
      token: await resolveProviderSecret(cfg('GITLAB_TOKEN')),
      repos: cfg('GITLAB_REPOS').split(',').map((s) => s.trim()).filter(Boolean),
    });
    default: throw new Error(`Unknown SCM_PROVIDER: ${kind}`);
  }
}

/**
 * The api's code hosts (M12 WP2): one hot-swappable registry per connection in
 * SCM_PROVIDERS (or just SCM_PROVIDER). Routes and the scheduler are injected
 * `scmSet.live` (a stable proxy that routes each repository to its host) and
 * never hold a fixed instance; the admin route calls `scmSet.invalidate()` after
 * a settings write so the next request rebuilds from the new config.
 */
export const scmSet = new ScmSet(buildScmProvider);
