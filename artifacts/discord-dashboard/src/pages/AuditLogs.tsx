import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import { useGetAuditLogs } from '@workspace/api-client-react';
import { PageHeader } from '@/components/PremiumComponents';
import { formatDistanceToNow } from 'date-fns';

const PAGE_SIZE = 10;

function timeAgo(date: string) {
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: false }) + ' ago';
  } catch {
    return 'unknown';
  }
}

function formatEntry(log: {
  type: string;
  executorName?: string | null;
  targetName?: string | null;
  createdAt: string;
  reason?: string | null;
}, index: number) {
  const num = String(index + 1).padStart(2, '0');
  const action = log.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const parts: string[] = [action];
  if (log.executorName) parts.push(log.executorName);
  if (log.targetName) parts.push(log.targetName);
  const time = timeAgo(log.createdAt);
  return { num, line: parts.join(' — '), time };
}

export default function AuditLogs() {
  const guildId = useStore((state) => state.selectedGuildId);
  const [page, setPage] = useState(1);
  const [closed, setClosed] = useState(false);

  const { data: logs, isLoading } = useGetAuditLogs(
    guildId || '',
    { limit: 100 },
    { query: { enabled: !!guildId } }
  );

  if (closed) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pb-24 max-w-2xl mx-auto">
        <div className="glass-panel rounded-2xl p-8 text-center text-muted-foreground">
          <p>Audit logs closed. <button onClick={() => setClosed(false)} className="text-primary underline">Reopen</button></p>
        </div>
      </motion.div>
    );
  }

  const allLogs = logs ?? [];
  const totalPages = Math.max(1, Math.ceil(allLogs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageEntries = allLogs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24 max-w-2xl mx-auto">
      <div className="mb-6">
        <PageHeader
          title="Audit Log"
          description="Recent audit log entries for this server."
        />
      </div>

      <div className="glass-panel rounded-2xl overflow-hidden shadow-2xl">
        <div className="p-6 min-h-[420px] flex flex-col">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              Loading logs...
            </div>
          ) : pageEntries.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              No audit log entries found.
            </div>
          ) : (
            <div className="flex-1 space-y-1">
              {pageEntries.map((log, i) => {
                const globalIndex = (safePage - 1) * PAGE_SIZE + i;
                const { num, line, time } = formatEntry(log, globalIndex);
                return (
                  <div key={log.id} className="text-sm leading-relaxed">
                    <span className="text-white font-medium">{num} {line}</span>
                    <span className="text-muted-foreground"> {time}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-white/10">
            <div className="text-sm text-muted-foreground mb-3">
              Page {safePage}/{totalPages}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="w-12 h-10 rounded-lg bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white font-bold text-lg transition-colors"
                aria-label="Previous page"
              >
                ◀
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="w-12 h-10 rounded-lg bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white font-bold text-lg transition-colors"
                aria-label="Next page"
              >
                ▶
              </button>
              <button
                onClick={() => setClosed(true)}
                className="w-12 h-10 rounded-lg bg-[#ed4245] hover:bg-[#c03537] flex items-center justify-center text-white font-bold text-lg transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
