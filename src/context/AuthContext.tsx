import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiPost } from '../api';

interface User { id: string; username: string; role: 'capturista' | 'admin' | 'autoridad'; }
interface AuthValue { user: User | null; login: (u: string, p: string) => Promise<void>; logout: () => void; }

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  async function login(username: string, password: string) {
    const { token, user } = await apiPost<{ token: string; user: User }>('/api/auth/login', { username, password });
    localStorage.setItem('token', token);
    setUser(user);
  }
  function logout() { localStorage.removeItem('token'); setUser(null); }
  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
