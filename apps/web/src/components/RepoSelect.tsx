import type { SelectHTMLAttributes } from 'react';
import { groupReposByHost, hostBadge } from '../repo-groups';

type Repo = { id: string; path: string };

/**
 * A repository picker. With several code hosts the repositories are grouped under
 * each host's name and a badge beside it says which host the chosen one is on (it
 * wraps under the select on a narrow screen); with one host it is a flat list.
 */
export function RepoSelect({ repos, scm, value, onChange, placeholder, wide, ...rest }: {
  repos: readonly Repo[]; scm: readonly string[]; value: string; onChange: (repoId: string) => void;
  /** A first, empty option (`Choose…`). */
  placeholder?: string;
  /** Fill the line (the select stretches; the badge still wraps under it). */
  wide?: boolean;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const groups = groupReposByHost(repos, scm);
  const badge = hostBadge(value, scm);
  const option = (r: Repo) => <option key={r.id} value={r.id}>{r.path}</option>;
  return (
    <span className={wide ? 'repo-select wide' : 'repo-select'}>
      <select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {groups.length > 1
          ? groups.map((g) => <optgroup key={g.connection} label={g.label}>{g.repos.map(option)}</optgroup>)
          : repos.map(option)}
      </select>
      {badge && <span className="pill source">{badge}</span>}
    </span>
  );
}
