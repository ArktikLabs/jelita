/**
 * The disposable test database (docker-compose.test.yml).
 *
 * These credentials are deliberately in the repo rather than an env file: the
 * container is throwaway and recreated per run, so there is no secret here,
 * and a committed value means a fresh checkout can run the suite without
 * anyone being told what to put in .env.test.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://jelita:jelita@127.0.0.1:55432/jelita_test'
