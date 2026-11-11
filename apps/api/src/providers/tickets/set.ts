import { formatRef, parseRef } from '@asf/shared';
import type { Ticket, TicketProvider } from '@asf/shared';

/**
 * The ticket provider with qualified ids at the seam (M12, see refs.ts). Every id
 * going in is stripped to the provider's native id (a bare pre-M12 id passes
 * through), and every ticket coming out carries its connection and a qualified id,
 * so the provider itself never sees a prefix. `kind` is read through on every
 * access, so this wraps a registry's hot-swapping `live` proxy safely.
 */
export function qualifyTickets(provider: TicketProvider): TicketProvider {
  const kind = () => provider.kind;
  const native = (ref: string) => parseRef(ref, kind()).native;
  const qualify = (t: Ticket): Ticket => {
    const c = kind();
    return {
      ...t, connection: c, id: formatRef(c, t.id),
      parentId: t.parentId == null ? t.parentId : formatRef(c, t.parentId),
      children: t.children?.map((id) => formatRef(c, id)),
    };
  };
  const wrapped: Omit<TicketProvider, 'kind'> = {
    preflight: () => provider.preflight(),
    capabilities: () => provider.capabilities(),
    list: async (q) => {
      const r = await provider.list(q);
      return { ...r, tickets: r.tickets.map(qualify) };
    },
    get: async (id) => qualify(await provider.get(native(id))),
    update: async (id, patch) => qualify(await provider.update(native(id), patch)),
    createSubtask: async (parentId, input) => qualify(await provider.createSubtask(native(parentId), input)),
    addLink: (id, link) => provider.addLink(native(id), link),
    comment: (id, markdown) => provider.comment(native(id), markdown),
    listComments: (id) => provider.listComments(native(id)),
    transitions: (id) => provider.transitions(native(id)),
    transition: (id, transitionId) => provider.transition(native(id), transitionId),
    assign: (id, assignee) => provider.assign(native(id), assignee),
    listScopes: () => provider.listScopes(),
    listSprints: (scopeId) => provider.listSprints(scopeId),
    listStatuses: (scopeId) => provider.listStatuses(scopeId),
    // The provider reads its own ids (the GitHub tracker parses `acme/web#42`), so it gets the native one back.
    ...(provider.suggestedRepo ? { suggestedRepo: (t: Ticket) => provider.suggestedRepo?.({ ...t, id: native(t.id) }) ?? null } : {}),
  };
  Object.defineProperty(wrapped, 'kind', { get: kind, enumerable: true });
  return wrapped as TicketProvider;
}
