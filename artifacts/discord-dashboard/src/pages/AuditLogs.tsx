import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ActivitySquare, Search, Filter } from 'lucide-react';
import { useStore } from '@/store';
import { useGetAuditLogs } from '@workspace/api-client-react';
import { PageHeader, PremiumSelect, PremiumInput } from '@/components/PremiumComponents';
import { format } from 'date-fns';

export default function AuditLogs() {
  const guildId = useStore((state) => state.selectedGuildId);
  const [filterType, setFilterType] = useState('');
  
  const { data: logs, isLoading } = useGetAuditLogs(guildId || '', { limit: 100, type: filterType || undefined }, { query: { enabled: !!guildId } });

  const getBadgeColor = (type: string) => {
    if (type.includes('antinuke') || type.includes('ban')) return 'bg-destructive/20 text-destructive border-destructive/30';
    if (type.includes('antiraid') || type.includes('kick')) return 'bg-orange-500/20 text-orange-500 border-orange-500/30';
    if (type.includes('warn') || type.includes('automod')) return 'bg-warning/20 text-warning border-warning/30';
    if (type.includes('settings')) return 'bg-blue-500/20 text-blue-500 border-blue-500/30';
    return 'bg-primary/20 text-primary border-primary/30';
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24 max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-4">
        <PageHeader 
          title="Audit Logs" 
          description="A complete history of bot actions and security events." 
        />
        
        <div className="flex items-center gap-3 bg-black/20 p-2 rounded-xl border border-white/5 backdrop-blur-md">
          <div className="relative">
            <Filter className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <PremiumSelect 
              value={filterType} 
              onChange={(e) => setFilterType(e.target.value)}
              className="pl-9 py-2 border-none bg-transparent"
            >
              <option value="">All Events</option>
              <option value="antinuke_triggered">Anti-Nuke</option>
              <option value="antiraid_triggered">Anti-Raid</option>
              <option value="automod_action">Auto-Mod</option>
              <option value="settings_change">Settings Changed</option>
            </PremiumSelect>
          </div>
        </div>
      </div>

      <div className="glass-panel rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="border-b border-white/10 bg-black/40">
                <th className="p-4 font-medium text-muted-foreground text-sm">Action Type</th>
                <th className="p-4 font-medium text-muted-foreground text-sm">Target / Subject</th>
                <th className="p-4 font-medium text-muted-foreground text-sm">Executed By</th>
                <th className="p-4 font-medium text-muted-foreground text-sm">Reason / Details</th>
                <th className="p-4 font-medium text-muted-foreground text-sm text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-muted-foreground">Loading logs...</td>
                </tr>
              ) : logs?.length ? (
                logs.map(log => (
                  <tr key={log.id} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="p-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border uppercase tracking-wider ${getBadgeColor(log.type)}`}>
                        {log.type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="p-4">
                      {log.targetName ? (
                        <div className="font-medium text-white">{log.targetName} <span className="text-xs text-muted-foreground font-mono block">{log.targetId}</span></div>
                      ) : <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className="p-4">
                      {log.executorName ? (
                        <div className="font-medium text-white">{log.executorName}</div>
                      ) : <span className="text-primary font-medium">System / Bot</span>}
                    </td>
                    <td className="p-4">
                      <div className="text-sm text-white">{log.reason || '-'}</div>
                      {log.details && <div className="text-xs text-muted-foreground truncate max-w-[200px]" title={log.details}>{log.details}</div>}
                    </td>
                    <td className="p-4 text-right text-sm text-muted-foreground whitespace-nowrap">
                      {format(new Date(log.createdAt), 'MMM d, h:mm:ss a')}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-12 text-center text-muted-foreground">
                    <ActivitySquare className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    No logs found matching this criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </motion.div>
  );
}
