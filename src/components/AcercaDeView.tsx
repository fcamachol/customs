import { useEffect, useState } from 'react';
import { Card } from './ui';
import { apiGet } from '../api';

interface BrandingConfig {
  logoUrl?: string;
  rfc?: string;
  companyName?: string;
}

interface ConfigResponse<T> {
  key: string;
  value: T | null;
}

const DEFAULT_COMPANY = 'Capital Centennials';
const DEFAULT_RFC = 'CAP010101CAP';

export function AcercaDeView() {
  const [branding, setBranding] = useState<BrandingConfig>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<ConfigResponse<BrandingConfig>>('/api/catalogs/config/branding')
      .then((res) => { if (res.value) setBranding(res.value); })
      .catch(() => { /* fall back to defaults */ })
      .finally(() => setLoading(false));
  }, []);

  const companyName = branding.companyName || DEFAULT_COMPANY;
  const rfc = branding.rfc || DEFAULT_RFC;

  return (
    <div className="space-y-6">
      {/* Company identity */}
      <Card className="p-6 shadow-sm">
        <div className="flex items-center gap-4">
          {branding.logoUrl && (
            <img src={branding.logoUrl} alt={`${companyName} logo`} className="h-14 w-auto object-contain" />
          )}
          <div>
            <h2 className="text-lg font-bold text-navy-800">{companyName}</h2>
            <p className="text-xs font-mono text-slate-500 mt-0.5">RFC: {loading ? '…' : rfc}</p>
          </div>
        </div>
      </Card>

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

      {/* Marco Legal (RF-19) */}
      <Card className="p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-navy-800">Marco Legal</h3>
        <div className="space-y-3 text-sm text-slate-600">
          <div>
            <span className="font-semibold text-slate-700">Ley Aduanera (Art. 14/14-A):</span>{' '}
            Regula la operación de empresas de mensajería bajo el régimen de tránsito interno (T1), incluyendo los
            requisitos de concesión para el transporte de mercancías extranjeras en territorio nacional.
          </div>
          <div>
            <span className="font-semibold text-slate-700">RGCE 3.7.35:</span>{' '}
            Establece las tasas globales aplicables a importaciones bajo régimen de paquetería y mensajería:
            33.5% estándar, 19% preferencial USMCA, y de minimis exento hasta $50 USD.
          </div>
          <div>
            <span className="font-semibold text-slate-700">Art. 69-B CFF (EFOS):</span>{' '}
            Obliga a verificar que los destinatarios no figuren en el listado de Empresas que Facturan
            Operaciones Simuladas publicado por el SAT.
          </div>
          <div>
            <span className="font-semibold text-slate-700">Registro ANAM 78/LA:</span>{' '}
            Las empresas de mensajería que operan T1 deben contar con el registro ante la Agencia Nacional
            de Aduanas de México, cumpliendo los requisitos de inversión, fianza y controles de seguridad.
          </div>
          <div>
            <span className="font-semibold text-slate-700">NOM y regulaciones COFEPRIS:</span>{' '}
            Ciertos artículos (medicamentos, suplementos, cosméticos) requieren permisos de importación
            adicionales por parte de la Comisión Federal para la Protección contra Riesgos Sanitarios.
          </div>
        </div>
      </Card>
    </div>
  );
}
