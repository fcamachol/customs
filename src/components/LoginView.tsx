import { useState, type FormEvent } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function LoginView() {
  const { login, enrollMfa } = useAuth();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [code, setCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // MFA enrollment state (F10: privileged users without MFA must enroll on first login)
  const [enrollmentPhase, setEnrollmentPhase] = useState<'none' | 'setup' | 'enable'>('none');
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [enrollSecret, setEnrollSecret] = useState('');
  const [enrollOtpauthUrl, setEnrollOtpauthUrl] = useState('');
  const [enrollCode, setEnrollCode] = useState('');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await login(u, p, code || undefined);
    } catch (x: unknown) {
      const msg = x instanceof Error ? x.message : '';
      const body = (x as { body?: Record<string, unknown> }).body ?? {};

      if (msg === 'mfa_required') {
        // User has MFA enabled, ask for TOTP code
        setMfaRequired(true);
        setErr('Ingresa tu código de autenticación (MFA).');
      } else if (msg === 'mfa_enrollment_required') {
        // Privileged user without MFA: start enrollment flow
        const token = body.enrollmentToken as string | undefined;
        if (token) {
          setEnrollmentToken(token);
          setEnrollmentPhase('setup');
          setErr('');
        } else {
          setErr('Se requiere configurar MFA. Por favor contacta al administrador.');
        }
      } else {
        setErr('Usuario, contraseña o código MFA incorrectos.');
      }
    } finally {
      setLoading(false);
    }
  };

  const onSetupMfa = async () => {
    setErr('');
    setLoading(true);
    try {
      const result = await enrollMfa('setup', enrollmentToken);
      if (result) {
        setEnrollSecret(result.secret);
        setEnrollOtpauthUrl(result.otpauthUrl);
        setEnrollmentPhase('enable');
      }
    } catch {
      setErr('Error al configurar MFA. Vuelve a intentarlo.');
    } finally {
      setLoading(false);
    }
  };

  const onEnableMfa = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await enrollMfa('enable', enrollmentToken, enrollCode);
      // enrollMfa stores the full token, login completes
    } catch {
      setErr('Código incorrecto. Verifica tu app de autenticación.');
    } finally {
      setLoading(false);
    }
  };

  // --- MFA Enrollment: setup step ---
  if (enrollmentPhase === 'setup') {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 font-sans antialiased">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-8 select-none">
            <div className="w-14 h-14 rounded-2xl bg-gold-500/15 border border-gold-400/30 flex items-center justify-center shadow-lg mb-4">
              <ShieldCheck className="w-7 h-7 text-gold-400" />
            </div>
            <h1 className="text-white font-black tracking-tight text-xl leading-none">Configurar MFA</h1>
            <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-gold-400 font-bold mt-2">
              Autenticación requerida
            </p>
          </div>
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl border border-white/10 p-7 space-y-5">
            <p className="text-sm text-gray-700">
              Tu rol requiere autenticación de dos factores (MFA). Debes configurarlo antes de continuar.
            </p>
            {err && (
              <p role="alert" className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {err}
              </p>
            )}
            <button
              type="button"
              onClick={onSetupMfa}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-navy-800 hover:bg-navy-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-bold py-2.5 transition shadow-md"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Generando…' : 'Generar código QR'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- MFA Enrollment: enable step ---
  if (enrollmentPhase === 'enable') {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 font-sans antialiased">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-8 select-none">
            <div className="w-14 h-14 rounded-2xl bg-gold-500/15 border border-gold-400/30 flex items-center justify-center shadow-lg mb-4">
              <ShieldCheck className="w-7 h-7 text-gold-400" />
            </div>
            <h1 className="text-white font-black tracking-tight text-xl leading-none">Verificar MFA</h1>
            <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-gold-400 font-bold mt-2">
              Escanea y confirma
            </p>
          </div>
          <form
            onSubmit={onEnableMfa}
            className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl border border-white/10 p-7 space-y-5"
          >
            <p className="text-sm text-gray-700">
              Escanea este código con tu app de autenticación (Google Authenticator, Authy, etc.) e ingresa el código de 6 dígitos.
            </p>
            {enrollOtpauthUrl && (
              <div className="space-y-2">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">URL de configuración</p>
                <code className="block text-[10px] text-gray-600 bg-gray-100 rounded p-2 break-all select-all">
                  {enrollOtpauthUrl}
                </code>
                <p className="text-xs text-gray-500">
                  O ingresa la clave manualmente:{' '}
                  <span className="font-mono font-bold text-gray-700 select-all">{enrollSecret}</span>
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor="enroll-code" className="block text-xs font-bold text-gray-700 uppercase tracking-wide">
                Código de verificación
              </label>
              <input
                id="enroll-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
                value={enrollCode}
                onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg border border-navy-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/30 tracking-widest font-mono"
              />
            </div>
            {err && (
              <p role="alert" className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {err}
              </p>
            )}
            <button
              type="submit"
              disabled={loading || enrollCode.length < 6}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-navy-800 hover:bg-navy-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-bold py-2.5 transition shadow-md"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Verificando…' : 'Activar MFA y entrar'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- Normal login form ---
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 font-sans antialiased">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8 select-none">
          <div className="w-14 h-14 rounded-2xl bg-gold-500/15 border border-gold-400/30 flex items-center justify-center shadow-lg mb-4">
            <ShieldCheck className="w-7 h-7 text-gold-400" />
          </div>
          <h1 className="text-white font-black tracking-tight text-xl leading-none">Capital Centennials</h1>
          <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-gold-400 font-bold mt-2">
            Análisis de Riesgo · T1
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={onSubmit}
          className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl border border-white/10 p-7 space-y-5"
        >
          <div className="space-y-1.5">
            <label htmlFor="usuario" className="block text-xs font-bold text-gray-700 uppercase tracking-wide">
              Usuario
            </label>
            <input
              id="usuario"
              autoComplete="username"
              placeholder="Usuario"
              value={u}
              onChange={(e) => setU(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/30"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="contrasena" className="block text-xs font-bold text-gray-700 uppercase tracking-wide">
              Contraseña
            </label>
            <input
              id="contrasena"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={p}
              onChange={(e) => setP(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/30"
            />
          </div>

          {mfaRequired && (
            <div className="space-y-1.5">
              <label htmlFor="mfa-code" className="block text-xs font-bold text-gray-700 uppercase tracking-wide">
                Código MFA
              </label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg border border-navy-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/30 tracking-widest font-mono"
              />
            </div>
          )}

          {err && (
            <p role="alert" className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {err}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-navy-800 hover:bg-navy-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-bold py-2.5 transition shadow-md"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <p className="text-center text-[10px] font-mono text-white/40 mt-6 select-none">
          Plataforma de cumplimiento aduanero · Acceso restringido
        </p>
      </div>
    </div>
  );
}
