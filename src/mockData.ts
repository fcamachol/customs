import { 
  GuideRecord, 
  ManifestActivity, 
  DocumentItem, 
  AuditTrailEvent, 
  ComplianceRule, 
  ParsingRecord,
  AuthorityPendingItem,
  OperationLogItem
} from './types';

export const initialGuideRecords: GuideRecord[] = [
  {
    id: 'rec_1',
    guideId: 'MX-HD-90812',
    importerName: 'Logistics Express SA',
    htsCode: '8517.12.01',
    description: '"Electronic device" (Celulares y Smart devices)',
    declaredValue: 12450.00,
    riskLevel: 'CRITICAL',
    flags: ['notes', 'location']
  },
  {
    id: 'rec_2',
    guideId: 'MX-HD-90815',
    importerName: 'Global Trade Corp',
    htsCode: '6204.43.01',
    description: 'Synthetic Apparel (Vestidos de fibras sintéticas)',
    declaredValue: 8200.00,
    riskLevel: 'WARNING',
    flags: ['wallet']
  },
  {
    id: 'rec_3',
    guideId: 'MX-HD-90816',
    importerName: 'Retail Solutions',
    htsCode: '9503.00.01',
    description: 'Plastic Toys Assorted (Juguetes de plástico surtidos)',
    declaredValue: 450.00,
    riskLevel: 'CLEARED',
    flags: []
  },
  {
    id: 'rec_4',
    guideId: 'MX-HD-90822',
    importerName: 'Suministros Industriales',
    htsCode: '2804.10.01',
    description: 'Hydrogen Gas Tank (Tanque de gas Hidrógeno industrial)',
    declaredValue: 2300.00,
    riskLevel: 'PROHIBITED',
    flags: ['warning']
  },
  {
    id: 'rec_5',
    guideId: 'MX-HD-90831',
    importerName: 'Puebla Import Co.',
    htsCode: '3926.90.99',
    description: 'Polymers and Resins (Manufacturas de plástico)',
    declaredValue: 3120.00,
    riskLevel: 'CLEARED',
    flags: []
  },
  {
    id: 'rec_6',
    guideId: 'MX-HD-90842',
    importerName: 'Industrial De Regio SA',
    htsCode: '8471.30.01',
    description: 'Laptop Computer Accessories (Partes de computadoras portátiles)',
    declaredValue: 15400.00,
    riskLevel: 'CLEARED',
    flags: []
  },
  {
    id: 'rec_7',
    guideId: 'MX-HD-90855',
    importerName: 'Automotriz del Norte',
    htsCode: '8708.29.99',
    description: 'Auto Parts Unspecified (Fracción incorrecta)',
    declaredValue: 45100.00,
    riskLevel: 'WARNING',
    flags: ['wallet', 'warning']
  }
];

export const initialManifestActivities: ManifestActivity[] = [
  {
    id: 'MX-2024-00129',
    origin: 'HKG',
    destination: 'MEX',
    items: 452,
    assignedAgent: 'C. Hernandez',
    status: 'VALIDADO',
    timestamp: '10:42:15 AM'
  },
  {
    id: 'US-2024-08412',
    origin: 'ORD',
    destination: 'NLD',
    items: 1208,
    assignedAgent: 'R. Sanchez',
    status: 'EN COLA',
    timestamp: '10:38:22 AM'
  },
  {
    id: 'CA-2024-00994',
    origin: 'YYZ',
    destination: 'TIJ',
    items: 84,
    assignedAgent: 'System (AI)',
    status: 'RECHAZADO',
    timestamp: '10:25:01 AM'
  },
  {
    id: 'DE-2024-00331',
    origin: 'FRA',
    destination: 'MEX',
    items: 215,
    assignedAgent: 'L. Gomez',
    status: 'PAGO PENDIENTE',
    timestamp: '10:14:55 AM'
  },
  {
    id: 'ES-2024-00562',
    origin: 'MAD',
    destination: 'MEX',
    items: 312,
    assignedAgent: 'C. Hernandez',
    status: 'VALIDADO',
    timestamp: '09:55:12 AM'
  }
];

export const initialDocumentItems: DocumentItem[] = [
  {
    id: 1,
    name: '1. Manifiesto Original',
    uuidOrMeta: 'UUID: 8f2b-45e1-92cc-410a',
    type: 'MANIFESTO'
  },
  {
    id: 2,
    name: '2. Reporte de Análisis de Riesgo',
    uuidOrMeta: 'Compliance Score: 98%',
    type: 'RISK_RPT'
  },
  {
    id: 3,
    name: '3. Pedimento T1',
    uuidOrMeta: 'No. 241230040001854',
    type: 'PEDIMENTO'
  },
  {
    id: 4,
    name: '4. Reporte General de Importación',
    uuidOrMeta: 'Generated: 2024-05-20 14:22',
    type: 'REPORT'
  }
];

export const initialAuditTrailEvents: AuditTrailEvent[] = [
  {
    id: 'at_1',
    timestamp: '2024-05-21 16:45:12',
    title: 'Actualización de Estado: DESADUANADO',
    actor: 'SYSTEM',
    description: 'Despacho automático recibido desde el WebService del SAT.',
    ip: '187.162.4.22',
    agentId: 'API_AUTO_01'
  },
  {
    id: 'at_2',
    timestamp: '2024-05-21 14:30:05',
    title: 'Expediente Bloqueado para Auditoría',
    actor: 'AUDITOR',
    description: 'A. Martínez revisó toda la documentación obligatoria para el envío R-229.',
    ip: '192.168.10.45',
    session: 'UA_9921'
  },
  {
    id: 'at_3',
    timestamp: '2024-05-20 09:12:33',
    title: 'Carga de Documento: Pedimento T1',
    actor: 'USER',
    description: 'Subido por M. Sánchez (Operador). Checksum MD5 verificado.',
    ip: '201.144.112.5',
    file: 'PED_T1_FINAL.pdf'
  }
];

export const initialComplianceRules: ComplianceRule[] = [
  {
    id: 'RF-01',
    title: 'RF-01 Validar ID',
    description: 'Verificar el formato del identificador de manifiesto.',
    status: 'checked'
  },
  {
    id: 'RF-02',
    title: 'RF-02 Validar Cantidad',
    description: 'Verificar que las cantidades declaradas sean mayores a cero.',
    status: 'checked'
  },
  {
    id: 'RF-03',
    title: 'RF-03 Validar MYP',
    description: 'Discrepancia encontrada en la conversión de unidades.',
    status: 'warning'
  },
  {
    id: 'RF-04',
    title: 'RF-04 Validar HS Code',
    description: 'Cotejo cruzado con la base de datos de tarifas arancelarias.',
    status: 'pending'
  },
  {
    id: 'RF-05',
    title: 'RF-05 Cálculo de Impuestos',
    description: 'Verificar conciliación de totales de IGI/IVA.',
    status: 'pending'
  },
  {
    id: 'RF-06',
    title: 'RF-06 Validación de Proveedor',
    description: 'Cotejar RFC y TAX ID del proveedor extranjero.',
    status: 'none'
  },
  {
    id: 'RF-07',
    title: 'RF-07 Verificación de Origen',
    description: 'Validar restricciones del país de origen de la mercancía.',
    status: 'none'
  },
  {
    id: 'RF-08',
    title: 'RF-08 Sellos de Cumplimiento',
    description: 'Verificar certificaciones de seguridad correspondientes.',
    status: 'none'
  },
  {
    id: 'RF-09',
    title: 'RF-09 Variación de Peso',
    description: 'Verificar desviación entre peso físico vs declared.',
    status: 'none'
  },
  {
    id: 'RF-10',
    title: 'RF-10 Verificación de Valor',
    description: 'Verificar valores declarados contra índices de precios de referencia.',
    status: 'none'
  },
  {
    id: 'RF-11',
    title: 'RF-11 Sumatoria de Manifiesto',
    description: 'Verificar que la suma total coincida con las hojas maestras del expediente.',
    status: 'none'
  }
];

export const initialParsingRecords: ParsingRecord[] = [
  {
    manifestId: 'MX-8892-K',
    hsCode: '8517.13.01',
    description: 'Smartphones de Gama Alta (Dispositivos Apple y Samsung importados)',
    quantity: 450,
    unit: 'PCE',
    weight: 112.50,
    status: 'READY'
  },
  {
    manifestId: 'MX-8892-L',
    hsCode: '8471.30.01',
    description: 'Computadoras Portátiles (Mapeo defectuoso de cantidad de SKU)',
    quantity: 0,
    unit: 'PCE',
    weight: 340.00,
    status: 'ERROR'
  },
  {
    manifestId: 'MX-8893-A',
    hsCode: '4011.10.01',
    description: 'Llantas de Goma para Auto (Llantas radiales de alta velocidad)',
    quantity: 1200,
    unit: 'KGM',
    weight: 8400.00,
    status: 'READY'
  },
  {
    manifestId: 'MX-8893-B',
    hsCode: '2204.21.01',
    description: 'Vino Tinto de Mesa (Cajas de Cabernet Sauvignon)',
    quantity: 2400,
    unit: 'LTR',
    weight: 2880.00,
    status: 'READY'
  },
  {
    manifestId: 'MX-8894-X',
    hsCode: '9021.10.01',
    description: 'Aparatos Ortopédicos (Soportes de rodillas y articulaciones)',
    quantity: 75,
    unit: 'SET',
    weight: 15.00,
    status: 'READY'
  },
  {
    manifestId: 'MX-8895-Z',
    hsCode: '6109.10.01',
    description: 'Camisetas de Algodón para Hombre (Excedente de stock comercial)',
    quantity: 5000,
    unit: 'PCE',
    weight: 750.00,
    status: 'READY'
  }
];

export const initialAuthorityItems: AuthorityPendingItem[] = [
  {
    reference: 'AG-2023-9912',
    mawbEntry: '023-44558231',
    fechaArribo: '2023-10-27',
    riskLevel: 'Bajo',
    status: 'PENDIENTE'
  },
  {
    reference: 'AG-2023-9908',
    mawbEntry: '180-22104556',
    fechaArribo: '2023-10-26',
    riskLevel: 'Medio',
    status: 'AUDITADO'
  },
  {
    reference: 'AG-2023-9892',
    mawbEntry: '405-77812039',
    fechaArribo: '2023-10-26',
    riskLevel: 'Crítico',
    status: 'PENDIENTE'
  }
];

export const initialOperationLogs: OperationLogItem[] = [
  {
    timestamp: '27 OCT 13:45:11',
    message: 'Modificación de Fracción Arancelaria (HTS 8471.30.01) - Validado por Regla 8.',
    actorCode: 'ID: USER_882',
    type: 'normal'
  },
  {
    timestamp: '27 OCT 12:22:04',
    message: 'Rechazo de Validación COFEPRIS - Falta Certificado Sanitario.',
    actorCode: 'SYSTEM_AUTO',
    type: 'error'
  },
  {
    timestamp: '27 OCT 10:15:33',
    message: 'Pago de Pedimento Confirmado - Referencia BANCO-00923188.',
    actorCode: 'ID: OP_MARIA',
    type: 'success'
  },
  {
    timestamp: '27 OCT 09:02:18',
    message: 'Creación de Manifiesto Consolidado (MAWB-44558231).',
    actorCode: 'ID: AG_RAMIRO',
    type: 'normal'
  }
];
