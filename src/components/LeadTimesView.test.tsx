import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import LeadTimesView from './LeadTimesView';

/**
 * LEAD TIMES: la aritmética existía en `shared/operaciones/leadTimes.ts` desde el principio y no
 * tenía ni una pantalla — el punto 7 del cliente se calculaba y no se veía.
 *
 * Estas pruebas no vuelven a probar las fórmulas (eso es de `leadTimes.test.ts`): fijan las tres
 * reglas que la PANTALLA puede romper sola, y que son las mismas tres que el módulo se niega a
 * romper. Cada una fue primero una forma de mentir con un dashboard:
 *
 *  - `null` se dibuja como «—», nunca como 0. Un embarque sin POD firmado tiene lead time
 *    DESCONOCIDO; pintarlo como cero lo mete al promedio mental de quien lee.
 *  - el denominador se imprime junto al promedio. "Tiempo en almacén 3h" sobre 3 de 90 guías es una
 *    muestra, no un KPI.
 *  - un intervalo negativo se muestra tal cual y señalado. Significa que dos marcas de tiempo se
 *    contradicen; recortarlo a cero borra la única evidencia de que algo está mal.
 */
vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiDownload: vi.fn(async () => {}),
}));

const VACIO = {
  muestras: 0, promedioMin: null, medianaMin: null, minimoMin: null, maximoMin: null,
};

function resumen(over: Record<string, unknown> = {}) {
  const base = {
    almacenMin: VACIO, despachoMin: VACIO, transitoMin: VACIO, entregaMin: VACIO,
    ultimaMillaMin: VACIO, leadTimeMin: VACIO, demoraCitaMin: VACIO, patioAduanaMin: VACIO,
    cargaMin: VACIO, tiempoEnRojoMin: VACIO, desviacionArriboMin: VACIO,
  };
  return { ...base, ...over };
}

const FILA = {
  operacionId: 'op1', mawb: '020-12345678', guia: 'HX001', cliente: 'IMILE',
  etapa: 'entregado', despachoFolio: 'D-1', podEstado: 'firmado',
  almacenMin: 134, despachoMin: null, transitoMin: 90, entregaMin: 20,
  ultimaMillaMin: 110, leadTimeMin: 244, demoraCitaMin: null, patioAduanaMin: null,
  cargaMin: null, tiempoEnRojoMin: null, desviacionArriboMin: null,
  rulesetVersion: '2026-08a',
};

const CORTES = [
  { id: 'dia', label: 'Diario' }, { id: 'semana', label: 'Semanal' },
  { id: 'mes', label: 'Mensual' }, { id: 'anio', label: 'Anual' },
];

function respuesta(over: Record<string, unknown> = {}) {
  return {
    rulesetVersion: '2026-08a',
    resumen: resumen({ almacenMin: { muestras: 1, promedioMin: 134, medianaMin: 134, minimoMin: 134, maximoMin: 134 } }),
    filas: [FILA],
    total: 1,
    corte: 'mes',
    cortes: CORTES,
    series: [],
    comparativoAnual: [],
    ...over,
  };
}

/** El primer apiGet es el catálogo de clientes; el segundo, el reporte. */
function montar(reporte: unknown) {
  return import('../api').then(({ apiGet }) => {
    vi.mocked(apiGet).mockImplementation(async (path: string) =>
      (path.startsWith('/api/catalogs/clients') ? [] : reporte) as never,
    );
    return render(<LeadTimesView />);
  });
}

/** "2h 14m" aparece en el tile, en el resumen y en la fila: esperar por el primero basta. */
async function esperarDatos() {
  await waitFor(() => expect(screen.getAllByText('2h 14m').length).toBeGreaterThan(0));
}

beforeEach(() => vi.clearAllMocks());

describe('LeadTimesView', () => {
  it('muestra el promedio con el tamaño de muestra, no sólo el promedio', async () => {
    await montar(respuesta());
    // 134 min = 2h 14m. El denominador viaja con él: si alguien lo quita, esta prueba cae.
    await esperarDatos();
    // Un denominador por tile, sin excepción — incluidos los tiles sin muestras.
    expect(screen.getAllByText(/promedio de/).length).toBe(5);
    expect(screen.getAllByText(/de 1 guía/).length).toBe(5);
  });

  it('un intervalo sin dato se dibuja como «—» y NUNCA como cero', async () => {
    await montar(respuesta());
    await esperarDatos();
    // `despachoMin` es null en la fila y en el resumen: no puede aparecer un 0m por ningún lado.
    expect(screen.queryByText('0m')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('un intervalo negativo se muestra y se señala, en vez de recortarse a cero', async () => {
    await montar(respuesta({
      filas: [{ ...FILA, transitoMin: -45 }],
      resumen: resumen({
        transitoMin: { muestras: 1, promedioMin: -45, medianaMin: -45, minimoMin: -45, maximoMin: -45 },
      }),
    }));
    // Signo menos real (U+2212), no un guion suelto que se confunda con "sin dato".
    const celdas = await screen.findAllByText('−45m');
    expect(celdas.length).toBeGreaterThan(0);
    expect(celdas.some((c) => c.className.includes('amber'))).toBe(true);
  });

  it('imprime la versión del ruleset con el que se calculó', async () => {
    await montar(respuesta());
    await waitFor(() => expect(screen.getAllByText('2026-08a').length).toBeGreaterThan(0));
  });

  it('no manda filtros vacíos: una fecha en blanco no viaja como desde=', async () => {
    const { apiGet } = await import('../api');
    await montar(respuesta());
    await esperarDatos();
    const llamadas = vi.mocked(apiGet).mock.calls.map((c) => c[0] as string);
    // El corte SÍ viaja siempre (tiene default); las fechas vacías no. Un `desde=` vacío no es
    // "sin filtro", es un 400 del servidor.
    expect(llamadas).toContain('/api/reportes/lead-times?corte=mes');
    expect(llamadas.some((p) => p.includes('desde=&') || p.endsWith('desde='))).toBe(false);
  });

  it('manda los filtros que el usuario sí llenó', async () => {
    const { apiGet } = await import('../api');
    await montar(respuesta());
    await esperarDatos();

    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: /aplicar/i }));

    await waitFor(() => {
      const llamadas = vi.mocked(apiGet).mock.calls.map((c) => c[0] as string);
      expect(llamadas).toContain('/api/reportes/lead-times?desde=2026-09-01&corte=mes');
    });
  });

  it('descarga el XLSX con los mismos filtros de la consulta', async () => {
    const { apiDownload } = await import('../api');
    await montar(respuesta());
    await esperarDatos();

    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: /descargar xlsx/i }));

    await waitFor(() =>
      expect(vi.mocked(apiDownload)).toHaveBeenCalledWith(
        '/api/reportes/lead-times.xlsx?desde=2026-09-01',
        'Lead_times.xlsx',
      ),
    );
  });

  it('manda el corte elegido y lo aplica al pedir de nuevo', async () => {
    const { apiGet } = await import('../api');
    await montar(respuesta());
    await esperarDatos();
    fireEvent.change(screen.getByLabelText('Corte'), { target: { value: 'semana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    await waitFor(() => {
      const llamadas = vi.mocked(apiGet).mock.calls.map((c) => String(c[0]));
      expect(llamadas.some((u) => u.includes('/api/reportes/lead-times') && u.includes('corte=semana'))).toBe(true);
    });
  });

  it('la serie por periodo muestra el volumen de cada cubeta', async () => {
    await montar(respuesta({
      series: [
        { periodo: '2026-08', operaciones: 12, resumen: resumen({ leadTimeMin: { muestras: 12, promedioMin: 300, medianaMin: 290, minimoMin: 100, maximoMin: 900 } }) },
        { periodo: '2026-09', operaciones: 30, resumen: resumen({ leadTimeMin: { muestras: 28, promedioMin: 244, medianaMin: 240, minimoMin: 90, maximoMin: 800 } }) },
      ],
    }));
    await esperarDatos();
    expect(screen.getByText('Evolución por periodo')).toBeTruthy();
    expect(screen.getByText('2026-08')).toBeTruthy();
    expect(screen.getByText('2026-09')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
  });

  it('las operaciones sin arribo se ven, en vez de desaparecer de la suma', async () => {
    // Si no salieran, la suma de los periodos sería menor que el total y nadie sabría por qué.
    await montar(respuesta({
      series: [
        { periodo: '2026-09', operaciones: 30, resumen: resumen() },
        { periodo: 'sin-fecha', operaciones: 4, resumen: resumen() },
      ],
    }));
    await esperarDatos();
    expect(screen.getByText('Sin arribo registrado')).toBeTruthy();
    expect(screen.getByText(/no se pueden ubicar en un periodo/i)).toBeTruthy();
  });

  it('el comparativo anual muestra la variación con signo', async () => {
    await montar(respuesta({
      comparativoAnual: [
        { periodo: '09', porAnio: { '2025': 100, '2026': 143 }, variacionPct: 43, anioBase: '2025', anioComparado: '2026' },
      ],
    }));
    await esperarDatos();
    expect(screen.getByText('Volumen año contra año')).toBeTruthy();
    expect(screen.getByText('+43%')).toBeTruthy();
  });

  it('sin año anterior la variación es «—», no 0% ni +100%', async () => {
    await montar(respuesta({
      comparativoAnual: [
        { periodo: '09', porAnio: { '2026': 143 }, variacionPct: null, anioBase: null, anioComparado: '2026' },
      ],
    }));
    await esperarDatos();
    const celda = screen.getByTitle('No hay con qué comparar: falta el año anterior, o fue cero');
    expect(celda.textContent).toBe('—');
  });

  it('un año sin operaciones deja la celda en «—», no en cero', async () => {
    await montar(respuesta({
      comparativoAnual: [
        { periodo: '09', porAnio: { '2026': 143 }, variacionPct: null, anioBase: null, anioComparado: '2026' },
        { periodo: '10', porAnio: { '2025': 90, '2026': 95 }, variacionPct: 5.6, anioBase: '2025', anioComparado: '2026' },
      ],
    }));
    await esperarDatos();
    expect(screen.getByTitle('Sin operaciones registradas ese año').textContent).toBe('—');
  });

  it('sin comparativo no dibuja la tarjeta vacía', async () => {
    await montar(respuesta({ comparativoAnual: [] }));
    await esperarDatos();
    expect(screen.queryByText('Volumen año contra año')).toBeNull();
  });

  it('sin operaciones en el rango no inventa un tablero de ceros', async () => {
    await montar(respuesta({ filas: [], total: 0, resumen: resumen() }));
    await waitFor(() => expect(screen.getByText(/no hay operaciones en este rango/i)).toBeTruthy());
    expect(screen.queryByText('0m')).toBeNull();
  });
});
