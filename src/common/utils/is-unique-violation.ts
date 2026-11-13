import { QueryFailedError } from 'typeorm';

/** True when a query failed on a PostgreSQL unique constraint (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === '23505'
  );
}
