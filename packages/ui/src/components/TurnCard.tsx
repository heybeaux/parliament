import { motion } from 'framer-motion';
import type { Turn } from '../lib/types';
import { roleStyle } from '../lib/roles';

interface Props {
  turn: Turn;
  index: number;
}

export function TurnCard({ turn, index }: Props) {
  const style = roleStyle(turn.agent);
  const time = new Date(turn.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06, ease: 'easeOut' }}
      className="group relative"
    >
      <div
        className={`surface-interactive relative overflow-hidden rounded-xl p-4`}
      >
        {/* Colored top accent line */}
        <div
          className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${style.gradient}`}
        />

        {/* Agent header */}
        <div className="mb-3">
          <span className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-2xs font-semibold ${style.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {style.label}
          </span>
          <p className="mt-1.5 truncate font-mono text-2xs text-zinc-500/70">
            {turn.model}
          </p>
        </div>

        {/* Content */}
        <p className="whitespace-pre-wrap text-[13px] leading-[1.7] text-zinc-300/90">
          {turn.content}
        </p>

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between border-t border-white/[0.04] pt-2.5">
          <span className="text-2xs text-zinc-500">{time}</span>
          {turn.osi_score != null && (
            <span className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-1.5 py-0.5 text-2xs ring-1 ring-white/[0.04]">
              <span className="text-zinc-500">OSI</span>
              <span className={turn.osi_score > 0.15 ? 'text-amber-400' : 'text-zinc-400'}>
                {turn.osi_score.toFixed(3)}
              </span>
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
