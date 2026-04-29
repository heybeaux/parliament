import { useEffect, useState } from 'react';
import { getHealth, type HealthResponse } from '../lib/api';
import { roleStyle } from '../lib/roles';

export function HealthBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-2.5 py-1.5 ring-1 ring-rose-400/20">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
        <span className="text-2xs font-medium text-rose-300">Offline</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 ring-1 ring-white/[0.06]">
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
        <span className="text-2xs text-zinc-500">Connecting</span>
      </div>
    );
  }

  const models = Object.entries(health.models);
  const allOk = models.every(([, s]) => s === 'connected');

  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      {models.map(([role, status]) => {
        const s = roleStyle(role);
        const ok = status === 'connected';
        return (
          <div
            key={role}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors ${
              ok ? 'bg-white/[0.03]' : 'bg-rose-500/5'
            } ring-1 ${ok ? 'ring-white/[0.06]' : 'ring-rose-400/20'}`}
            title={`${s.label}: ${status}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                ok ? s.dot : 'bg-rose-400'
              }`}
            />
            <span className={`text-2xs font-medium ${ok ? 'text-zinc-400' : 'text-rose-300'}`}>
              {s.label}
            </span>
          </div>
        );
      })}
      {allOk && (
        <div className="ml-1 flex items-center gap-1 text-2xs text-emerald-400/70">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      )}
    </div>
  );
}
