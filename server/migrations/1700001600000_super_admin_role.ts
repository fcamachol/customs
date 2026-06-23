import type { MigrationBuilder } from 'node-pg-migrate';

// §10: introduce a super-admin role. Only super_admin may edit tasa-global vigencias
// (the parametrizable consistency catalog). super_admin otherwise behaves like admin.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('users', 'users_role_check');
  pgm.addConstraint('users', 'users_role_check', {
    check: "role IN ('capturista','admin','autoridad','super_admin')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('users', 'users_role_check');
  pgm.addConstraint('users', 'users_role_check', {
    check: "role IN ('capturista','admin','autoridad')",
  });
}
