import type { Role } from './types';

interface RoleStyle {
  label: string;
  icon: string;
  border: string;
  badge: string;
  dot: string;
  text: string;
  bg: string;
  accent: string;
  gradient: string;
}

const STYLES: Record<string, RoleStyle> = {
  proposer: {
    label: 'Proposer',
    icon: 'Lightbulb',
    border: 'border-emerald-400/25',
    badge: 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-400/20',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    bg: 'bg-emerald-500/5',
    accent: '#34d399',
    gradient: 'from-emerald-500/20 to-emerald-500/0',
  },
  skeptic: {
    label: 'Skeptic',
    icon: 'ShieldQuestion',
    border: 'border-amber-400/25',
    badge: 'bg-amber-500/10 text-amber-300 ring-1 ring-amber-400/20',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    bg: 'bg-amber-500/5',
    accent: '#fbbf24',
    gradient: 'from-amber-500/20 to-amber-500/0',
  },
  synthesizer: {
    label: 'Synthesizer',
    icon: 'Sparkles',
    border: 'border-blue-400/25',
    badge: 'bg-blue-500/10 text-blue-300 ring-1 ring-blue-400/20',
    dot: 'bg-blue-400',
    text: 'text-blue-300',
    bg: 'bg-blue-500/5',
    accent: '#60a5fa',
    gradient: 'from-blue-500/20 to-blue-500/0',
  },
  redagent: {
    label: 'Red Agent',
    icon: 'Flame',
    border: 'border-rose-400/25',
    badge: 'bg-rose-500/10 text-rose-300 ring-1 ring-rose-400/20',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    bg: 'bg-rose-500/5',
    accent: '#fb7185',
    gradient: 'from-rose-500/20 to-rose-500/0',
  },
  sentry: {
    label: 'Sentry',
    icon: 'Eye',
    border: 'border-violet-400/25',
    badge: 'bg-violet-500/10 text-violet-300 ring-1 ring-violet-400/20',
    dot: 'bg-violet-400',
    text: 'text-violet-300',
    bg: 'bg-violet-500/5',
    accent: '#a78bfa',
    gradient: 'from-violet-500/20 to-violet-500/0',
  },
};

const FALLBACK: RoleStyle = {
  label: 'Agent',
  icon: 'Bot',
  border: 'border-zinc-500/25',
  badge: 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20',
  dot: 'bg-zinc-400',
  text: 'text-zinc-400',
  bg: 'bg-zinc-500/5',
  accent: '#a1a1aa',
  gradient: 'from-zinc-500/20 to-zinc-500/0',
};

export function roleStyle(role: string): RoleStyle {
  const key = role.toLowerCase().replace(/[^a-z]/g, '');
  return STYLES[key] ?? { ...FALLBACK, label: role };
}

export const ROLE_ORDER: Role[] = ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry'];
