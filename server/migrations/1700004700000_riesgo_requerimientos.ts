import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `riesgo_requerimientos` — the bridge Fernando demanded between the two systems (PRD-02 `R18`,
 * decisión `D13`, §8.7, contingencia `CT-4`).
 *
 * WHAT IT IS. PRD-01's risk engine already produces `ReasonCode[]` per shipment, versioned and
 * reproducible. Until now that was the end of the line: findings sat in a table and somebody was
 * supposed to notice. `R18` turns a finding into an OBLIGATION WITH A CLOCK — the client is told
 * what is wrong and given a hard window; if the window closes with no answer, the cargo is frozen
 * (`CT-4`) instead of quietly moving. From the meeting: the window is roughly the flight plus the
 * offload, because that is exactly the time the system has before the decision becomes irreversible.
 *
 * WHY A TABLE AND NOT A COLUMN ON `operaciones`. A caso can carry several requerimientos (a second
 * finding after a re-parse, a second client after a re-ingest of a shared MAWB), each with its own
 * deadline and its own resolution. More importantly the row has to survive its own resolution: the
 * question asked six weeks later is not "is this caso clean?" but "was this client warned, when, on
 * what evidence, and did they answer before the deadline?". A boolean cannot answer that; a closed
 * row can.
 *
 * THE `reason_codes` / `ruleset_version` / `ruleset_hash` TRIPLE is the point of the whole design and
 * not decoration. The requerimiento quotes the engine's output verbatim, alongside the version and
 * hash of the ruleset that produced it, so the demand made of the client is REPRODUCIBLE: run that
 * ruleset over that manifest again and the same findings come out. A requirement that cannot be
 * re-derived is an opinion, and an opinion is not something you stop somebody's cargo over.
 *
 * WHY THE NOTIFICATION STATE IS PART OF THIS TABLE, AND WHY IT GATES EXPIRY. From the plan's risk
 * register: *"No arrancar el reloj sin confirmación de envío"*. Outbound SMTP is provisioned by a
 * human (backlog #22) and may be absent; when it is, `services/mailer.ts` returns `omitido` and this
 * row records exactly that. The expiry sweep then REFUSES to expire it — `notificado_at IS NULL`
 * means the client was never told, and expiring a deadline against somebody who was never warned,
 * then freezing their cargo for missing it, is precisely the injustice this platform exists to make
 * impossible. The requerimiento stays `abierto` and visibly un-notified until mail works, and the
 * tick retries the notification. That is why `vence_at` (a computed calendar fact) and
 * `notificado_at` (a delivery fact) are separate columns rather than one.
 *
 * `vence_at` is `eta_pais + ventana de descarga` (default 3 h, PRD-02 §16 supuestos, overridable via
 * `REQUERIMIENTO_VENTANA_HORAS`). `ventana_horas` stores the window actually used so the deadline
 * can be re-derived from the ETA on file instead of being an unexplained timestamp — the same
 * discipline as `ruleset_version`.
 *
 * `hold_id` is the CT-4 link. When the sweep expires a requerimiento it opens an `operacion_holds`
 * row of tipo `riesgo`, and that hold's id is stored here. Without the link, a late resolution
 * (`riesgo_vencido → riesgo_ok`, §8.4) would leave the freeze standing with nobody able to say which
 * hold belonged to which requerimiento — a freeze that outlives its reason, which is the exact
 * failure `routes/holds.ts` warns about. SET NULL, not CASCADE: losing the hold row must never take
 * the requerimiento with it.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('riesgo_requerimientos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    /**
     * Which house guía the demand is about, when it is about one. SET NULL rather than CASCADE for
     * the same reason as in `operacion_holds`: a re-ingest that drops a line must not erase the
     * record that a client was given a deadline.
     */
    operacion_guia_id: { type: 'uuid', references: 'operacion_guias', onDelete: 'SET NULL' },
    /** The scored shipment the findings came from, when the demand narrows to a single partida. */
    shipment_id: { type: 'uuid', references: 'shipments', onDelete: 'SET NULL' },
    /**
     * The engine's `ReasonCode[]`, copied in full. notNull with no default: a requerimiento that
     * cannot say WHAT is wrong is not a requerimiento, it is a delay with paperwork.
     */
    reason_codes: { type: 'jsonb', notNull: true },
    ruleset_version: { type: 'text' },
    ruleset_hash: { type: 'text' },
    /** Free text the client actually reads, in English (`N6`). Optional: the reason codes are the record. */
    detalle: { type: 'text' },

    // ---- the clock -----------------------------------------------------------------------------
    vence_at: { type: 'timestamptz', notNull: true },
    /** The window used to derive `vence_at` from `eta_pais`, so the deadline stays re-derivable. */
    ventana_horas: { type: 'numeric' },
    /** The ETA the deadline was computed from — it can move later, and then this is the audit answer. */
    eta_base: { type: 'timestamptz' },

    // ---- lifecycle -----------------------------------------------------------------------------
    /**
     * `cancelado` exists for the case where the finding turns out to be ours: a re-parse fixes a
     * misread weight and the demand should never have been made. Withdrawing it explicitly is
     * honest; deleting the row, or letting it expire and freezing the client's cargo over our own
     * error, is not.
     */
    estado: {
      type: 'text',
      notNull: true,
      default: 'abierto',
      check: "estado IN ('abierto','resuelto','vencido','cancelado')",
    },
    /**
     * Delivery, tracked separately from `estado` because they answer different questions. `omitida`
     * is the SMTP-not-configured case (#22) and `error` a transient failure; both keep `notificado_at`
     * NULL, and the sweep will not start the clock on either.
     */
    notificacion_estado: {
      type: 'text',
      notNull: true,
      default: 'pendiente',
      check: "notificacion_estado IN ('pendiente','enviada','omitida','error')",
    },
    /** NULL until a message was actually accepted by a mail server. The gate on expiry. */
    notificado_at: { type: 'timestamptz' },
    /** Who we told. Kept on the row, not resolved on read: `clients.email` changes, history does not. */
    destinatario_email: { type: 'text' },
    /** Why a notification was omitted, or how it failed. Plain text — it is read by a human. */
    notificacion_detalle: { type: 'text' },
    notificacion_intentos: { type: 'integer', notNull: true, default: 0 },

    resuelto_at: { type: 'timestamptz' },
    resuelto_por: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    resolucion_nota: { type: 'text' },
    /** The document the client sent back. SET NULL: the resolution stands even if the file is lost. */
    evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    vencido_at: { type: 'timestamptz' },
    /** The CT-4 freeze this requerimiento's expiry opened, so its resolution can lift exactly that one. */
    hold_id: { type: 'uuid', references: 'operacion_holds', onDelete: 'SET NULL' },

    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  /**
   * The expiry sweep's index (PRD-02 §11): "which open requerimientos are past their deadline?", run
   * on every tick. Partial on `estado = 'abierto'` because resolved and expired rows accumulate
   * forever while the open set stays small — the same reasoning as `operacion_holds_activo_idx`.
   */
  pgm.createIndex('riesgo_requerimientos', ['vence_at'], {
    name: 'riesgo_requerimientos_abiertos_vence_idx',
    where: "estado = 'abierto'",
  });
  // The caso detail screen and the control tower's countdown column.
  pgm.createIndex('riesgo_requerimientos', 'operacion_id');
  pgm.createIndex('riesgo_requerimientos', 'operacion_guia_id');
  /**
   * The retry queue: open requerimientos the client was never actually told about. Small by
   * construction (it should be empty whenever SMTP is healthy), and the tick reads it every run.
   */
  pgm.createIndex('riesgo_requerimientos', ['created_at'], {
    name: 'riesgo_requerimientos_sin_notificar_idx',
    where: "estado = 'abierto' AND notificado_at IS NULL",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('riesgo_requerimientos');
}
