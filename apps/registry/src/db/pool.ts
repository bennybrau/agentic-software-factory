import postgres from 'postgres';
import { config } from '../config.js';

export type Sql = postgres.Sql;
/** Either a pooled connection or a transaction handle — the query helpers accept both. */
export type Db = postgres.Sql | postgres.TransactionSql;

let instance: Sql | null = null;

export function sql(opts: { url?: string; schema?: string } = {}): Sql {
  if (!instance) {
    const schema = opts.schema ?? config.databaseSchema;
    instance = postgres(opts.url ?? config.databaseUrl, {
      max: 10,
      idle_timeout: 30,
      onnotice: () => {},
      // Column names only. `postgres.camel` would also rewrite keys inside JSONB
      // values (gates.before_merge -> beforeMerge), which the schemas would reject.
      transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
      ...(schema ? { connection: { search_path: schema } } : {}),
    });
  }
  return instance;
}

export async function ping(): Promise<boolean> {
  return (await probe()) === null;
}

/** Why the database can't be reached, as something a person can act on. */
export interface DbProblem { code?: string; message: string; hint?: string }

/** null when `select 1` works; otherwise the error, with a hint for the common causes. */
export async function probe(): Promise<DbProblem | null> {
  try {
    await sql()`select 1`;
    return null;
  } catch (err) {
    return describeDbError(err);
  }
}

export function describeDbError(err: unknown): DbProblem {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' && e.message ? e.message : String(err);
  return { code, message, hint: dbHint(code) };
}

function dbHint(code: string | undefined): string | undefined {
  switch (code) {
    // invalid_password / invalid_authorization_specification
    case '28P01':
    case '28000':
      return 'Postgres rejected the password in .env. Its data volume is usually from an earlier install, which set a different password. ' +
        'Run scripts/uninstall.sh (it saves a copy of the old database), then scripts/setup.sh; or put the earlier install\'s POSTGRES_PASSWORD back in .env.';
    case '3D000': // invalid_catalog_name
      return 'the database named in DATABASE_URL does not exist';
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ETIMEDOUT':
      return 'nothing answered at the DATABASE_URL host: is the postgres container running and healthy? (scripts/asf status)';
    default:
      return undefined;
  }
}

export async function closePool(): Promise<void> {
  if (instance) {
    await instance.end({ timeout: 5 });
    instance = null;
  }
}
