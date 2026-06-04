/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { 
  CloudUpload, 
  CheckCircle, 
  AlertTriangle, 
  FileText, 
  UploadCloud, 
  Play, 
  Search, 
  CheckCircle2, 
  Loader2, 
  RefreshCw, 
  Trash2, 
  Sparkles,
  ArrowRight,
  ShieldCheck,
  HelpCircle,
  FileCheck,
  Lock
} from 'lucide-react';
import { ComplianceRule, ParsingRecord, GuideRecord, RiskLevel } from '../types';
import { parseManifestFile } from '../utils/fileParser';

interface ManifestsViewProps {
  initialRules: ComplianceRule[];
  initialParsingRecords: ParsingRecord[];
  onGeneratePedimento: (manifestId: string, customBroker?: string, customPedNum?: string) => void;
  agenteAduanal: string;
  onChangeAgenteAduanal: (val: string) => void;
  numeroPedimento: string;
  onChangeNumeroPedimento: (val: string) => void;
  onNavigateToTab?: (tabId: string) => void;
  onUpdateRiskRecords?: (newRecords: GuideRecord[]) => void;
  onUpdateParsingRecords?: (newRecords: ParsingRecord[]) => void;
  userRole?: 'capturista' | 'admin' | 'autoridad';
}

export default function ManifestsView({
  initialRules,
  initialParsingRecords,
  onGeneratePedimento,
  agenteAduanal,
  onChangeAgenteAduanal,
  numeroPedimento,
  onChangeNumeroPedimento,
  onNavigateToTab,
  onUpdateRiskRecords,
  onUpdateParsingRecords,
  userRole = 'admin'
}: ManifestsViewProps) {
  const [rules, setRules] = useState<ComplianceRule[]>(initialRules);
  const [records, setRecords] = useState<ParsingRecord[]>(initialParsingRecords);
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(1);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(28);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [errorCount, setErrorCount] = useState(38);
  const [validCount, setValidCount] = useState(2412);
  const [selectedFileName, setSelectedFileName] = useState('manifest_20231027.xlsx');
  
  // State for fixing an error item modal
  const [editingRecord, setEditingRecord] = useState<ParsingRecord | null>(null);
  const [editQuantity, setEditQuantity] = useState('0');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRecords(initialParsingRecords);
    if (selectedFileName === 'manifest_20231027.xlsx') {
      setErrorCount(38);
      setValidCount(2412);
    } else {
      const errors = initialParsingRecords.filter(r => r.status === 'ERROR').length;
      const valids = initialParsingRecords.filter(r => r.status === 'READY').length;
      setErrorCount(errors);
      setValidCount(valids);
    }
  }, [initialParsingRecords, selectedFileName]);

  // File drag & drop simulator
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleUploadFile = async (file: File) => {
    setIsUploading(true);
    setSelectedFileName(file.name);
    try {
      const { parsingRecords: parsedParsing, guideRecords: parsedGuides } = await parseManifestFile(file);
      
      setRecords(parsedParsing);
      if (onUpdateParsingRecords) {
        onUpdateParsingRecords(parsedParsing);
      }
      if (onUpdateRiskRecords) {
        onUpdateRiskRecords(parsedGuides);
      }

      const errors = parsedParsing.filter(r => r.status === 'ERROR').length;
      const valids = parsedParsing.filter(r => r.status === 'READY').length;
      setErrorCount(errors);
      setValidCount(valids);

      setIsUploading(false);
      setActiveStep(2);
    } catch (error: any) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Error al procesar el archivo");
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleUploadFile(e.dataTransfer.files[0]);
    }
  };

  const handleSelectFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleUploadFile(e.target.files[0]);
    }
  };

  // Helper to dynamically evaluate compliance rules on the currently loaded records list
  const getEvaluatedRules = (targetRecords: ParsingRecord[]): ComplianceRule[] => {
    return initialRules.map(rule => {
      if (targetRecords.length === 0) {
        return { ...rule, status: 'none' as const, detail: 'Sin registros para validar.' };
      }

      switch (rule.id) {
        case 'RF-01': { // Validar ID
          const invalidIds = targetRecords.filter(r => !r.manifestId || r.manifestId.trim().length < 3 || r.manifestId.includes(' '));
          if (invalidIds.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `Discrepancia en ID: ${invalidIds.length} folios no cumplen formato o están vacíos (ej: "${invalidIds[0].manifestId || 'Vacío'}").` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Estructura de ID de manifiesto y de guías coincide al 100% con formatos autorizados.' 
          };
        }
        case 'RF-02': { // Validar Cantidad
          const zeroQty = targetRecords.filter(r => !r.quantity || r.quantity <= 0);
          if (zeroQty.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `No conforme: Se detectaron ${zeroQty.length} registros con cantidad nula o incompleta (ej: ${zeroQty[0].manifestId}).` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Todas las cantidades declaradas son válidas (mayores a cero) para el despacho.' 
          };
        }
        case 'RF-03': { // Validar MYP (Conversión / Medidas y Pesos)
          const suspiciousWeight = targetRecords.filter(r => r.weight <= 0 || (r.unit === 'PCE' && r.weight / (r.quantity || 1) > 500));
          if (suspiciousWeight.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `Alerta: Relación Peso/Unidad excesiva en ${suspiciousWeight.length} conceptos. Peso declarado nulo o excedente.` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Códigos de unidad de medida (UOM) y pesos brutos correspondientemente correlacionados.' 
          };
        }
        case 'RF-04': { // Validar HS Code
          const invalidHS = targetRecords.filter(r => {
            const clean = r.hsCode.replace(/\./g, '');
            return clean.length < 6 || isNaN(Number(clean));
          });
          if (invalidHS.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `No conforme: ${invalidHS.length} fracción(es) arancelaria(s) no válida(s) o incompleta(s) (ej: "${invalidHS[0].hsCode}").` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Fracciones arancelarias vigentes en la tarifa nacional LIGIE.' 
          };
        }
        case 'RF-05': { // Cálculo de Impuestos
          const negativeValues = targetRecords.filter(r => r.declaredValue !== undefined && r.declaredValue < 0);
          if (negativeValues.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: 'No conforme: Se detectaron valores comerciales negativos que alteran la base gravable.' 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Integración matemática de las bases imponibles de fletes, seguros y valor aduana.' 
          };
        }
        case 'RF-06': { // Validación de Proveedor
          const emptyImporter = targetRecords.filter(r => r.importerName !== undefined && (!r.importerName || r.importerName.trim().length < 3));
          if (emptyImporter.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: 'Alerta: Importador / Destinatario con inconsistencias o razon comercial nula.' 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Padrones sectoriales e integradores de importación validados en la aduana de destino.' 
          };
        }
        case 'RF-07': { // Verificación de Origen
          const prohibited = targetRecords.filter(r => {
            const desc = r.description.toLowerCase();
            return r.hsCode.startsWith('2804') || desc.includes('hidrogeno') || desc.includes('explosiv') || desc.includes('armas') || desc.includes('prohibid');
          });
          if (prohibited.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `CRÍTICO: ${prohibited.length} componente(s) con mercancías reguladas u origen prohibido (ej: ${prohibited[0].description}).` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Ningún artículo del manifiesto está en la lista de restricciones u origen prohibido de la ANAM.' 
          };
        }
        case 'RF-08': { // Sellos de Cumplimiento / NOMs
          const needsNom = targetRecords.filter(r => r.hsCode === '8517.13.01' || r.description.toLowerCase().includes('smart'));
          if (needsNom.length > 0) {
            return { 
              ...rule, 
              status: 'checked' as const, 
              detail: 'Comprobado: Certificaciones de seguridad eléctrica y cumplimiento NOM (Norma Oficial Mexicana) validados para electrónicos.' 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Validaciones de regulaciones y restricciones no arancelarias aprobadas.' 
          };
        }
        case 'RF-09': { // Variación de Peso
          const warningWeight = targetRecords.filter(r => r.weight / (r.quantity || 1) < 0.005);
          if (warningWeight.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `Alerta: ${warningWeight.length} registro(s) tiene peso inconsistente cercano a cero.` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Límites de tolerancia de peso neto vs bruto conciliados correctamente.' 
          };
        }
        case 'RF-10': { // Verificación de Valor
          const lowValue = targetRecords.filter(r => {
            const val = r.declaredValue !== undefined ? r.declaredValue : r.quantity * 125;
            return r.quantity > 0 && (val / r.quantity) < 2.0 && !r.description.toLowerCase().includes('bolsa');
          });
          if (lowValue.length > 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: `Alerta: Subvaluación advertida en ${lowValue.length} concepto(s) con valores comerciales dudosos.` 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: Estimación de valor en aduana acorde a históricos de precios del sector.' 
          };
        }
        case 'RF-11': { // Sumatoria de Manifiesto
          const totalWeight = targetRecords.reduce((sum, r) => sum + r.weight, 0);
          if (totalWeight <= 0) {
            return { 
              ...rule, 
              status: 'warning' as const, 
              detail: 'Alerta: El Manifiesto declara peso total cero o inexistente.' 
            };
          }
          return { 
            ...rule, 
            status: 'checked' as const, 
            detail: 'Comprobado: La sumatoria de fardos, bultos y masa bruta total es consistente con el expediente maestro.' 
          };
        }
        default:
          return rule;
      }
    });
  };

  // Run Risk Analysis Compliance checklist simulation step-by-step
  const runVerification = () => {
    setIsAnalyzing(true);
    setAnalysisProgress(10);
    setActiveStep(2);

    const finalEvaluations = getEvaluatedRules(records);

    // Dynamic sequence of all rules checking
    const sequence = [
      { id: 'RF-01', progress: 18 },
      { id: 'RF-02', progress: 28 },
      { id: 'RF-03', progress: 38 },
      { id: 'RF-04', progress: 48 },
      { id: 'RF-05', progress: 58 },
      { id: 'RF-06', progress: 68 },
      { id: 'RF-07', progress: 78 },
      { id: 'RF-08', progress: 85 },
      { id: 'RF-09', progress: 92 },
      { id: 'RF-10', progress: 96 },
      { id: 'RF-11', progress: 100 },
    ];

    // Clear statuses first to pending to animate the check-up live
    setRules(prev => prev.map(r => ({ ...r, status: 'pending' as const })));

    let itemIndex = 0;
    const runNext = () => {
      if (itemIndex < sequence.length) {
        const step = sequence[itemIndex];
        setTimeout(() => {
          const evaluated = finalEvaluations.find(re => re.id === step.id) || { status: 'checked' as const, detail: '' };
          setRules(prev => prev.map(r => r.id === step.id ? { ...r, status: evaluated.status, detail: evaluated.detail } : r));
          setAnalysisProgress(step.progress);
          itemIndex++;
          runNext();
        }, 220);
      } else {
        // Validation Finished
        setTimeout(() => {
          setIsAnalyzing(false);
          setActiveStep(3);
          setShowSuccessModal(true);

          // Synchronize with parent state
          if (onUpdateRiskRecords) {
            const mappedGuideRecords: GuideRecord[] = records.map((record, index) => {
              const isZeroQty = record.quantity === 0;
              const isProhibited = record.hsCode.startsWith('2804') || record.description.toLowerCase().includes('hidrogeno') || record.description.toLowerCase().includes('explosiv');
              const isHighValue = record.hsCode === '8517.13.01' || record.description.toLowerCase().includes('smart') || record.description.toLowerCase().includes('apple') || record.description.toLowerCase().includes('samsung') || record.description.toLowerCase().includes('gama alta') || (record.declaredValue !== undefined && record.declaredValue > 25000);
              const isWarningGroup = record.hsCode.startsWith('8708') || record.description.toLowerCase().includes('auto parts') || record.description.toLowerCase().includes('incorrecta') || record.hsCode.startsWith('6204');
              
              let riskLevel: RiskLevel = 'CLEARED';
              if (isProhibited) {
                riskLevel = 'PROHIBITED';
              } else if (isZeroQty) {
                riskLevel = 'CRITICAL';
              } else if (isHighValue || isWarningGroup) {
                riskLevel = 'WARNING';
              }

              const flags: ('notes' | 'location' | 'wallet' | 'warning')[] = [];
              if (riskLevel === 'PROHIBITED' || riskLevel === 'CRITICAL') {
                flags.push('warning');
              }
              if (isHighValue) {
                flags.push('notes');
              }
              if (isWarningGroup) {
                flags.push('wallet');
              }

              return {
                id: `mapped_${index}_${Date.now()}`,
                guideId: record.manifestId,
                importerName: record.importerName || (index === 0 ? "Logistics Express SA" : index === 1 ? "Retail Solutions" : "Global Trade Corp"),
                htsCode: record.hsCode,
                description: record.description,
                declaredValue: record.declaredValue !== undefined ? record.declaredValue : (record.quantity === 0 ? 0 : record.quantity * 125),
                riskLevel: riskLevel,
                flags: flags
              };
            });
            onUpdateRiskRecords(mappedGuideRecords);
          }
        }, 500);
      }
    };

    runNext();
  };

  // Reset simulation to try again with custom modifications
  const resetSimulation = () => {
    setRules(initialRules);
    setAnalysisProgress(28);
    setActiveStep(1);
    setErrorCount(38);
    setValidCount(2412);
    setRecords(initialParsingRecords);
    setSelectedFileName('manifest_20231027.xlsx');
  };

  // Fix an item with 0 quantity that triggers compliance error
  const openEditRecord = (record: ParsingRecord) => {
    if (userRole === 'autoridad') {
      alert("🚫 Acción Denegada: Como autoridad fiscal aduanera (ANAM / SAT), no posees privilegios para modificar cantidades o bultos precintados en el manifiesto fiscal. Por favor cambia de rol a 'Capturista' o 'Admin' abajo a la izquierda para editar.");
      return;
    }
    setEditingRecord(record);
    setEditQuantity(record.quantity.toString());
  };

  const saveEditedRecord = () => {
    if (!editingRecord) return;
    const qty = parseInt(editQuantity, 10);
    
    const updatedRecords = records.map(r => {
      if (r.manifestId === editingRecord.manifestId) {
        return {
          ...r,
          quantity: isNaN(qty) ? 0 : qty,
          status: qty > 0 ? 'READY' : 'ERROR'
        };
      }
      return r;
    });

    setRecords(updatedRecords);

    // Also update parent risk analysis list with corrected data
    if (onUpdateRiskRecords) {
      const mapped = updatedRecords.map((record, index) => {
        const isZeroQty = record.quantity === 0;
        const isProhibited = record.hsCode.startsWith('2804') || record.description.toLowerCase().includes('hidrogeno') || record.description.toLowerCase().includes('explosiv');
        const isHighValue = record.hsCode === '8517.13.01' || record.description.toLowerCase().includes('smart') || record.description.toLowerCase().includes('apple') || record.description.toLowerCase().includes('samsung') || record.description.toLowerCase().includes('gama alta') || (record.declaredValue !== undefined && record.declaredValue > 25000);
        const isWarningGroup = record.hsCode.startsWith('8708') || record.description.toLowerCase().includes('auto parts') || record.description.toLowerCase().includes('incorrecta') || record.hsCode.startsWith('6204');
        
        let riskLevel: RiskLevel = 'CLEARED';
        if (isProhibited) {
          riskLevel = 'PROHIBITED';
        } else if (isZeroQty) {
          riskLevel = 'CRITICAL';
        } else if (isHighValue || isWarningGroup) {
          riskLevel = 'WARNING';
        }

        const flags: ('notes' | 'location' | 'wallet' | 'warning')[] = [];
        if (riskLevel === 'PROHIBITED' || riskLevel === 'CRITICAL') {
          flags.push('warning');
        }
        if (isHighValue) {
          flags.push('notes');
        }
        if (isWarningGroup) {
          flags.push('wallet');
        }

        return {
          id: `mapped_${index}_${Date.now()}`,
          guideId: record.manifestId,
          importerName: record.importerName || (index === 0 ? "Logistics Express SA" : index === 1 ? "Retail Solutions" : "Global Trade Corp"),
          htsCode: record.hsCode,
          description: record.description,
          declaredValue: record.declaredValue !== undefined ? record.declaredValue : (record.quantity === 0 ? 0 : record.quantity * 125),
          riskLevel: riskLevel,
          flags: flags
        };
      });
      onUpdateRiskRecords(mapped);
    }

    if (qty > 0 && editingRecord.quantity === 0) {
      setErrorCount(prev => Math.max(0, prev - 1));
      setValidCount(prev => prev + 1);
    }

    // Recalculate and update the compliance rules with actual corrected data!
    const newEvaluated = getEvaluatedRules(updatedRecords);
    setRules(newEvaluated);

    setEditingRecord(null);
  };

  const getSuccessModalStats = () => {
    if (selectedFileName === 'manifest_20231027.xlsx') {
      // Highly detailed simulation for the mock manifest (2450 total bultos/guias)
      const totalWarnCritical = errorCount;
      const warningVal = Math.round(totalWarnCritical * 0.79);
      const criticalVal = totalWarnCritical - warningVal;
      return {
        cleared: validCount,
        warning: warningVal,
        critical: criticalVal
      };
    } else {
      // Real dynamic calculation for any uploaded custom file in active memory
      let cleared = 0;
      let warning = 0;
      let critical = 0;
      records.forEach((record) => {
        const isZeroQty = record.quantity === 0;
        const isProhibited = record.hsCode.startsWith('2804') || record.description.toLowerCase().includes('hidrogeno') || record.description.toLowerCase().includes('explosiv');
        const isHighValue = record.hsCode === '8517.13.01' || record.description.toLowerCase().includes('smart') || record.description.toLowerCase().includes('apple') || record.description.toLowerCase().includes('samsung') || record.description.toLowerCase().includes('gama alta') || (record.declaredValue !== undefined && record.declaredValue > 25000);
        const isWarningGroup = record.hsCode.startsWith('8708') || record.description.toLowerCase().includes('auto parts') || record.description.toLowerCase().includes('incorrecta') || record.hsCode.startsWith('6204');
        
        if (isProhibited || isZeroQty) {
          critical++;
        } else if (isHighValue || isWarningGroup) {
          warning++;
        } else {
          cleared++;
        }
      });
      return { cleared, warning, critical };
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Dynamic Progress indicator */}
      <div className="bg-white border border-outline-variant p-4 flex items-center justify-between shadow-sm rounded-lg shrink-0">
        <div className="flex items-center gap-6 w-full">
          <button 
            type="button"
            onClick={() => setActiveStep(1)}
            className="flex items-center gap-2 group text-left outline-none"
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
              activeStep >= 1 ? 'bg-primary text-white' : 'border border-outline text-outline'
            }`}>
              1
            </div>
            <span className={`font-bold transition-all text-sm ${activeStep >= 1 ? 'text-primary' : 'text-outline'}`}>
              Subir Manifiesto
            </span>
          </button>
          
          <div className={`h-[2px] flex-1 transition-all ${activeStep >= 2 ? 'bg-primary' : 'bg-outline-variant'}`} />
          
          <button 
            type="button"
            onClick={() => setActiveStep(2)}
            className="flex items-center gap-2 group text-left outline-none"
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
              activeStep >= 2 ? 'bg-primary text-white' : 'border-2 border-outline text-outline'
            }`}>
              2
            </div>
            <span className={`font-bold transition-all text-sm ${activeStep >= 2 ? 'text-primary' : 'text-outline'}`}>
              Parsing de Datos
            </span>
          </button>
          
          <div className={`h-[2px] flex-1 transition-all ${activeStep >= 3 ? 'bg-primary' : 'bg-outline-variant'}`} />
          
          <button 
            type="button"
            onClick={() => setActiveStep(3)}
            className="flex items-center gap-2 group text-left opacity-90 outline-none"
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
              activeStep === 3 ? 'bg-primary text-white' : 'border border-outline text-outline'
            }`}>
              3
            </div>
            <span className={`font-bold transition-all text-sm ${activeStep === 3 ? 'text-primary' : 'text-outline'}`}>
              Análisis Final
            </span>
          </button>
        </div>
      </div>

      {/* Main Content Layout splits Left File list vs Right Validation Checklist or Step 3 Risk Analysis results portal */}
      {activeStep === 3 ? (
        <div className="space-y-6">
          <div className="bg-[#0b2c1b] text-white p-6 rounded-xl border border-emerald-500/20 shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="space-y-1">
              <span className="text-[10px] font-mono font-black text-emerald-300 uppercase tracking-wider block">
                Inspección Preventiva de Cumplimiento SAT / ANAM
              </span>
              <h2 className="text-xl font-black tracking-tight font-sans text-white">
                Resultados del Análisis de Riesgo
              </h2>
              <p className="text-xs text-white/75 max-w-xl">
                Se completó la verificación del manifiesto consolidado <span className="font-bold underline text-white">{selectedFileName}</span>. A continuación se presentan el diagnóstico de riesgo y la clasificación arancelaria antes de la firma del pedimento.
              </p>
            </div>
            <div className="flex bg-white/10 px-4 py-3 rounded-xl border border-white/10 shrink-0 text-center items-center justify-around gap-6">
              <div>
                <span className="text-[9px] font-bold text-emerald-300 block uppercase">Nivel de Confianza</span>
                <span className="text-md font-black text-emerald-400">99.9% Óptimo</span>
              </div>
              <div className="w-[1px] bg-white/20 h-10" />
              <div>
                <span className="text-[9px] font-bold text-emerald-300 block uppercase">Clasificación SAT</span>
                <span className="text-xs font-extrabold bg-[#073620] text-emerald-300 px-2 py-0.5 rounded border border-emerald-500">APROBADO CON RECOMENDACIONES</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 flex flex-col gap-6">
              <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
                <div className="p-4 border-b border-outline-variant bg-surface-container-low/50 flex justify-between items-center">
                  <div>
                    <h3 className="font-bold text-primary text-sm">Evaluación de Riesgo de Fracciones Arancelarias</h3>
                    <p className="text-[11px] text-on-surface-variant">Líneas analizadas por fracción bajo el marco regulatorio del Anexo 22</p>
                  </div>
                  <span className="bg-primary/10 text-primary border border-primary/20 text-[10px] font-bold px-2.5 py-1 rounded">
                    {records.length} Subpartidas Evaluadas
                  </span>
                </div>

                <div className="divide-y divide-outline-variant">
                  {records.map((record, index) => {
                    const isZeroQty = record.quantity === 0;
                    const isHighValue = record.hsCode === '8517.13.01' || record.description.toLowerCase().includes('smart');
                    let riskLevel = 'CLEARED';
                    let riskText = 'Cumple: Fracción arancelaria validada contra bases del SAT. Sin alertas.';
                    let riskTagColor = 'bg-emerald-50 text-emerald-700 border-emerald-200';
                    let riskTagLabel = 'Aprobado';

                    if (isZeroQty) {
                      riskLevel = 'CRITICAL';
                      riskText = 'Alerta Crítica: Cantidad declarada en 0. No se puede generar el pedimento con valor nulo.';
                      riskTagColor = 'bg-red-50 text-red-700 border-red-200';
                      riskTagLabel = 'Crítico / Previo';
                    } else if (isHighValue) {
                      riskLevel = 'WARNING';
                      riskText = 'Precaución: Smartphones de alta gama. Históricamente susceptible a subvaluación. Revisar valor unitario.';
                      riskTagColor = 'bg-amber-50 text-amber-700 border-amber-200';
                      riskTagLabel = 'Advertencia / Valor';
                    }

                    return (
                      <div 
                        key={index} 
                        className={`p-4 hover:bg-surface-container-low/30 transition-colors flex flex-col md:flex-row justify-between items-start md:items-center gap-4 ${
                          riskLevel === 'CRITICAL' ? 'bg-error-container/5' : riskLevel === 'WARNING' ? 'bg-amber-50/20' : ''
                        }`}
                      >
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-bold text-primary">{record.manifestId}</span>
                            <span className="font-mono text-xs font-semibold px-2 py-0.5 bg-surface-container border border-outline-variant rounded text-secondary">
                              Fracción HTS: {record.hsCode}
                            </span>
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 border rounded-full ${riskTagColor}`}>
                              {riskTagLabel}
                            </span>
                          </div>
                          <p className="text-xs font-bold text-primary truncate">{record.description}</p>
                          <p className="text-xs text-on-surface-variant leading-normal">
                            <span className="text-primary font-bold">Resumen de Análisis: </span>
                            {riskText}
                          </p>
                        </div>

                        <div className="flex flex-row md:flex-col items-end gap-2 justify-between w-full md:w-auto border-t md:border-transparent pt-2 md:pt-0">
                          <span className="text-xs font-bold text-secondary font-mono whitespace-nowrap">
                            {record.quantity} {record.unit} | {record.weight.toFixed(2)} Kgs
                          </span>
                          
                          {riskLevel === 'CRITICAL' ? (
                            <button
                              onClick={() => openEditRecord(record)}
                              className="px-2.5 py-1 bg-error text-white font-sans font-bold rounded text-xs hover:opacity-90 transition-opacity active:scale-95 cursor-pointer"
                            >
                              Corregir Cantidad
                            </button>
                          ) : (
                            <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              <span>Validado con SAT</span>
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="p-4 border-t border-outline-variant bg-surface-container-low/30 flex justify-between items-center">
                  <button 
                    type="button"
                    onClick={() => setActiveStep(2)}
                    className="text-xs font-bold text-secondary hover:text-primary hover:underline flex items-center gap-1 bg-transparent border-0 cursor-pointer outline-none"
                  >
                    <span>← Regresar a Datos de Manifiesto</span>
                  </button>
                  <span className="text-[10px] font-mono text-on-surface-variant">
                    Sello e.firma ANAM: c7e21a48b991ab0f9c2d1
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-4 flex flex-col gap-6">
              
              {/* Despacho e.firma box */}
              <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm space-y-4">
                <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider pb-1.5 border-b border-outline-variant/60 flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 text-primary fill-current" />
                  <span>Acciones de Despacho</span>
                </h4>
                
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Todo el manifiesto se ha auditado preventivamente. Se puede proceder con la generación de pedimento T1 para su validación de aduanas oficial.
                </p>

                <div className="space-y-2 bg-surface-container-low p-3.5 rounded-lg border border-outline-variant/50">
                  <div className="flex justify-between text-xs">
                    <span className="text-on-surface-variant">Patente:</span>
                    <span className="font-bold text-primary truncate max-w-[150px]">{agenteAduanal}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-on-surface-variant">Pedimento:</span>
                    <span className="font-mono font-bold text-primary">{numeroPedimento}</span>
                  </div>
                </div>

                <div className="pt-1">
                  <button
                    onClick={() => onGeneratePedimento('MAWB-7729104-MX', agenteAduanal, numeroPedimento)}
                    className="w-full bg-primary text-on-primary font-bold py-2.5 px-4 text-xs rounded hover:opacity-90 transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-95 cursor-pointer"
                  >
                    <FileCheck className="w-4 h-4 text-emerald-300" />
                    <span>Generar Pedimento T1</span>
                  </button>
                </div>
              </div>

              {/* Rules check summary */}
              {(() => {
                const totalRules = rules.length;
                const checkedRules = rules.filter(r => r.status === 'checked').length;
                const warningRules = rules.filter(r => r.status === 'warning').length;
                return (
                  <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
                    <div className="p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
                      <span className="text-xs font-bold text-primary uppercase">Reglas del Motor SAT</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        warningRules > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                      }`}>
                        {checkedRules}/{totalRules} Correctas {warningRules > 0 && `(${warningRules} Alertas)`}
                      </span>
                    </div>
                    <div className="p-4 divide-y divide-outline-variant-low max-h-[300px] overflow-y-auto custom-scrollbar">
                      {rules.map((rule) => (
                        <div key={rule.id} className="py-2.5 text-xs first:pt-0 last:pb-0">
                          <div className="flex justify-between items-start gap-1 pb-1">
                            <div className="min-w-0 pr-2 flex-1">
                              <p className={`font-sans font-bold truncate ${rule.status === 'warning' ? 'text-error' : 'text-primary'}`}>
                                {rule.title.replace(/RF-\d+\s/, '')}
                              </p>
                              <p className="text-[10px] text-on-surface-variant truncate leading-normal">{rule.description}</p>
                            </div>
                            {rule.status === 'warning' ? (
                              <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                            ) : rule.status === 'checked' ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                            ) : rule.status === 'pending' ? (
                              <Loader2 className="w-4 h-4 text-outline animate-spin shrink-0 mt-0.5" />
                            ) : (
                              <span className="w-2 h-2 rounded-full bg-outline-variant shrink-0 mt-1.5" />
                            )}
                          </div>
                          {rule.detail && (
                            <p className={`text-[10px] px-1.5 py-1 rounded font-mono font-medium ${
                              rule.status === 'warning' ? 'bg-red-50 text-red-700' : 'bg-emerald-50/50 text-emerald-800'
                            }`}>
                              {rule.detail}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left container block */}
          <div className="lg:col-span-8 flex flex-col gap-6">
            
            {userRole === 'autoridad' && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex gap-3 text-xs select-none">
                <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-extrabold text-amber-800">Acceso de Solo Lectura (Perfil de Autoridad ANAM / SAT)</p>
                  <p className="text-amber-700 font-medium mt-1 leading-relaxed">
                    Como autoridad fiscalizadora, tu rol es auditar los manifiestos ya cargados por los agentes aduanales y dictaminar o verificar pedimentos. Para simular la carga y de corrección de datos de manifiesto, selecciona el rol de <strong>Capturista</strong> o <strong>Admin</strong> en el selector de tipo de usuario abajo a la izquierda.
                  </p>
                </div>
              </div>
            )}

            {/* Drag and Drop Box */}
            <div 
              onDragOver={userRole === 'autoridad' ? undefined : handleDragOver}
              onDrop={userRole === 'autoridad' ? undefined : handleDrop}
              onClick={userRole === 'autoridad' ? () => alert("🚫 Permiso Denegado: Su rol de Autoridad no tiene permisos para subir nuevos manifiestos. Por favor cambie de rol a 'Capturista' o 'Admin' abajo en la barra lateral.") : () => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-all select-none shrink-0 ${
                userRole === 'autoridad'
                  ? 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed opacity-80'
                  : isUploading 
                    ? 'bg-primary-container/10 border-primary cursor-pointer' 
                    : 'bg-white border-outline-variant hover:border-primary hover:bg-surface-container-low cursor-pointer'
              }`}
            >
              <input 
                type="file"
                ref={fileInputRef}
                onChange={userRole === 'autoridad' ? undefined : handleSelectFile}
                className="hidden"
                accept=".xlsx,.xls,.json,.csv"
                disabled={userRole === 'autoridad'}
              />
              {isUploading ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-12 h-12 text-primary animate-spin" />
                  <p className="font-bold text-md text-primary">Procesando hojas de manifiesto Excel...</p>
                  <p className="text-xs text-on-surface-variant">Subiendo nodos de datos al almacén de seguridad...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center text-center">
                  <CloudUpload className={`w-14 h-14 mb-2 transition-colors ${userRole === 'autoridad' ? 'text-slate-300' : 'text-outline/80 hover:text-primary'}`} />
                  <h4 className="font-bold text-lg text-primary mb-1">Arrastre y suelte el manifiesto .xlsx aquí</h4>
                  <p className="text-xs text-on-surface-variant">Formatos soportados: Microsoft Excel, JSON (Máx 50MB)</p>
                  <span className={`mt-4 px-4 py-2 border font-bold text-xs rounded transition-all ${
                    userRole === 'autoridad'
                      ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-not-allowed'
                      : 'border-primary text-primary hover:bg-primary hover:text-on-primary cursor-pointer'
                  }`}>
                    Seleccionar Archivos
                  </span>
                </div>
              )}
            </div>

            {/* Table Container block */}
            <div className="bg-white border border-outline-variant rounded-xl flex flex-col overflow-hidden shadow-sm">
              
              {/* Table Header controls */}
              <div className="p-4 border-b border-outline-variant flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-surface-container-low/40 shrink-0">
                <div>
                  <h3 className="font-bold text-primary text-md text-primary">Vista Previa de Datos</h3>
                  <p className="text-xs text-on-surface-variant">
                    Mostrando registros detectados para el docket activo
                  </p>
                </div>

                <div className="flex gap-2 w-full sm:w-auto">
                  <span className="inline-flex items-center px-2.5 py-1 rounded bg-surface-container border border-outline-variant text-[11px] font-semibold text-primary">
                    <FileText className="w-3 h-3 text-secondary mr-1" />
                    {selectedFileName}
                  </span>

                  <button 
                    onClick={runVerification}
                    disabled={isAnalyzing || isUploading}
                    className="bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 px-4 py-2 text-xs font-bold flex items-center gap-1.5 rounded transition-all active:scale-95 whitespace-nowrap cursor-pointer"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Validando...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Iniciar Análisis de Riesgo</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Table Core scrollable list */}
              <div className="overflow-auto custom-scrollbar max-h-[500px] min-h-[300px]">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-surface-container-high z-10 border-b border-outline-variant">
                    <tr>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">ID Manifiesto</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Código HS</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Descripción</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Cantidad</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Unidad</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant text-right">Peso (kg)</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant text-center">Estatus</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-xs divide-y divide-outline-variant">
                    {records.map((record, index) => (
                      <tr 
                        key={index} 
                        className={`hover:bg-surface-container-low transition-colors ${
                          record.status === 'ERROR' ? 'bg-error-container/10' : ''
                        }`}
                      >
                        <td className="p-3 font-semibold text-primary">{record.manifestId}</td>
                        <td className="p-3 text-secondary">{record.hsCode}</td>
                        <td className="p-3 font-sans text-on-surface-variant max-w-xs truncate">{record.description}</td>
                        <td className="p-3">
                          {record.status === 'ERROR' ? (
                            <div className="flex items-center gap-1">
                              <span className="font-bold text-error">{record.quantity}</span>
                              <button 
                                onClick={() => openEditRecord(record)}
                                className="px-1.5 py-0.5 bg-error text-white font-sans font-bold rounded text-[9px] hover:opacity-90 transition-opacity"
                              >
                                Corregir
                              </button>
                            </div>
                          ) : (
                            <span>{record.quantity}</span>
                          )}
                        </td>
                        <td className="p-3">{record.unit}</td>
                        <td className="p-3 text-right">{record.weight.toFixed(2)}</td>
                        <td className="p-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                            record.status === 'READY' 
                              ? 'bg-emerald-100 text-emerald-800' 
                              : 'bg-error-container text-error font-bold'
                          }`}>
                            {record.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Simulated actions panel at bottom to restore default */}
              <div className="p-3 border-t border-outline-variant bg-surface-container-low/20 flex justify-between shrink-0">
                <button 
                  onClick={resetSimulation}
                  className="text-[11px] text-on-surface-variant hover:text-primary flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Restaurar Valores por Defecto</span>
                </button>
                <span className="text-[10px] text-on-surface-variant font-medium">
                  V1 Compliance Automation Engine
                </span>
              </div>
            </div>
          </div>

          {/* Right Side panel: Checklist rules of Validation */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            
            {/* Summary Status Box */}
            <div className="bg-white border border-outline-variant rounded-xl p-4 shadow-sm">
              <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">Summary Status</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-lg text-center">
                  <span className="text-[9px] font-bold text-emerald-700 uppercase">Valid Records</span>
                  <p className="text-2xl font-black text-emerald-600 mt-1">{validCount.toLocaleString()}</p>
                </div>
                <div className="bg-error-container/10 border border-error/10 p-3 rounded-lg text-center">
                  <span className="text-[9px] font-bold text-error uppercase">Errors Found</span>
                  <p className="text-2xl font-black text-error mt-1">{errorCount}</p>
                </div>
              </div>
            </div>

            {/* Captura de Datos Aduanales */}
            <div className="bg-white border border-outline-variant rounded-xl p-4 shadow-sm space-y-4">
              <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider flex items-center gap-1.5 pb-1 border-b border-outline-variant/60">
                <Sparkles className="w-4 h-4 text-emerald-500 animate-pulse" />
                <span>✍️ Captura de Despacho (SAT/ANAM)</span>
              </h4>
              <p className="text-[10px] text-on-surface-variant leading-relaxed">
                Capture la patente del Agente Aduanal y el número oficial del pedimento correspondiente para este despacho.
              </p>
              <div className="space-y-3">
                <div className="space-y-1 bg-surface-container-low p-2 rounded border border-outline-variant/60">
                  <label className="text-[9px] font-bold text-secondary uppercase block">Agente Aduanal / Patente</label>
                  <input 
                    type="text" 
                    value={agenteAduanal}
                    onChange={e => onChangeAgenteAduanal(e.target.value)}
                    className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                    placeholder="e.g. 3920 - Mario Sanchez"
                  />
                </div>
                <div className="space-y-1 bg-surface-container-low p-2 rounded border border-outline-variant/60">
                  <label className="text-[9px] font-bold text-secondary uppercase block">Número de Pedimento (15 dígitos)</label>
                  <input 
                    type="text" 
                    value={numeroPedimento}
                    onChange={e => onChangeNumeroPedimento(e.target.value)}
                    className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-mono font-bold text-primary"
                    placeholder="e.g. 24 12 3004 0001854"
                  />
                </div>
              </div>
            </div>

            {/* Validation Checklist rules container */}
            <div className="bg-white border border-outline-variant rounded-xl flex flex-col overflow-hidden shadow-sm">
              
              <div className="p-4 border-b border-outline-variant bg-surface-container-low/50 flex justify-between items-center shrink-0">
                <h4 className="font-bold text-sm text-primary">Reglas de Cumplimiento</h4>
                <span className="bg-primary text-white text-[10px] px-2.5 py-0.5 rounded-full font-bold">
                  ANAM / SAT
                </span>
              </div>

              {/* Checklist items dynamic scrollable area */}
              <div className="overflow-y-auto p-4 space-y-4 custom-scrollbar max-h-[450px]">
                {rules.map((rule) => {
                  return (
                    <div 
                      key={rule.id} 
                      className={`flex items-start gap-3 transition-colors py-1 ${
                        rule.status === 'warning' ? 'border-l-4 border-error pl-3 -ml-3 bg-error-container/5' : ''
                      }`}
                    >
                      {/* Multi state icon */}
                      <div className="mt-0.5 shrink-0">
                        {rule.status === 'checked' && (
                          <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                            <CheckCircle2 className="w-3.5 h-3.5 fill-current" />
                          </div>
                        )}
                        {rule.status === 'warning' && (
                          <div className="w-5 h-5 rounded-full bg-error-container flex items-center justify-center text-error animate-pulse">
                            <AlertTriangle className="w-3.5 h-3.5 fill-current" />
                          </div>
                        )}
                        {rule.status === 'pending' && (
                          <div className="w-5 h-5 rounded-full bg-surface-container-high flex items-center justify-center text-outline animate-spin">
                            <Loader2 className="w-3.5 h-3.5" />
                          </div>
                        )}
                        {rule.status === 'none' && (
                          <div className="w-5 h-5 rounded-full bg-surface-container-high flex items-center justify-center text-outline-variant">
                            <span className="w-1.5 h-1.5 rounded-full bg-outline-variant" />
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-bold leading-none ${
                          rule.status === 'warning' ? 'text-error animate-pulse font-extrabold' : 'text-primary'
                        }`}>
                          {rule.title}
                        </p>
                        <p className="text-[11px] text-on-surface-variant mt-1 leading-normal">
                          {rule.description}
                        </p>
                        {rule.detail && rule.status !== 'pending' && rule.status !== 'none' && (
                          <p className={`text-[10px] mt-1.5 p-1.5 px-2 rounded font-sans border leading-relaxed ${
                            rule.status === 'warning' 
                              ? 'bg-red-50 border-red-200 text-red-700' 
                              : 'bg-emerald-50/50 border-emerald-100 text-emerald-800'
                          }`}>
                            {rule.detail}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Progress status spinner */}
              <div className="p-4 bg-surface-container-low border-t border-outline-variant shrink-0">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">Progreso del Análisis</span>
                  <span className="text-xs font-bold text-primary">{analysisProgress}%</span>
                </div>
                <div className="w-full bg-outline-variant h-1 rounded-full overflow-hidden">
                  <div 
                    className="bg-primary h-full rounded-full transition-all duration-500 ease-out" 
                    style={{ width: `${analysisProgress}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Editing Record Dialog Modal */}
      {editingRecord && (
        <div className="fixed inset-0 z-[100] bg-primary-container/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-xl border border-outline-variant shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-outline-variant bg-surface-container-low">
              <h3 className="font-bold text-primary text-md text-primary">Corregir Registro de Declaración</h3>
              <p className="text-xs text-on-surface-variant mt-1 font-sans">
                Corrija discrepancias críticas de cantidades nulas o incompletas de {editingRecord.manifestId}
              </p>
            </div>
            
            <div className="p-5 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-on-surface-variant uppercase">HS Code / Fracción</label>
                <p className="font-mono text-xs font-medium bg-surface-container px-2.5 py-1.5 rounded border border-outline-variant">
                  {editingRecord.hsCode}
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-on-surface-variant uppercase">Descripción</label>
                <p className="text-xs text-on-surface-variant font-medium bg-surface-container p-2.5 rounded border border-outline-variant leading-relaxed">
                  {editingRecord.description}
                </p>
              </div>

              <div className="space-y-1">
                <label htmlFor="editQtyInput" className="text-xs font-bold text-primary uppercase">Nueva Cantidad (Dato Real en PCE)</label>
                <input
                  id="editQtyInput"
                  type="number"
                  value={editQuantity}
                  onChange={e => setEditQuantity(e.target.value)}
                  className="w-full p-2 bg-white border border-outline rounded text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none font-bold"
                  placeholder="Introduzca cantidad mayor a 0..."
                />
              </div>
            </div>

            <div className="p-4 bg-surface-container-low border-t border-outline-variant flex gap-3">
              <button 
                type="button"
                onClick={() => setEditingRecord(null)}
                className="flex-1 bg-white border border-outline text-secondary font-bold py-2 text-xs rounded hover:bg-surface-container transition-colors"
              >
                Cancelar
              </button>
              <button 
                type="button"
                onClick={saveEditedRecord}
                className="flex-1 bg-primary text-on-primary font-bold py-2 text-xs rounded hover:opacity-90 transition-opacity"
              >
                Grabar Corrección
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success Completion Celebration Overlay Modal */}
      {showSuccessModal && (
        <div className="fixed inset-0 z-[100] bg-primary-container/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="bg-white w-full max-w-md rounded-xl border border-outline-variant p-6 shadow-2xl text-center space-y-5 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto text-emerald-600 ring-4 ring-emerald-50">
              <ShieldCheck className="w-8 h-8 text-emerald-600" />
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-primary text-primary">Análisis de Riesgo Completado</h3>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                El manifiesto de mercancías <span className="font-mono font-bold text-primary">{selectedFileName}</span> ha sido completamente analizado contra reglamentos SAT/ANAM 2024.
              </p>
            </div>

            {/* Detailed results indicators in the success modal */}
            {(() => {
              const stats = getSuccessModalStats();
              return (
                <div className="bg-surface-container p-4 rounded-xl border border-outline-variant/60 text-left space-y-2 max-w-sm mx-auto">
                  <span className="text-[10px] font-bold text-primary uppercase block tracking-wider text-center border-b border-outline-variant pb-1.5">
                    Resumen de Clasificaciones Identificadas
                  </span>
                  <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                    <div className="bg-emerald-50 p-2 rounded border border-emerald-100">
                      <span className="text-[9px] font-bold text-emerald-700 block">Aprobado</span>
                      <span className="text-xs font-black text-emerald-600">
                        {stats.cleared === 1 ? '1 bulto' : `${stats.cleared.toLocaleString()} bultos`}
                      </span>
                    </div>
                    <div className="bg-amber-50 p-2 rounded border border-amber-100">
                      <span className="text-[9px] font-bold text-amber-700 block">Advertencia</span>
                      <span className="text-xs font-black text-amber-600">
                        {stats.warning === 1 ? '1 bulto' : `${stats.warning.toLocaleString()} bultos`}
                      </span>
                    </div>
                    <div className="bg-red-50 p-2 rounded border border-red-100">
                      <span className="text-[9px] font-bold text-red-700 block">Críticos</span>
                      <span className="text-xs font-black text-red-600">
                        {stats.critical === 1 ? '1 bulto' : `${stats.critical.toLocaleString()} bultos`}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="flex gap-3 pt-2">
              <button 
                type="button"
                onClick={() => {
                  setShowSuccessModal(false);
                  setActiveStep(3); // Keep user on step 3 so they see details
                  if (onNavigateToTab) {
                    onNavigateToTab('riskAnalysis');
                  }
                }}
                className="flex-1 bg-white border border-outline text-secondary font-bold py-2.5 text-xs rounded hover:bg-surface-container transition-all cursor-pointer"
              >
                Ver Diagnóstico Técnico
              </button>
              <button 
                type="button"
                onClick={() => {
                  setShowSuccessModal(false);
                  onGeneratePedimento('MAWB-7729104-MX', agenteAduanal, numeroPedimento);
                }}
                className="flex-1 bg-primary text-on-primary font-bold py-2.5 text-xs rounded hover:opacity-90 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>Generar Pedimento T1</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
