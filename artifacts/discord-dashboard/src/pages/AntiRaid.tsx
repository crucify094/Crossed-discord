import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldAlert, Lock } from 'lucide-react';
import { useStore } from '@/store';
import { useGetAntiraidSettings, useUpdateAntiraidSettings } from '@workspace/api-client-react';
import type { AntiraidSettings } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSwitch, PremiumSelect, PremiumInput, PremiumButton } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function AntiRaid() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useGetAntiraidSettings(guildId || '', { query: { enabled: !!guildId } });
  const updateSettings = useUpdateAntiraidSettings();

  const [form, setForm] = useState<AntiraidSettings | null>(null);

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
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24">
      <div className="flex justify-between items-start mb-8">
        <PageHeader 
          title="Anti-Raid Setup" 
          description="Prevent mass bot joins and malicious automated raids." 
          badge={form.enabled ? <div className="px-3 py-1 bg-warning/20 text-warning border border-warning/30 rounded-full text-xs font-bold flex items-center gap-2"><ShieldAlert className="w-3 h-3"/> ACTIVE</div> : null}
        />
        <PremiumButton onClick={handleSave} isLoading={updateSettings.isPending}>
          Save Changes
        </PremiumButton>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <PremiumCard>
          <div className="flex items-center justify-between mb-8 pb-6 border-b border-white/5">
            <div>
              <h3 className="text-xl font-bold font-display text-white">Enable Anti-Raid</h3>
              <p className="text-sm text-muted-foreground mt-1">Turns on join monitoring</p>
            </div>
            <PremiumSwitch checked={form.enabled} onChange={(c) => setForm({ ...form, enabled: c })} />
          </div>

          <h4 className="font-bold text-white mb-4">Rate Limiting</h4>
          <div className="grid grid-cols-2 gap-6 mb-8">
            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Max Joins</label>
              <PremiumInput 
                type="number" 
                value={form.joinRateLimit} 
                onChange={(e) => setForm({ ...form, joinRateLimit: parseInt(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Per Interval (Sec)</label>
              <PremiumInput 
                type="number" 
                value={form.joinRateInterval} 
                onChange={(e) => setForm({ ...form, joinRateInterval: parseInt(e.target.value) })}
              />
            </div>
          </div>

          <div className="space-y-2 mb-8">
            <label className="text-sm font-medium text-white">Action on Limit Exceeded</label>
            <PremiumSelect 
              value={form.action} 
              onChange={(e) => setForm({ ...form, action: e.target.value as any })}
            >
              <option value="kick">Kick Joiners</option>
              <option value="ban">Ban Joiners</option>
              <option value="timeout">Timeout Joiners</option>
            </PremiumSelect>
          </div>
        </PremiumCard>

        <div className="space-y-6">
          <PremiumCard>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-xl font-bold font-display text-white flex items-center gap-2">
                  <Lock className="w-5 h-5 text-destructive" /> Server Lockdown
                </h3>
                <p className="text-sm text-muted-foreground mt-1">Instantly reject ALL new members</p>
              </div>
              <PremiumSwitch checked={form.lockdownEnabled} onChange={(c) => setForm({ ...form, lockdownEnabled: c })} />
            </div>
          </PremiumCard>

          <PremiumCard>
            <h3 className="text-xl font-bold font-display text-white mb-6">Account Filters</h3>
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium text-white">Filter No-Avatar Accounts</h4>
                  <p className="text-sm text-muted-foreground">Kick users who have the default Discord avatar</p>
                </div>
                <PremiumSwitch checked={form.filterNoAvatar} onChange={(c) => setForm({ ...form, filterNoAvatar: c })} />
              </div>
              
              <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                <div>
                  <h4 className="font-medium text-white">Filter New Accounts</h4>
                  <p className="text-sm text-muted-foreground">Kick users whose accounts are too new</p>
                </div>
                <PremiumSwitch checked={form.filterNewAccounts} onChange={(c) => setForm({ ...form, filterNewAccounts: c })} />
              </div>

              {form.filterNewAccounts && (
                <div className="pl-4 border-l-2 border-primary/50 space-y-2">
                  <label className="text-sm font-medium text-white">Minimum Account Age (Days)</label>
                  <PremiumInput 
                    type="number" 
                    value={form.minAccountAgeDays} 
                    onChange={(e) => setForm({ ...form, minAccountAgeDays: parseInt(e.target.value) })}
                  />
                </div>
              )}
            </div>
          </PremiumCard>
        </div>
      </div>
    </motion.div>
  );
}
