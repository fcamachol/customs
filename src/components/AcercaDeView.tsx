import { Card } from './ui';

export function AcercaDeView() {
  return (
    <div className="space-y-6">
      {/* Intro */}
      <Card className="p-6 shadow-sm">
        <p className="text-sm leading-relaxed text-slate-600">
          Somos una empresa líder en importaciones de mensajería y paquetería con experiencia, enfocada
          en optimizar la cadena de suministro de nuestros clientes.
        </p>
      </Card>

      {/* Misión */}
      <Card className="p-6 shadow-sm">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">Misión</h3>
        <p className="text-sm leading-relaxed text-slate-600">
          Brindar soluciones de importación bajo el esquema T1 en México con los más altos estándares
          de honestidad, trazabilidad y cumplimiento, ofreciendo a nuestros clientes un servicio
          eficiente, transparente y confiable.
        </p>
      </Card>

      {/* Visión */}
      <Card className="p-6 shadow-sm">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">Visión</h3>
        <p className="text-sm leading-relaxed text-slate-600">
          Ser la empresa referente en México en operaciones de importación T1, reconocida por su
          credibilidad, profesionalismo y elegancia operativa en el manejo del comercio internacional.
        </p>
      </Card>

      {/* Valores */}
      <Card className="p-6 shadow-sm">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">Valores</h3>
        <p className="text-sm leading-relaxed text-slate-600">
          Puntualidad, Integridad y Trazabilidad
        </p>
      </Card>
    </div>
  );
}
