import { pool } from '../../src/db/pool';

export async function truncateAll(): Promise<void> {
  await pool.query(
    // operacion_eventos is append-only via trigger, but TRUNCATE does not fire row-level triggers,
    // so it can be reset here exactly like audit_log.
    `TRUNCATE users, audit_log, files, manifests, shipments, monthly_history, clients, client_platforms, config, pedimento_scans, pedimentos, validated_rfcs, manifest_staging_rows, agentes_aduanales, importadores, operaciones, operacion_guias, operacion_eventos, operacion_evidencias, prealertas, prealerta_adjuntos, operacion_holds, retenciones, riesgo_requerimientos, riesgo_disposiciones, replan_evaluaciones, replan_acciones, despachos, despacho_partidas, plan_publicaciones, transportistas, transportista_unidades, transportista_convenios, transportista_tarifas, client_direcciones, pods, client_tarifas, facturas, factura_partidas, convenios RESTART IDENTITY CASCADE`,
  );
}
