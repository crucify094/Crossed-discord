import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import { 
  useGetJailSettings, useUpdateJailSettings, 
  useGetGuildChannels, useGetGuildRoles 
} from '@workspace/api-client-react';
import type { JailSettings } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSwitch, PremiumSelect, PremiumButton } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function Jail() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useGetJailSettings(guildId || '', { query: { enabled: !!guildId } });
  const { data: channels } = useGetGuildChannels(guildId || '', { query: { enabled: !!guildId } });
  const { data: roles } = useGetGuildRoles(guildId || '', { query: { enabled: !!guildId } });
  
  const updateSettings = useUpdateJailSettings();

  const [form, setForm] = useState<JailSettings | null>(null);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = () => {
    if (!form || !guildId) return;
    updateSettings.mutate({ guildId, data: form }, {
      onSuccess: () => toast({ title: "Jail Settings saved" }),
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" })
    });
  };

  if (!form || isLoading) return <div className="text-white">Loading...</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24 max-w-3xl">
      <div className="flex justify-between items-start mb-8">
        <PageHeader 
          title="Jail System" 
          description="Restrict rule-breakers to a specific channel instead of kicking them." 
        />
      </div>

      <PremiumCard className="mb-6 border-primary/20">
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-white/5">
          <div>
            <h3 className="text-xl font-bold font-display text-white">Enable Jail System</h3>
            <p className="text-sm text-muted-foreground mt-1">Allows the /jail command to be used</p>
          </div>
          <PremiumSwitch checked={form.enabled} onChange={(c) => setForm({ ...form, enabled: c })} />
        </div>

        <div className="space-y-6 opacity-100 transition-opacity" style={{ opacity: form.enabled ? 1 : 0.5 }}>
          <div className="space-y-2">
            <label className="text-sm font-medium text-white">Jail Channel</label>
            <p className="text-xs text-muted-foreground mb-2">The only channel jailed users can see</p>
            <PremiumSelect 
              value={form.jailChannelId || ''} 
              onChange={(e) => setForm({ ...form, jailChannelId: e.target.value })}
            >
              <option value="">-- Select Channel --</option>
              {channels?.filter(c => c.type === 'text').map(c => (
                <option key={c.id} value={c.id}># {c.name}</option>
              ))}
            </PremiumSelect>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white">Jail Role</label>
            <p className="text-xs text-muted-foreground mb-2">The role assigned to jailed users (strips other roles)</p>
            <PremiumSelect 
              value={form.jailRoleId || ''} 
              onChange={(e) => setForm({ ...form, jailRoleId: e.target.value })}
            >
              <option value="">-- Select Role --</option>
              {roles?.map(r => (
                <option key={r.id} value={r.id}>@ {r.name}</option>
              ))}
            </PremiumSelect>
          </div>
          
          <div className="pt-6">
            <PremiumButton onClick={handleSave} isLoading={updateSettings.isPending} className="w-full">
              Save Configuration
            </PremiumButton>
          </div>
        </div>
      </PremiumCard>
    </motion.div>
  );
}
