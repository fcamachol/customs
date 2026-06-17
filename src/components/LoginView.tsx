import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export function LoginView() {
  const { login } = useAuth();
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState('');
  return (
    <form onSubmit={async (e) => { e.preventDefault(); try { await login(u, p); } catch (x) { setErr(String(x)); } }}>
      <h1>Capital Centennials</h1>
      <input placeholder="Usuario" value={u} onChange={(e) => setU(e.target.value)} />
      <input placeholder="Contraseña" type="password" value={p} onChange={(e) => setP(e.target.value)} />
      <button type="submit">Entrar</button>
      {err && <p role="alert">{err}</p>}
    </form>
  );
}
