import type { AdhocTask, Attachment, Ticket, TicketProvider, TicketProviderCapabilities } from '@asf/shared';
import { registry } from '../../registry/client.js';

/** The neutral Ticket for an ad-hoc task. No tracker, so no URL and no workflow status. */
export function adhocToTicket(t: AdhocTask): Ticket {
  return {
    id: t.id, key: t.key, url: '', title: t.title, body: t.body, status: 'Ad-hoc', bucket: 'ready',
    priority: null, assignee: null, labels: [], links: [], parentId: null, children: [], updatedAt: t.createdAt,
    recurringId: t.recurringId ?? null, recurringTitle: t.recurringTitle ?? null, sourceRepoId: t.sourceRepoId ?? null,
  };
}

/**
 * Ad-hoc tasks (#179) as a read-only TicketProvider, backed by the registry
 * (which owns the adhoc_task table). Reached only through ticketsFor() for an
 * `adhoc:` id. The tracker-side effects the flow fires on dispatch, PR open and
 * merge (comment, transition, assign) have nowhere to go and quietly do nothing;
 * editing is not offered, so update/createSubtask/addLink refuse.
 */
export class AdhocTicketProvider implements TicketProvider {
  readonly kind = 'adhoc' as const;

  async preflight() { return { ok: true as const, identity: 'adhoc' }; }
  capabilities(): TicketProviderCapabilities {
    return { subtasks: false, priority: false, links: false, transitions: false, assignable: false, boards: false, sprints: false, statuses: false };
  }
  /** Stored ad-hoc tasks with no run yet, as neutral tickets (newest first). */
  async list() {
    const { tasks } = await registry.listAdhoc();
    return { tickets: tasks.map(adhocToTicket) };
  }
  async get(id: string): Promise<Ticket> {
    const { task } = await registry.getAdhoc(id);
    if (!task) throw new Error(`no ad-hoc task ${id}`);
    return adhocToTicket(task);
  }
  /** The files attached to the task (metadata only); the bytes come from registry.getAdhocAttachment. */
  async attachments(id: string): Promise<Attachment[]> {
    const { task } = await registry.getAdhoc(id);
    return task?.attachments ?? [];
  }
  /** An agent to-do suggests the repository its run was working in; hand-made tasks and split parts suggest none. */
  suggestedRepo(t: Ticket): string | null { return t.sourceRepoId ?? null; }
  async update(): Promise<never> { throw new Error('adhoc: tasks cannot be edited'); }
  async createSubtask(): Promise<never> { throw new Error('adhoc: subtasks not supported'); }
  async addLink(): Promise<never> { throw new Error('adhoc: links not supported'); }
  async comment() { return { commentId: '' }; }
  async listComments() { return []; }
  async transitions() { return []; }
  async transition() {}
  async assign() {}
  async listScopes(): Promise<never> { throw new Error('adhoc: boards not supported'); }
  async listSprints(): Promise<never> { throw new Error('adhoc: sprints not supported'); }
  async listStatuses(): Promise<never> { throw new Error('adhoc: statuses not supported'); }
}
