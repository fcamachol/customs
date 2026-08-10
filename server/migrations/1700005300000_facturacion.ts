import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `client_tarifas`, `facturas`, `factura_partidas` — financial traceability (PRD-02 §8.10, R43–R48,
 * decisions D17/D18).
 *
 * THE REQUIREMENT, IN ANAM'S OWN TERMS. What the authority asked for on 31 July is a chain that runs
 * guía → piezas → importe → factura without a spreadsheet in the middle. The industry cannot answer
 * it: a CFDI carries a total and a concept, and the mapping from that total back to the specific
 * house guías and piece counts it was computed from lives, if anywhere, in somebody's Excel.
 * `factura_partidas` IS that mapping, stored as rows — which is why the migration header for it is
 * longer than the table.
 *
 * D17 IS THE LOAD-BEARING DECISION: THE LINK LIVES HERE, NOT IN THE CFDI. Luis asked for the
 * traceability to be visible in the invoice; Fernando's implementation answer was that a CFDI is a
 * fiscal document with a fixed schema and stuffing our operational identifiers into its concepts
 * would be both fragile and unverifiable. So the CFDI is ATTACHED (`facturas.file_id`) and IDENTIFIED
 * (`uuid_cfdi`), and the guía-piezas-importe detail is a queryable, exportable table on this side.
 * The authority gets a join, not a PDF to read.
 *
 * THE CARRIER SIDE ALREADY EXISTS AND THIS IS DELIBERATELY ITS MIRROR IMAGE. Migration
 * `1700004900000` gave us what a trip COSTS: `transportista_convenios` → `transportista_tarifas`,
 * priced by `tipo_unidad` and destination, resolved onto `despachos.tarifa_monto` at contracting
 * time. This gives us what a delivery EARNS: `client_tarifas` → `factura_partidas`, priced per pieza
 * (or guía, kg, cartón, despacho) and resolved onto the partida at billing time. The same three
 * disciplines carry over deliberately, because they are what make either side defensible:
 *   - a rate has a `vigencia` window, so an expired price stops being a price instead of becoming
 *     yesterday's price;
 *   - the amount is SNAPSHOTTED onto the row that uses it (`precio_unitario`, `precio_contratado`),
 *     because the rate row can be superseded and the figure that matters afterwards is what was
 *     agreed on the day;
 *   - the pointer survives beside the snapshot (`client_tarifa_id`), so "under which agreement?" is
 *     still answerable.
 * The one thing NOT carried over is the convenio: a client rate is agreed commercially and its
 * contract is #33's NOM-151 work, so `contrato_file_id` is a nullable pointer here rather than a
 * required parent. Overstating that link would claim a signature we do not have.
 *
 * ONLY INCOME (D18 / R47). There is no cost column in this module. Taxes come from the pedimento and
 * fees from the despachos; both are already recorded elsewhere and joined by the report. A margin
 * column here would be a fourth place the same number could disagree with itself.
 *
 * FISCAL DATA IS ENCRYPTED AT REST, AND STAYS OUT OF THE AUDIT CHAIN. `receptor_rfc` and
 * `receptor_correo` are field-level encrypted (`server/src/crypto/fieldCrypto.ts`, `v1:` envelope),
 * the same treatment `transportistas.contacto_telefono` and `client_direcciones.contacto_*` already
 * get: a persona-física RFC encodes a name and a birth date, and a billing address is personal data.
 * `receptor_razon_social` is deliberately NOT encrypted — the client's name is already plaintext in
 * `clients.name` and in every report header, and encrypting one copy of a value that is public in
 * three others is theatre, not protection. Neither encrypted field is ever copied into
 * `audit_log.after`: that record is permanent and hash-chained, so writing PII into it would defeat
 * the encryption it sits beside (pinned by test).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------------------------
  // What a client pays, per unit — R46
  // ---------------------------------------------------------------------------------------------
  pgm.createTable('client_tarifas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    /**
     * What is being charged for, in the words that will appear on the invoice line ("Despacho
     * aduanal T1 por pieza"). Free text and notNull: two rates for the same client differ by their
     * concept, and a blank one would make an invoice line unexplainable to the person paying it.
     */
    concepto: { type: 'text', notNull: true },
    /**
     * The unit the price multiplies. `pieza` is the live case — Alfonso's example was $0.05 per
     * piece (Q9) — but the glossary is complete because the same client can be billed per guía for
     * one service and per despacho for another, and a price whose unit is implied is a price two
     * people will compute differently.
     */
    unidad: {
      type: 'text',
      notNull: true,
      check: "unidad IN ('pieza','guia','kg','carton','despacho')",
    },
    precio: { type: 'numeric', notNull: true },
    moneda: { type: 'text', notNull: true, default: 'MXN' },
    // A rate with no window is open-ended in that direction; see the header on why windows matter.
    vigencia_desde: { type: 'date' },
    vigencia_hasta: { type: 'date' },
    /** The commercial agreement behind the price, when there is a signed one (#33 / NOM-151). */
    contrato_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    activo: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('client_tarifas', 'client_tarifas_precio_check', { check: 'precio >= 0' });
  pgm.addConstraint('client_tarifas', 'client_tarifas_vigencia_check', {
    check: 'vigencia_hasta IS NULL OR vigencia_desde IS NULL OR vigencia_hasta >= vigencia_desde',
  });
  // The billing lookup: "what does this client pay per pieza, on this date?"
  pgm.createIndex('client_tarifas', ['client_id', 'unidad', 'activo']);

  // ---------------------------------------------------------------------------------------------
  // The invoice — R43, R48
  // ---------------------------------------------------------------------------------------------
  pgm.createTable('facturas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // SET NULL, not CASCADE: deleting a client must never be a way to erase what was billed to them.
    client_id: { type: 'uuid', references: 'clients', onDelete: 'SET NULL' },
    /**
     * A proforma is our arithmetic; a CFDI is the fiscal document the SAT stamped. They are the same
     * shape and different claims, and the month usually has one of each — so the type is a column,
     * not two tables.
     */
    tipo: { type: 'text', notNull: true, check: "tipo IN ('proforma','cfdi')" },
    folio: { type: 'text' },
    /**
     * The SAT's own identifier. UNIQUE and nullable: nullable because a proforma has none and a CFDI
     * has none until it is stamped, UNIQUE because the same stamped document appearing twice would
     * be double-billing that no later report could untangle.
     */
    uuid_cfdi: { type: 'text', unique: true },
    /** `YYYY-MM`. The billing month, which is what the monthly report and the authority ask by. */
    periodo: { type: 'text', notNull: true },
    subtotal: { type: 'numeric' },
    total: { type: 'numeric' },
    moneda: { type: 'text', notNull: true, default: 'MXN' },
    /** The CFDI/proforma PDF or XML itself, hashed like every other artifact (`files.kind = 'factura'`). */
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    estado: {
      type: 'text',
      notNull: true,
      default: 'borrador',
      check: "estado IN ('borrador','emitida','timbrada','cancelada','pagada')",
    },
    /**
     * R48. The T1-specific stamping is not enabled yet, so every stamp we can produce today is a
     * TEST stamp. The flag exists so a test-stamped invoice can never be mistaken for a fiscal one
     * in a report — "unverifiable ≠ verified" applied to money.
     */
    timbrado_prueba: { type: 'boolean', notNull: true, default: false },
    timbrado_at: { type: 'timestamptz' },
    /** Denormalized receptor, encrypted — see the file header on which fields and why. */
    receptor_rfc: { type: 'text' },
    receptor_razon_social: { type: 'text' },
    receptor_correo: { type: 'text' },
    motivo_cancelacion: { type: 'text' },
    cancelada_at: { type: 'timestamptz' },
    observaciones: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('facturas', 'facturas_periodo_check', {
    check: "periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'",
  });
  /**
   * Nothing may CLAIM to be stamped without the SAT uuid and the moment it was stamped.
   *
   * Deliberately one-directional, unlike `transportista_convenios_firma_check`. An equality would
   * read better and would be wrong: a stamped invoice that is later CANCELLED keeps its uuid,
   * because the CFDI existed and the cancellation is a fact about it, not a way to un-issue it.
   * Forcing the uuid to null on cancellation would erase the identifier the SAT and the client both
   * still hold.
   */
  pgm.addConstraint('facturas', 'facturas_timbrado_check', {
    check: "estado <> 'timbrada' OR (uuid_cfdi IS NOT NULL AND timbrado_at IS NOT NULL)",
  });
  pgm.addConstraint('facturas', 'facturas_cancelacion_check', {
    check: "(estado = 'cancelada') = (motivo_cancelacion IS NOT NULL)",
  });
  pgm.addConstraint('facturas', 'facturas_importes_check', {
    check: '(subtotal IS NULL OR subtotal >= 0) AND (total IS NULL OR total >= 0)',
  });
  // The monthly report's own index (R43): one client, one period.
  pgm.createIndex('facturas', ['client_id', 'periodo']);
  pgm.createIndex('facturas', ['estado', 'periodo']);

  // ---------------------------------------------------------------------------------------------
  // The line nobody in the industry has — R44 / R45
  // ---------------------------------------------------------------------------------------------
  pgm.createTable('factura_partidas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    factura_id: { type: 'uuid', notNull: true, references: 'facturas', onDelete: 'CASCADE' },
    /**
     * The three pointers that make the chain a join. All SET NULL, all deliberately: a re-ingest
     * that drops a guía line, or a despacho row that is later removed, must not delete the record of
     * what was CHARGED — a billed line whose cargo pointer vanished is a question to answer, not a
     * row to lose.
     */
    operacion_id: { type: 'uuid', references: 'operaciones', onDelete: 'SET NULL' },
    operacion_guia_id: { type: 'uuid', references: 'operacion_guias', onDelete: 'SET NULL' },
    despacho_id: { type: 'uuid', references: 'despachos', onDelete: 'SET NULL' },
    /**
     * The guía as text, beside the pointer to it. Not redundancy: the pointer answers "which row?"
     * and can go null; this answers "which guía was billed?" and never can. The authority's question
     * is asked with a number written on a piece of paper, not with a uuid.
     */
    guia_norm: { type: 'text' },
    mawb: { type: 'text' },
    /** What was charged for, snapshotted from the tarifa (see the header on snapshots). */
    concepto: { type: 'text', notNull: true },
    unidad: {
      type: 'text',
      notNull: true,
      check: "unidad IN ('pieza','guia','kg','carton','despacho')",
    },
    /** The quantity the unit counts — pieces for `pieza`, 1 for `guia`/`despacho`, kg for `kg`. */
    cantidad: { type: 'numeric', notNull: true },
    piezas: { type: 'integer' },
    precio_unitario: { type: 'numeric', notNull: true },
    /**
     * R45, the control that makes over- and under-charging both visible. The contracted price at the
     * moment of billing, stored beside the price actually charged. Fernando's framing: charging more
     * than the contract is abuse of the client, charging less is a possible arrangement with them —
     * and only a system that keeps BOTH numbers can raise either question. `NULL` means no rate was
     * in force, which is itself the finding.
     */
    precio_contratado: { type: 'numeric' },
    importe: { type: 'numeric', notNull: true },
    client_tarifa_id: { type: 'uuid', references: 'client_tarifas', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('factura_partidas', 'factura_partidas_cantidades_check', {
    check:
      'cantidad >= 0 AND precio_unitario >= 0 AND importe >= 0 AND ' +
      '(piezas IS NULL OR piezas >= 0) AND (precio_contratado IS NULL OR precio_contratado >= 0)',
  });
  /**
   * One line per guía per invoice. NULLS NOT DISTINCT for the same reason as
   * `despacho_partidas_unica_uq`: by default Postgres treats every NULL as unique, so a
   * whole-operación line (`operacion_guia_id IS NULL`) could otherwise be added any number of times
   * and the constraint would never fire — which is double-billing, the exact error this prevents.
   * Requires PostgreSQL 15+.
   *
   * It is scoped to the invoice, NOT global, on purpose: the same delivery legitimately appears on a
   * proforma and then on the CFDI that follows it. Billing the same guía twice on the same TYPE of
   * document is the real error, and the preliquidación reports it as `yaFacturadas` rather than
   * silently pricing it again.
   */
  pgm.sql(`
    ALTER TABLE factura_partidas
      ADD CONSTRAINT factura_partidas_unica_uq
      UNIQUE NULLS NOT DISTINCT (factura_id, operacion_id, operacion_guia_id, concepto)
  `);
  pgm.createIndex('factura_partidas', 'factura_id');
  // "What was this shipment billed at?" — the traceability query, from the cargo end.
  pgm.createIndex('factura_partidas', 'operacion_id');
  pgm.createIndex('factura_partidas', 'operacion_guia_id');
  pgm.createIndex('factura_partidas', 'despacho_id');
  // "Which invoice carries this guía?" — the same question asked with the number off the paper.
  pgm.createIndex('factura_partidas', 'guia_norm');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('factura_partidas');
  pgm.dropTable('facturas');
  pgm.dropTable('client_tarifas');
}
