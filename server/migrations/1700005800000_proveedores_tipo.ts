import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `transportistas.tipo` — generaliza el catálogo a proveedores.
 *
 * POR QUÉ: la junta del 15-sep pidió un módulo de proveedores para aerolíneas, recinto fiscalizado
 * y almacén, con contratos, porque la audiencia de este sistema incluye a la autoridad y un
 * proveedor sin contrato visible es el hueco que una auditoría señala.
 *
 * POR QUÉ AQUÍ Y NO EN UNA TABLA NUEVA: un transportista ya *es* un proveedor. Duplicar la tabla
 * obligaría a duplicar también convenios, vigencias, tarifas y el hash del contrato — y después a
 * unificarlas, que es exactamente la deuda que este esquema ya arrastra entre `convenios` y
 * `transportista_convenios`. Un campo discriminante da dos secciones en la interfaz sin partir el
 * modelo en dos.
 *
 * DEFAULT 'transportista' Y BACKFILL EXPLÍCITO: toda fila existente es un transportista, así que
 * nadie pierde nada y ninguna consulta anterior cambia de resultado. El default cubre además las
 * inserciones de código que todavía no conoce la columna.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('transportistas', {
    tipo: {
      type: 'text',
      notNull: true,
      default: 'transportista',
      check: "tipo IN ('transportista','aerolinea','recinto','almacen')",
    },
  });

  // Explícito aunque el default ya lo cubra: deja el estado inicial escrito en la migración en vez
  // de depender de que alguien recuerde cuál era el default cuando lea esto dentro de un año.
  pgm.sql("UPDATE transportistas SET tipo = 'transportista' WHERE tipo IS NULL");

  // El listado siempre filtra por tipo (una sección muestra transportistas, la otra el resto).
  pgm.createIndex('transportistas', 'tipo');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('transportistas', 'tipo');
  pgm.dropColumn('transportistas', 'tipo');
}
