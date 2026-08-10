import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `pods` — proof of delivery, the fact that closes the physical chain (PRD-02 §8.5, R28, R39).
 *
 * WHY A SIGNED POD IS WHAT COMPLETES A DELIVERY, AND AN ARRIVAL IS NOT. `POST /api/despachos/:id/arribo`
 * (R36/D14) already records that the unit reached the client's gate, and it deliberately does NOT
 * advance the trip to `entregado` — a truck that arrived and was turned away, or that arrived with
 * fewer cartons than the plan, has arrived and has not delivered. The signature is the client
 * accepting the cargo, and it is the only event in the whole module produced by somebody outside this
 * organisation. Everything downstream hangs off it: the etapa reaches `entregado` here, and R43's
 * invoice line may only be built from guías whose delivery a client actually signed for.
 *
 * ONE ROW PER TRIP, VERSIONED — NOT ONE ROW PER ATTEMPT. Luis asked for the despacho screen to be
 * editable, because a guía whose pedimento is not ready gets swapped for another one; the POD is
 * generated from that assignment, so the document has to be re-generable while the assignment is
 * still a plan. `despacho_id` is therefore UNIQUE and `version` counts the regenerations, each one
 * writing its own ledger event. Regeneration is refused once `estado = 'firmado'`: at that point the
 * document is not a rendering of the plan any more, it is evidence of what a person signed, and a
 * system that can silently reprint evidence has no evidence at all.
 *
 * `snapshot` IS THE DOCUMENT, `file_id_generado` IS ONLY ITS RENDERING. The template is still pending
 * from Luis (Q6). Storing the exact data the document was built from — trip, carrier, plates, every
 * guía with its pieces, in a version-stamped shape (shared/operaciones/pod.ts) — means the XLSX can
 * be re-rendered into whatever the template turns out to be without the historical POD becoming a
 * different document. It is the same discipline as `despachos.eta_calculo`: the number is stored
 * beside the basis it was produced from.
 *
 * THREE FILE COLUMNS, THREE DIFFERENT CLAIMS. `file_id_generado` is what we produced and sent;
 * `file_id_firmado` is the scan or photograph of the paper the client signed; and
 * `firma_evidencia_file_id` is the optional extra capture (a signature image, a photo at the dock).
 * Collapsing them would make "we printed a POD" indistinguishable from "the client signed one",
 * which is precisely the confusion the whole requirement exists to remove. All three are SET NULL:
 * losing a blob must never delete the record that a delivery was signed for — `routes/files.ts`
 * answers 410 with the stored hash for exactly this case (#39).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pods', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /**
     * CASCADE and UNIQUE. A POD is meaningless without its trip, and a trip has exactly one delivery
     * document — the regenerations are `version`, not extra rows (see the header).
     */
    despacho_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
      references: 'despachos',
      onDelete: 'CASCADE',
    },
    /**
     * `POD-<folio del despacho>`. Derived rather than sequenced: the despacho folio is already the
     * handle three organisations that do not share a database use out loud, and a POD folio that
     * names its trip is checkable by a human holding both papers. UNIQUE follows from the despacho's
     * own UNIQUE folio; declared anyway so another writer cannot mint a colliding one.
     */
    folio: { type: 'text', notNull: true, unique: true },
    version: { type: 'integer', notNull: true, default: 1 },
    file_id_generado: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    file_id_firmado: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    firma_evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    /**
     * `rechazado` is not a failure of the system, it is a real outcome: the client refuses the cargo
     * at the door. It is a terminal state that does NOT deliver, so the trip stays short of
     * `entregado` and the guías stay un-billable — which is the honest answer, and the one a
     * single 'firmado' boolean could never give.
     */
    estado: {
      type: 'text',
      notNull: true,
      default: 'generado',
      check: "estado IN ('generado','enviado','firmado','rechazado')",
    },
    enviado_at: { type: 'timestamptz' },
    /** Who signed, as they wrote it. Free text on purpose: it is the receiving warehouse's employee,
     *  a person this system has no catalog of and must not invent one for. */
    firmado_por: { type: 'text' },
    firmado_at: { type: 'timestamptz' },
    /** The data the document was rendered from, version-stamped. See the header. */
    snapshot: { type: 'jsonb' },
    observaciones: { type: 'text' },
    /** R40 — why the client refused, in their words. Required by the route when estado = 'rechazado'. */
    motivo_rechazo: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  /**
   * A signed POD must say when it was signed, and an unsigned one must not claim a date — the same
   * equality-between-booleans shape as `transportista_convenios_firma_check`. Without it, `firmado`
   * would be a word somebody typed, and the invoice line built on top of it would inherit that.
   */
  pgm.addConstraint('pods', 'pods_firma_check', {
    check: "(estado = 'firmado') = (firmado_at IS NOT NULL)",
  });
  /** A rejection has to state its reason: "the client refused" with no why is not a record. */
  pgm.addConstraint('pods', 'pods_rechazo_motivo_check', {
    check: "(estado = 'rechazado') = (motivo_rechazo IS NOT NULL)",
  });
  pgm.addConstraint('pods', 'pods_version_check', { check: 'version >= 1' });

  // "Which deliveries are still unsigned?" — the Entregas board's only query.
  pgm.createIndex('pods', ['estado', 'firmado_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pods');
}
