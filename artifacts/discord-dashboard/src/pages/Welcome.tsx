import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import { useGetWelcomeSettings, useUpdateWelcomeSettings, useGetGuildChannels } from '@workspace/api-client-react';
import type { WelcomeSettings } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSwitch, PremiumSelect, PremiumButton, PremiumTextarea } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function Welcome() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useGetWelcomeSettings(guildId || '', { query: { enabled: !!guildId } });
  const { data: channels } = useGetGuildChannels(guildId || '', { query: { enabled: !!guildId } });
  const updateSettings = useUpdateWelcomeSettings();

  const [form, setForm] = useState<WelcomeSettings | null>(null);
  const [activeTab, setActiveTab] = useState<'welcome' | 'goodbye' | 'dm' | 'boost' | 'logs'>('welcome');

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = () => {
    if (!form || !guildId) return;
    updateSettings.mutate({ guildId, data: form }, {
      onSuccess: () => toast({ title: "Settings saved" }),
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" })
    });
  };

  if (!form || isLoading) return <div className="text-white">Loading...</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24 max-w-4xl">
      <div className="flex justify-between items-start mb-8">
        <PageHeader 
          title="Greeting Messages" 
          description="Make a great first impression when users join or leave." 
        />
        <PremiumButton onClick={handleSave} isLoading={updateSettings.isPending}>
          Save Changes
        </PremiumButton>
      </div>

      <div className="flex flex-wrap gap-2 mb-6 p-1 bg-black/20 rounded-xl w-fit">
        {([
          { id: 'welcome', label: 'Welcome' },
          { id: 'goodbye', label: 'Goodbye' },
          { id: 'dm', label: 'DM' },
          { id: 'boost', label: '🚀 Boost' },
          { id: 'logs', label: '📋 Event Logs' },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id ? 'bg-primary text-white shadow-lg' : 'text-muted-foreground hover:text-white'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <PremiumCard className="min-h-[400px]">
        {activeTab === 'welcome' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="flex items-center justify-between pb-6 border-b border-white/5">
              <div>
                <h3 className="text-xl font-bold text-white">Welcome Channel Message</h3>
                <p className="text-sm text-muted-foreground mt-1">Sent when a user joins the server</p>
              </div>
              <PremiumSwitch checked={form.welcomeEnabled} onChange={(c) => setForm({ ...form, welcomeEnabled: c })} />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Channel</label>
              <PremiumSelect 
                value={form.welcomeChannelId || ''} 
                onChange={(e) => setForm({ ...form, welcomeChannelId: e.target.value })}
              >
                <option value="">-- Select Channel --</option>
                {channels?.filter(c => c.type === 'text').map(c => (
                  <option key={c.id} value={c.id}># {c.name}</option>
                ))}
              </PremiumSelect>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white flex justify-between">
                Message Content
                <span className="text-muted-foreground font-normal">Use {"{user}"}, {"{server}"}, {"{memberCount}"}</span>
              </label>
              <PremiumTextarea 
                value={form.welcomeMessage} 
                onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
                className="min-h-[150px]"
              />
            </div>
          </motion.div>
        )}

        {activeTab === 'goodbye' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="flex items-center justify-between pb-6 border-b border-white/5">
              <div>
                <h3 className="text-xl font-bold text-white">Goodbye Channel Message</h3>
                <p className="text-sm text-muted-foreground mt-1">Sent when a user leaves the server</p>
              </div>
              <PremiumSwitch checked={form.goodbyeEnabled} onChange={(c) => setForm({ ...form, goodbyeEnabled: c })} />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Channel</label>
              <PremiumSelect 
                value={form.goodbyeChannelId || ''} 
                onChange={(e) => setForm({ ...form, goodbyeChannelId: e.target.value })}
              >
                <option value="">-- Select Channel --</option>
                {channels?.filter(c => c.type === 'text').map(c => (
                  <option key={c.id} value={c.id}># {c.name}</option>
                ))}
              </PremiumSelect>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white flex justify-between">
                Message Content
                <span className="text-muted-foreground font-normal">Use {"{user}"}, {"{server}"}</span>
              </label>
              <PremiumTextarea 
                value={form.goodbyeMessage} 
                onChange={(e) => setForm({ ...form, goodbyeMessage: e.target.value })}
                className="min-h-[150px]"
              />
            </div>
          </motion.div>
        )}

        {activeTab === 'dm' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="flex items-center justify-between pb-6 border-b border-white/5">
              <div>
                <h3 className="text-xl font-bold text-white">Direct Message Welcome</h3>
                <p className="text-sm text-muted-foreground mt-1">Sent directly to the user's DMs upon joining</p>
              </div>
              <PremiumSwitch checked={form.dmWelcome} onChange={(c) => setForm({ ...form, dmWelcome: c })} />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white flex justify-between">
                DM Content
                <span className="text-muted-foreground font-normal">Use {"{user}"}, {"{server}"}</span>
              </label>
              <PremiumTextarea 
                value={form.dmMessage} 
                onChange={(e) => setForm({ ...form, dmMessage: e.target.value })}
                className="min-h-[150px]"
              />
            </div>
          </motion.div>
        )}

        {activeTab === 'boost' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="pb-6 border-b border-white/5">
              <h3 className="text-xl font-bold text-white">🚀 Boost Announcements</h3>
              <p className="text-sm text-muted-foreground mt-1">Sent when a user boosts the server. Set the channel with <code className="bg-white/10 px-1 rounded">-setbooster #channel</code></p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Boost Channel</label>
              <PremiumSelect 
                value={(form as any).boosterChannelId || ''} 
                onChange={(e) => setForm({ ...form, boosterChannelId: e.target.value } as any)}
              >
                <option value="">-- Select Channel --</option>
                {channels?.filter(c => c.type === 'text').map(c => (
                  <option key={c.id} value={c.id}># {c.name}</option>
                ))}
              </PremiumSelect>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white flex justify-between">
                Boost Message
                <span className="text-muted-foreground font-normal">Use {"{user}"}, {"{server}"}, {"{boostCount}"}, {"{boostLevel}"}</span>
              </label>
              <PremiumTextarea 
                value={(form as any).boosterMessage || '🎉 Thank you {user} for boosting **{server}**!'} 
                onChange={(e) => setForm({ ...form, boosterMessage: e.target.value } as any)}
                className="min-h-[120px]"
              />
            </div>
          </motion.div>
        )}

        {activeTab === 'logs' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="pb-6 border-b border-white/5">
              <h3 className="text-xl font-bold text-white">📋 Event Log Channel</h3>
              <p className="text-sm text-muted-foreground mt-1">All server events will be logged here. You can also set it with <code className="bg-white/10 px-1 rounded">-setlogchannel #channel</code></p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Log Channel</label>
              <PremiumSelect 
                value={(form as any).eventLogChannelId || ''} 
                onChange={(e) => setForm({ ...form, eventLogChannelId: e.target.value } as any)}
              >
                <option value="">-- Select Channel --</option>
                {channels?.filter(c => c.type === 'text').map(c => (
                  <option key={c.id} value={c.id}># {c.name}</option>
                ))}
              </PremiumSelect>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
              <p className="text-sm font-semibold text-white">Events that get logged:</p>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li>🗑️ Message deleted (with original content)</li>
                <li>✏️ Message edited (before &amp; after)</li>
                <li>➕ Reaction added</li>
                <li>➖ Reaction removed</li>
                <li>📢 Channel created</li>
                <li>🗑️ Channel deleted</li>
                <li>✏️ Channel renamed/updated</li>
              </ul>
            </div>
          </motion.div>
        )}
      </PremiumCard>
    </motion.div>
  );
}
