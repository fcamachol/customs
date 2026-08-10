import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `convenios` — the client service agreement, signed digitally with NOM-151 conservation evidence
 * (PRD-02 Excel item 8, `docs/PRD_sistema_operaciones_agora.md` §"Firma electrónica": "Integración
 * Cincel (NOM-151) ya construida — relevante para R25/D9"; `docs/PRD_sistema_operaciones.md` D9:
 * "Fernando decidió emitirlos firmados digitalmente con certificado, para no tener papel en ningún
 * lado"). This is fase-2 work, scoped deliberately narrow: it anchors to `clients` (which already
 * exists) rather than to the `transportistas` catalog the full R25 design references, because that
 * catalog is backlog #29 and not yet built. The upload+signature MECHANISM is identical either way —
 * a hashed file, a Cincel request, a signed-evidence artifact — so building it against `clients` now
 * means #29 can point a `transportista_convenios` row at the same machinery later instead of
 * duplicating it.
 *
 * THE LIFECYCLE, AND WHY IT IS SHAPED LIKE `riesgo_requerimientos`'s notification tracking
 * (`1700004700000_riesgo_requerimientos.ts`). `services/cincel.ts` mirrors `services/mailer.ts`
 * (#22): unconfigured or failing, it degrades to an outcome rather than throwing, and MUST NOT be
 * allowed to make the row lie about what actually reached Cincel. So — same discipline as the
 * requerimiento's `notificacion_estado`/`notificado_at` split — the dispatch outcome is tracked apart
 * from the row's authoritative `estado_firma`, and `estado_firma` only ever advances to `solicitada`
 * on a confirmed send (`solicitado_at` set). `omitida` (CINCEL_* unset) or `error` (the API call
 * failed) leave `estado_firma = 'borrador'` so the retry (a repeated `POST .../firmar`) is visibly
 * still needed — there is no clock here to protect, but the same lie ("we treated an unsent request
 * as sent") would misinform whoever is reading the convenio's state next.
 *
 * `cincel_solicitud_id` is Cincel's own reference for the signature request; the completion webhook
 * (`routes/convenios.ts`) correlates its callback against this column, so it is UNIQUE. `firma_url`
 * is the link the signer follows, kept only for convenience (no outbound-email path exists yet to
 * send it anywhere — that is #22/#31's job, not this one).
 *
 * `firma_evidencia_file_id` is the NOM-151 conservation constancy Cincel returns on completion —
 * legally the point of the whole feature — stored the same way every other artifact in this system
 * is: hashed and written through `storage/files.ts` BEFORE the row is marked `firmada` (rule R-A,
 * evidence before the fact it backs). `file_id` (SET NULL) is the uploaded, unsigned document itself;
 * losing either blob must never erase the row that proves what happened and when.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('convenios', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    /** The uploaded, unsigned convenio document. SET NULL: a lost blob must not erase the record. */
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    vigencia_desde: { type: 'date' },
    vigencia_hasta: { type: 'date' },

    /**
     * The authoritative signature state. Only ever set to `solicitada` on a CONFIRMED dispatch to
     * Cincel (see the module doc comment above) and to `firmada` by the completion webhook; `error`
     * covers a dispatch attempt that reached Cincel's API but failed, so it is distinguishable from
     * `borrador` (nothing attempted yet).
     */
    estado_firma: {
      type: 'text',
      notNull: true,
      default: 'borrador',
      check: "estado_firma IN ('borrador','solicitada','firmada','error')",
    },

    /** Cincel's own id for the signature request. Correlates the completion webhook back to this row. */
    cincel_solicitud_id: { type: 'text', unique: true },
    /** The signer's link, kept for convenience only — nothing in this system emails it yet. */
    firma_url: { type: 'text' },

    // ---- dispatch tracking, same discipline as riesgo_requerimientos.notificacion_* -------------
    /** `enviada` only on a confirmed Cincel accept; `omitida` = CINCEL_* unset; `error` = API failure. */
    solicitud_firma_estado: {
      type: 'text',
      check: "solicitud_firma_estado IN ('enviada','omitida','error')",
    },
    solicitud_firma_detalle: { type: 'text' },
    solicitud_firma_intentos: { type: 'integer', notNull: true, default: 0 },
    /** NULL until Cincel actually accepted the request. Mirrors `notificado_at`'s gating role. */
    solicitado_at: { type: 'timestamptz' },

    // ---- completion (the NOM-151 evidence) --------------------------------------------------------
    firmado_at: { type: 'timestamptz' },
    /** Cincel's document/request id at completion time, kept even if `cincel_solicitud_id` is reused. */
    firma_referencia: { type: 'text' },
    /** The conservation constancy Cincel returns — hashed and stored like any other evidence. */
    firma_evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },

    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The per-client listing (control tower / admin screen) and the FK join.
  pgm.createIndex('convenios', 'client_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('convenios');
}
