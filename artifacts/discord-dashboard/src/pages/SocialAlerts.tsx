import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Twitter, Instagram, Youtube, Twitch, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/store';
import { useGetSocialAlerts, useCreateSocialAlert, useDeleteSocialAlert, useGetGuildChannels } from '@workspace/api-client-react';
import type { SocialAlertPlatform } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSelect, PremiumInput, PremiumButton, PremiumTextarea } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function SocialAlerts() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: alerts, refetch } = useGetSocialAlerts(guildId || '', { query: { enabled: !!guildId } });
  const { data: channels } = useGetGuildChannels(guildId || '', { query: { enabled: !!guildId } });
  
  const createAlert = useCreateSocialAlert();
  const deleteAlert = useDeleteSocialAlert();

  const [platform, setPlatform] = useState<SocialAlertPlatform>('twitter');
  const [handle, setHandle] = useState('');
  const [channelId, setChannelId] = useState('');
  const [message, setMessage] = useState('Hey @everyone! {handle} just posted on {platform}! {link}');

  const handleAdd = () => {
    if (!guildId || !handle || !channelId) return;
    createAlert.mutate({
      guildId,
      data: { platform, accountHandle: handle, channelId, message, enabled: true }
    }, {
      onSuccess: () => {
        setHandle('');
        refetch();
        toast({ title: "Alert created successfully" });
      }
    });
  };

  const platformIcons: Record<string, any> = {
    twitter: <Twitter className="w-5 h-5 text-[#1DA1F2]" />,
    tiktok: <div className="font-bold text-white tracking-tighter text-lg">TikTok</div>,
    instagram: <Instagram className="w-5 h-5 text-[#E1306C]" />,
    youtube: <Youtube className="w-5 h-5 text-[#FF0000]" />,
    twitch: <Twitch className="w-5 h-5 text-[#9146FF]" />
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24">
      <PageHeader 
        title="Social Media Alerts" 
        description="Automatically post in your server when you go live or upload a new video." 
      />

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 space-y-6">
          <PremiumCard>
            <h3 className="text-xl font-bold font-display text-white mb-6">Add New Alert</h3>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Platform</label>
                <PremiumSelect value={platform} onChange={(e) => setPlatform(e.target.value as any)}>
                  <option value="twitter">Twitter / X</option>
                  <option value="youtube">YouTube</option>
                  <option value="twitch">Twitch</option>
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                </PremiumSelect>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Account Handle/URL</label>
                <PremiumInput value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Post Channel</label>
                <PremiumSelect value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="">-- Select Channel --</option>
                  {channels?.filter(c => c.type === 'text' || c.type === 'announcement').map(c => (
                    <option key={c.id} value={c.id}># {c.name}</option>
                  ))}
                </PremiumSelect>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Message</label>
                <PremiumTextarea value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[100px]" />
              </div>

              <PremiumButton className="w-full mt-2" onClick={handleAdd} disabled={!handle || !channelId || createAlert.isPending}>
                <Plus className="w-4 h-4 mr-2" /> Create Alert
              </PremiumButton>
            </div>
          </PremiumCard>
        </div>

        <div className="lg:col-span-2">
          <div className="grid md:grid-cols-2 gap-4">
            {alerts?.map(alert => (
              <PremiumCard key={alert.id} className="relative group">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-black/40 flex items-center justify-center">
                      {platformIcons[alert.platform]}
                    </div>
                    <div>
                      <p className="font-bold text-white capitalize">{alert.platform}</p>
                      <p className="text-sm text-muted-foreground">{alert.accountHandle}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => guildId && alert.id && deleteAlert.mutate({ guildId, alertId: alert.id }, { onSuccess: () => refetch() })}
                    className="opacity-0 group-hover:opacity-100 p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="text-sm bg-black/20 p-3 rounded-lg border border-white/5 mb-2">
                  <span className="text-primary mr-2">#{channels?.find(c => c.id === alert.channelId)?.name || alert.channelId}</span>
                  <span className="text-muted-foreground line-clamp-2">{alert.message}</span>
                </div>
                {alert.lastChecked && (
                  <p className="text-xs text-muted-foreground mt-2">Last checked: {new Date(alert.lastChecked).toLocaleString()}</p>
                )}
              </PremiumCard>
            ))}
            {alerts?.length === 0 && (
              <div className="col-span-2 p-8 text-center glass-panel rounded-2xl">
                <RadioReceiver className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium text-white mb-1">No alerts configured</p>
                <p className="text-muted-foreground">Add your first social media alert from the sidebar.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
