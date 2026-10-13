/**
 * Claude subscription use and Anthropic's terms (browser-safe; shared by the api,
 * the web and `asf doctor` through /api/setup/status).
 *
 * Anthropic's Claude Code terms let someone sign the unmodified CLI in with their
 * OWN Claude subscription. They do not allow routing other people's requests
 * through one Free/Pro/Max login, and the plan limits assume ordinary,
 * individual use. A subscription token on a factory with several operators
 * (AUTH_MODE=header: proxy-authenticated users) is the setup that crosses that
 * line, so it gets a warning. API keys, Vertex and Bedrock are billed to the
 * key owner and are the recommended way to run a shared factory.
 */
export const CLAUDE_TERMS_URL = 'https://code.claude.com/docs/en/legal-and-compliance';
export const CLAUDE_USAGE_DOC_URL = 'https://github.com/bennybrau/agentic-software-factory/blob/main/docs/CLAUDE_USAGE.md';

/** The warning to show, or null when the combination is fine. */
export function subscriptionSharingWarning(agentAuthMode: unknown, operatorAuthMode: unknown): string | null {
  if (agentAuthMode !== 'oauth-token' || operatorAuthMode !== 'header') return null;
  return 'A Claude subscription is for its owner’s personal use, but this factory has several operators (AUTH_MODE=header). '
    + 'Anthropic’s terms don’t allow one Pro/Max login to serve other people. Switch to a Claude API key (or Vertex AI / Bedrock).';
}
