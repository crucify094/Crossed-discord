import React, { useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { useGetBotGuilds, useGetBotInfo } from '@workspace/api-client-react';
import { useStore } from '@/store';
import { cn } from '@/components/PremiumComponents';
import { 
  LayoutDashboard, Shield, ShieldAlert, FileWarning, 
  MessageSquareWarning, ArrowUpCircle, SmilePlus, 
  UserPlus, RadioReceiver, ActivitySquare, Settings,
  ChevronDown, Server, Loader2, Terminal
} from 'lucide-react';
import { Toaster } from '@/components/ui/toaster';

const NAV_ITEMS = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard, section: 'Overview' },
  { name: 'Anti-Nuke', href: '/security/antinuke', icon: Shield, section: 'Security' },
  { name: 'Anti-Raid', href: '/security/antiraid', icon: ShieldAlert, section: 'Security' },
  { name: 'Auto-Mod', href: '/moderation/automod', icon: FileWarning, section: 'Moderation' },
  { name: 'Jail System', href: '/moderation/jail', icon: MessageSquareWarning, section: 'Moderation' },
  { name: 'Leveling', href: '/engagement/leveling', icon: ArrowUpCircle, section: 'Engagement' },
  { name: 'Reaction Roles', href: '/engagement/reaction-roles', icon: SmilePlus, section: 'Engagement' },
  { name: 'Welcome & Goodbye', href: '/engagement/welcome', icon: UserPlus, section: 'Engagement' },
  { name: 'App Commands', href: '/commands', icon: Terminal, section: 'Features' },
  { name: 'Social Alerts', href: '/social-alerts', icon: RadioReceiver, section: 'Features' },
  { name: 'Audit Logs', href: '/logs', icon: ActivitySquare, section: 'Features' },
  { name: 'Bot Settings', href: '/bot-settings', icon: Settings, section: 'System' },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: guilds, isLoading: isLoadingGuilds } = useGetBotGuilds();
  const { data: botInfo } = useGetBotInfo();
  
  const selectedGuildId = useStore((state) => state.selectedGuildId);
  const setSelectedGuildId = useStore((state) => state.setSelectedGuildId);

  useEffect(() => {
    if (guilds?.length && !selectedGuildId) {
      setSelectedGuildId(guilds[0].id);
    } else if (guilds?.length && selectedGuildId) {
      const exists = guilds.find(g => g.id === selectedGuildId);
      if (!exists) setSelectedGuildId(guilds[0].id);
    }
  }, [guilds, selectedGuildId, setSelectedGuildId]);

  const selectedGuild = guilds?.find(g => g.id === selectedGuildId);

  // Group nav items by section
  const sections = NAV_ITEMS.reduce((acc, item) => {
    if (!acc[item.section]) acc[item.section] = [];
    acc[item.section].push(item);
    return acc;
  }, {} as Record<string, typeof NAV_ITEMS>);

  return (
    <div className="flex h-screen overflow-hidden bg-background relative">
      {/* Background ambient glow */}
      <img 
        src={`${import.meta.env.BASE_URL}images/dashboard-glow.png`} 
        alt="glow" 
        className="absolute top-0 right-0 w-full h-full object-cover opacity-30 pointer-events-none mix-blend-screen"
      />

      {/* Sidebar */}
      <aside className="w-72 flex flex-col bg-card/30 border-r border-white/5 backdrop-blur-3xl z-20">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center border border-primary/30 shadow-[0_0_15px_rgba(88,101,242,0.3)]">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg leading-tight text-white">Bleed</h2>
              <p className="text-xs text-muted-foreground">Admin Console</p>
            </div>
          </div>

          {/* Server Selector */}
          <div className="relative group">
            <select
              className="w-full appearance-none bg-black/20 border border-white/10 text-white rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all cursor-pointer"
              value={selectedGuildId || ''}
              onChange={(e) => setSelectedGuildId(e.target.value)}
              disabled={isLoadingGuilds}
            >
              {isLoadingGuilds ? (
                <option value="">Loading servers...</option>
              ) : guilds?.length ? (
                guilds.map((g) => (
                  <option key={g.id} value={g.id} className="bg-card text-white">
                    {g.name}
                  </option>
                ))
              ) : (
                <option value="">No servers found</option>
              )}
            </select>
            <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-6">
          {Object.entries(sections).map(([section, items]) => (
            <div key={section}>
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 px-3">
                {section}
              </h3>
              <div className="space-y-1">
                {items.map((item) => {
                  const isActive = location === item.href;
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group",
                        isActive 
                          ? "bg-primary/10 text-primary border border-primary/20 shadow-[inset_0_0_20px_rgba(88,101,242,0.05)]" 
                          : "text-muted-foreground hover:bg-white/5 hover:text-white"
                      )}
                    >
                      <item.icon className={cn("w-5 h-5", isActive ? "text-primary" : "text-muted-foreground group-hover:text-white")} />
                      {item.name}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Bot Profile Snippet */}
        {botInfo && (
          <div className="p-4 border-t border-white/5 bg-black/10">
            <div className="flex items-center gap-3">
              <div className="relative">
                <img 
                  src={botInfo.avatar || "https://images.unsplash.com/photo-1614680376573-df3480f0c6ff?w=100&h=100&fit=crop"} 
                  alt="Bot Avatar" 
                  className="w-10 h-10 rounded-full object-cover border border-white/10"
                />
                <span className={cn(
                  "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-background",
                  botInfo.status === 'online' ? "bg-green-500" : 
                  botInfo.status === 'idle' ? "bg-yellow-500" : 
                  botInfo.status === 'dnd' ? "bg-red-500" : "bg-gray-500"
                )} />
              </div>
              <div className="flex-1 overflow-hidden">
                <p className="text-sm font-bold text-white truncate">{botInfo.username}</p>
                <p className="text-xs text-muted-foreground truncate">#{botInfo.discriminator}</p>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto z-10 relative">
        {!selectedGuildId && !isLoadingGuilds ? (
          <div className="flex items-center justify-center h-full text-center p-8">
            <div className="glass-panel p-8 rounded-2xl max-w-md">
              <Server className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
              <h2 className="text-2xl font-bold mb-2">No Server Selected</h2>
              <p className="text-muted-foreground">Please select a Discord server from the sidebar to continue managing it.</p>
            </div>
          </div>
        ) : isLoadingGuilds ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : (
          <div className="p-8 max-w-7xl mx-auto min-h-full">
            {children}
          </div>
        )}
      </main>
      <Toaster />
    </div>
  );
}
