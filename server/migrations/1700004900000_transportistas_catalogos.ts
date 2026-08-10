import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Transport catalogs and client delivery addresses (PRD-02 §8.5, R24, R25/D9, R38/D15).
 *
 * THE SHAPE OF THIS MIGRATION IS DECISION D7. Alfonso settled the disagreement between Luis ("the
 * carrier implies the unit type, so the order is irrelevant") and Fernando ("ask for the type first
 * so we don't phone carriers in vain") in favour of TYPE FIRST. That decision is normally a UI
 * ordering — a wizard step — and a UI ordering is a suggestion. Here it is structural: the tariff,
 * which is the thing anybody actually wants from a carrier, hangs off `transportista_tarifas` and
 * carries `tipo_unidad` as a notNull column. There is no way to ask "what does this carrier charge?"
 * without having already said which unit type, because the row that answers the question does not
 * exist independently of one. The route layer's `GET /api/despachos/opciones` refuses without it for
 * the same reason; this table is why that refusal is not merely a policy.
 *
 * WHY THE TARIFF HANGS OFF THE CONVENIO AND NOT OFF THE CARRIER. R25/D9: rates are what a signed
 * agreement SAYS. A rate floating on the carrier would be a number somebody typed; a rate on a
 * convenio with `vigencia_desde`/`vigencia_hasta` and an `estado_firma` is a number with a document
 * behind it and a date it stops being true. When a convenio expires, its rates expire with it and
 * the planner sees a carrier with no price rather than yesterday's price — which is the difference
 * between renegotiating and being billed a surprise.
 *
 * `client_direcciones` (R38/D15) lands here rather than with the despachos because it is a client
 * catalog, it follows the `client_platforms` pattern exactly, and two things downstream need it as a
 * foreign key: the despacho's single destination (R29) and the per-destination tariff. Its `lat`/`lng`
 * are also the only way the R36 arrival estimate can run at all — with no coordinates the estimator
 * returns nothing rather than a guess (shared/operaciones/eta.ts).
 *
 * CONTACT FIELDS ARE STORED ENCRYPTED at the field level (`server/src/crypto/fieldCrypto.ts`,
 * `v1:` envelope) as PRD-02 §8.5 specifies, because a driver's mobile number and a warehouse
 * contact's name are personal data of people who never contracted with us. `decryptField` is a
 * passthrough for values that lack the envelope, so rows seeded by hand still read.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------------------------
  // Delivery addresses per client — R38 / D15
  // ---------------------------------------------------------------------------------------------
  pgm.createTable('client_direcciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    /**
     * The name the operation uses out loud ("IMILE Cuautitlán"). notNull and unique per client
     * because the plan, the tariff and the POD all refer to the destination by this string, and two
     * addresses with the same alias would make a published plan ambiguous about where a truck went.
     */
    alias: { type: 'text', notNull: true },
    direccion: { type: 'text' },
    ciudad: { type: 'text' },
    estado: { type: 'text' },
    cp: { type: 'text' },
    // The precondition for R36. Nullable, and the estimator treats absence as "cannot estimate".
    lat: { type: 'numeric' },
    lng: { type: 'numeric' },
    // Encrypted at the field level (see the header): personal data of the receiving warehouse's staff.
    contacto_nombre: { type: 'text' },
    contacto_telefono: { type: 'text' },
    horario: { type: 'text' },
    activo: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('client_direcciones', 'client_direcciones_client_alias_uq', {
    unique: ['client_id', 'alias'],
  });
  pgm.createIndex('client_direcciones', 'client_id');

  // ---------------------------------------------------------------------------------------------
  // Carriers, units, agreements, tariffs — R24, R25/D9
  // ---------------------------------------------------------------------------------------------
  pgm.createTable('transportistas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    razon_social: { type: 'text', notNull: true },
    /**
     * UNIQUE and nullable. Unique because two rows for the same fiscal person split the trip history
     * of one carrier in half, which is exactly the ambiguity that makes "who did we send that load
     * with?" unanswerable; nullable because a carrier is registered the day it is needed and the RFC
     * often arrives with the paperwork a week later.
     */
    rfc: { type: 'text', unique: true },
    contacto_nombre: { type: 'text' },
    // Encrypted at the field level (see the header).
    contacto_telefono: { type: 'text' },
    contacto_email: { type: 'text' },
    estado: {
      type: 'text',
      notNull: true,
      default: 'activo',
      check: "estado IN ('activo','suspendido','baja')",
    },
    /**
     * Whether the carrier's own compliance file is complete (insurance, permits, SCT registration).
     * A flag rather than a table because at this stage the operation tracks it as a single yes/no on
     * a checklist that lives outside the system; when it becomes a document set it gets its own rows.
     */
    documentos_ok: { type: 'boolean', notNull: true, default: false },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('transportistas', 'estado');

  pgm.createTable('transportista_unidades', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    transportista_id: {
      type: 'uuid',
      notNull: true,
      references: 'transportistas',
      onDelete: 'CASCADE',
    },
    /**
     * The plates are the identity of the unit on the ground: it is what the aduana writes down, what
     * the warehouse guard checks, and what the client asks about. Unique per carrier, not globally —
     * plates get reassigned between fleets and an old row must not block a new relationship.
     */
    placas: { type: 'text', notNull: true },
    // R23 / D8 — the same glossary as `despachos.tipo_unidad`. Spelled out inline because migrations
    // stay dependency-free; shared/operaciones/catalogos.ts holds the app-side copy and a test pins
    // the two together.
    tipo_unidad: {
      type: 'text',
      notNull: true,
      check: "tipo_unidad IN ('tracto','torton','rabon','t3_5','silverado','cargo_van')",
    },
    numero_economico: { type: 'text' },
    // Expiry dates, not booleans: "is the insurance current?" is a question about today, and a
    // boolean would answer it with whatever was true on the day somebody last ticked the box.
    vigencia_seguro: { type: 'date' },
    vigencia_verificacion: { type: 'date' },
    activo: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('transportista_unidades', 'transportista_unidades_placas_uq', {
    unique: ['transportista_id', 'placas'],
  });
  // The D7 lookup: "which carriers have an active unit of THIS type?" — asked before any carrier is
  // named, on every dispatch.
  pgm.createIndex('transportista_unidades', ['tipo_unidad', 'activo']);
  pgm.createIndex('transportista_unidades', 'transportista_id');

  pgm.createTable('transportista_convenios', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    transportista_id: {
      type: 'uuid',
      notNull: true,
      references: 'transportistas',
      onDelete: 'CASCADE',
    },
    // The signed contract itself. SET NULL, not RESTRICT: the agreement's TERMS live in this row and
    // in its tarifas, and they must stay readable even if the PDF is lost. Losing the file is bad;
    // losing the rate we are being billed against is worse.
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    vigencia_desde: { type: 'date' },
    vigencia_hasta: { type: 'date' },
    estado_firma: {
      type: 'text',
      notNull: true,
      default: 'borrador',
      check: "estado_firma IN ('borrador','enviado','firmado','vencido')",
    },
    firmado_at: { type: 'timestamptz' },
    /**
     * D9 commits to digitally signed, paperless agreements, and there is no Mexican PSC integration
     * yet (§17). These three columns are the seam: provider, its reference, and the evidence file.
     * Recording them as plain columns — rather than pretending a signature exists — is what keeps
     * `firmado` from being a word somebody typed.
     */
    firma_proveedor: { type: 'text' },
    firma_referencia: { type: 'text' },
    firma_evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  /**
   * A signed agreement must say when it was signed, and an unsigned one must not claim a date.
   * Enforced as an equality between two booleans so both directions are covered by one constraint —
   * same pattern as `operacion_holds_alcance_global_check`.
   */
  pgm.addConstraint('transportista_convenios', 'transportista_convenios_firma_check', {
    check: "(estado_firma = 'firmado') = (firmado_at IS NOT NULL)",
  });
  pgm.addConstraint('transportista_convenios', 'transportista_convenios_vigencia_check', {
    check: 'vigencia_hasta IS NULL OR vigencia_desde IS NULL OR vigencia_hasta >= vigencia_desde',
  });
  pgm.createIndex('transportista_convenios', 'transportista_id');
  pgm.createIndex('transportista_convenios', ['estado_firma', 'vigencia_hasta']);

  pgm.createTable('transportista_tarifas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    convenio_id: {
      type: 'uuid',
      notNull: true,
      references: 'transportista_convenios',
      onDelete: 'CASCADE',
    },
    // D7 made structural — see the file header.
    tipo_unidad: {
      type: 'text',
      notNull: true,
      check: "tipo_unidad IN ('tracto','torton','rabon','t3_5','silverado','cargo_van')",
    },
    /**
     * NULL means "general rate for this unit type, any destination". A destination-specific row wins
     * over it. Modelled as a nullable FK rather than two tables because the fallback is the common
     * case and a second table would double every lookup for a rate that usually is not there.
     */
    direccion_entrega_id: { type: 'uuid', references: 'client_direcciones', onDelete: 'SET NULL' },
    tarifa: { type: 'numeric', notNull: true },
    moneda: { type: 'text', notNull: true, default: 'MXN' },
    vigencia_desde: { type: 'date' },
    vigencia_hasta: { type: 'date' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('transportista_tarifas', 'transportista_tarifas_positiva_check', {
    check: 'tarifa >= 0',
  });
  pgm.addConstraint('transportista_tarifas', 'transportista_tarifas_vigencia_check', {
    check: 'vigencia_hasta IS NULL OR vigencia_desde IS NULL OR vigencia_hasta >= vigencia_desde',
  });
  pgm.createIndex('transportista_tarifas', 'convenio_id');
  // The rate lookup behind the D7 options endpoint.
  pgm.createIndex('transportista_tarifas', ['tipo_unidad', 'direccion_entrega_id']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('transportista_tarifas');
  pgm.dropTable('transportista_convenios');
  pgm.dropTable('transportista_unidades');
  pgm.dropTable('transportistas');
  pgm.dropTable('client_direcciones');
}
