/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type RiskLevel = 'CRITICAL' | 'WARNING' | 'CLEARED' | 'PROHIBITED';

export interface GuideRecord {
  id: string;
  guideId: string;
  importerName: string;
  htsCode: string;
  description: string;
  declaredValue: number;
  riskLevel: RiskLevel;
  flags: ('notes' | 'location' | 'wallet' | 'warning')[];
}

export interface ManifestActivity {
  id: string; // matches Ref ID e.g., MX-2024-00129
  origin: string;
  destination: string;
  items: number;
  assignedAgent: string;
  status: 'VALIDADO' | 'EN COLA' | 'RECHAZADO' | 'PAGO PENDIENTE';
  timestamp: string;
}

export interface DocumentItem {
  id: number;
  name: string;
  uuidOrMeta: string;
  type: 'MANIFESTO' | 'RISK_RPT' | 'PEDIMENTO' | 'REPORT';
  complianceScore?: string;
  numDoc?: string;
  generatedDate?: string;
}

export interface AuditTrailEvent {
  id: string;
  timestamp: string;
  title: string;
  actor: 'SYSTEM' | 'AUDITOR' | 'USER';
  description: string;
  ip: string;
  agentId?: string;
  session?: string;
  file?: string;
}

export interface ComplianceRule {
  id: string; // e.g., "RF-01"
  title: string;
  description: string;
  status: 'checked' | 'warning' | 'pending' | 'none';
  detail?: string;
}

export interface ParsingRecord {
  manifestId: string;
  hsCode: string;
  description: string;
  quantity: number;
  unit: string;
  weight: number;
  status: 'READY' | 'ERROR';
  importerName?: string;
  declaredValue?: number;
}

export interface AuthorityPendingItem {
  reference: string;
  mawbEntry: string;
  fechaArribo: string;
  riskLevel: 'Bajo' | 'Medio' | 'Crítico';
  status: 'PENDIENTE' | 'AUDITADO';
}

export interface OperationLogItem {
  timestamp: string;
  message: string;
  actorCode: string;
  type: 'normal' | 'error' | 'success';
}
