import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * F09: Add token_version to users for JWT revocation.
 * Bumping this column invalidates all outstanding JWTs for that user
 * (logout-all, password change, role change, compromise response).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('users', {
    token_version: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('users', 'token_version');
}
