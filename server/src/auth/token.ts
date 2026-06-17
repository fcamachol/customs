import jwt from 'jsonwebtoken';
export type Role = 'capturista' | 'admin' | 'autoridad';
export interface Claims { userId: string; role: Role; }
const SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
export function signToken(claims: Claims): string { return jwt.sign(claims, SECRET, { expiresIn: '8h' }); }
export function verifyToken(token: string): Claims { return jwt.verify(token, SECRET) as Claims; }
