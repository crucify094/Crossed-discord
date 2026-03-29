import React from 'react';
import { motion } from 'framer-motion';
import { Users, Activity, MessageSquare, AlertOctagon, ShieldAlert, CircleSlash } from 'lucide-react';
import { useStore } from '@/store';
import { useGetGuildOverview, useGetAuditLogs } from '@workspace/api-client-react';
import { PremiumCard, PageHeader } from '@/components/PremiumComponents';
import { format } from 'date-fns';

export default function Dashboard() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { data: overview, isLoading: overviewLoading } = useGetGuildOverview(guildId || '', { query: { enabled: !!guildId } });
  const { data: recentLogs, isLoading: logsLoading } = useGetAuditLogs(guildId || '', { limit: 5 }, { query: { enabled: !!guildId } });

  const stats = [
    { name: 'Total Members', value: overview?.memberCount, icon: Users, color: 'text-blue-500', bg: 'bg-blue-500/10' },
    { name: 'Online Now', value: overview?.onlineCount, icon: Activity, color: 'text-green-500', bg: 'bg-green-500/10' },
    { name: 'Messages Processed', value: overview?.messagesProcessed, icon: MessageSquare, color: 'text-purple-500', bg: 'bg-purple-500/10' },
    { name: 'Warnings Today', value: overview?.warningsToday, icon: AlertOctagon, color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
    { name: 'Bans Today', value: overview?.bansToday, icon: CircleSlash, color: 'text-red-500', bg: 'bg-red-500/10' },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <PageHeader 
        title="Server Overview" 
        description="At-a-glance metrics and recent security activity for your community." 
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6 mb-8">
        {stats.map((stat, i) => (
          <PremiumCard key={i} className="flex flex-col relative overflow-hidden group">
            <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full ${stat.bg} blur-2xl group-hover:bg-opacity-20 transition-all`} />
            <div className="flex items-center gap-4 mb-4 relative z-10">
              <div className={`p-3 rounded-xl ${stat.bg} ${stat.color}`}>
                <stat.icon className="w-6 h-6" />
              </div>
            </div>
            <p className="text-muted-foreground font-medium text-sm mb-1">{stat.name}</p>
            <h3 className="text-3xl font-display font-bold text-white">
              {overviewLoading ? '...' : (stat.value?.toLocaleString() || '0')}
            </h3>
          </PremiumCard>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <PremiumCard className="lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-bold font-display">Recent Activity</h3>
            <span className="text-sm text-primary hover:underline cursor-pointer">View All</span>
          </div>
          
          <div className="space-y-4">
            {logsLoading ? (
              <p className="text-muted-foreground">Loading recent events...</p>
            ) : recentLogs?.length ? (
              recentLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-4 p-4 rounded-xl bg-black/20 border border-white/5 hover:border-white/10 transition-colors">
                  <div className="mt-1">
                    {log.type.includes('antinuke') || log.type.includes('ban') ? (
                      <ShieldAlert className="w-5 h-5 text-destructive" />
                    ) : log.type.includes('warn') || log.type.includes('automod') ? (
                      <AlertOctagon className="w-5 h-5 text-warning" />
                    ) : (
                      <Activity className="w-5 h-5 text-primary" />
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-white mb-1">
                      <span className="text-primary">{log.executorName || 'System'}</span> {log.type.replace(/_/g, ' ')} {log.targetName && <span className="font-bold text-white">{log.targetName}</span>}
                    </p>
                    {log.reason && <p className="text-xs text-muted-foreground mb-2">Reason: {log.reason}</p>}
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      {format(new Date(log.createdAt), 'MMM d, yyyy h:mm a')}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground text-center py-8">No recent activity found.</p>
            )}
          </div>
        </PremiumCard>

        <PremiumCard>
          <h3 className="text-xl font-bold font-display mb-6">Security Status</h3>
          <div className="space-y-6">
            <div className="flex items-center justify-between p-4 rounded-xl bg-black/20 border border-white/5">
              <div>
                <p className="font-bold text-white mb-1">Anti-Nuke</p>
                <p className="text-xs text-muted-foreground">Protection against rogue admins</p>
              </div>
              <div className={`px-3 py-1 rounded-full text-xs font-bold ${overview?.antinukeEnabled ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'}`}>
                {overview?.antinukeEnabled ? 'ACTIVE' : 'DISABLED'}
              </div>
            </div>
            
            <div className="flex items-center justify-between p-4 rounded-xl bg-black/20 border border-white/5">
              <div>
                <p className="font-bold text-white mb-1">Anti-Raid</p>
                <p className="text-xs text-muted-foreground">Join rate limit & account filters</p>
              </div>
              <div className={`px-3 py-1 rounded-full text-xs font-bold ${overview?.antiraidEnabled ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'}`}>
                {overview?.antiraidEnabled ? 'ACTIVE' : 'DISABLED'}
              </div>
            </div>
          </div>
        </PremiumCard>
      </div>
    </motion.div>
  );
}
