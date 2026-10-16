import { isFreeModel } from '@asf/shared/ui';

/**
 * How a cost reads (M11 WP6). A task on an Ollama model costs $0 by design, so it says
 * "free (Ollama)" instead of a "$0.00" that looks like a missing price.
 */
type CostTask = { costUsd: number; model?: string | null; runtime?: string | null };

const agentTasks = (tasks: readonly CostTask[]) => tasks.filter((t) => t.runtime !== 'publish' && t.model);

export function taskCostText(t: CostTask, digits = 2): string {
  return t.costUsd === 0 && isFreeModel(t.model) ? 'free (Ollama)' : `$${t.costUsd.toFixed(digits)}`;
}

/** The run header: "$0.48 / $3 · Ollama jobs free", or "free (Ollama) / $3" when every job ran on Ollama. */
export function runCostText(run: { costUsd: number; maxCostUsd: number }, tasks: readonly CostTask[]): string {
  const agents = agentTasks(tasks);
  const onOllama = agents.filter((t) => isFreeModel(t.model));
  const cap = `$${run.maxCostUsd.toFixed(0)}`;
  if (agents.length && onOllama.length === agents.length && run.costUsd === 0) return `free (Ollama) / ${cap}`;
  return `$${run.costUsd.toFixed(2)} / ${cap}${onOllama.length ? ' · Ollama jobs free' : ''}`;
}
