import { useState, type FormEvent } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function LoginView() {
  const { login } = useAuth();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [code, setCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await login(u, p, code || undefined);
    } catch (x: unknown) {
      // If the server returned mfa_required, reveal the MFA field and prompt to retry
      const msg = x instanceof Error ? x.message : '';
      if (msg === 'mfa_required') {
        setMfaRequired(true);
        setErr('Ingresa tu código de autenticación (MFA).');
      } else {
        setErr('Usuario, contraseña o código MFA incorrectos.');
      }
    } finally {
      setLoading(false);
    }
  };

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
