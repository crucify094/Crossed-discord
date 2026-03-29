import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, ShieldCheck, Trash2, Plus } from 'lucide-react';
import { useStore } from '@/store';
import { 
  useGetAntinukeSettings, useUpdateAntinukeSettings,
  useGetAntinukeWhitelist, useAddToWhitelist, useRemoveFromWhitelist 
} from '@workspace/api-client-react';
import type { AntinukeSettings, WhitelistEntryTargetType } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSwitch, PremiumSelect, PremiumInput, PremiumButton } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function AntiNuke() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useGetAntinukeSettings(guildId || '', { query: { enabled: !!guildId } });
  const { data: whitelist } = useGetAntinukeWhitelist(guildId || '', { query: { enabled: !!guildId } });
  
  const updateSettings = useUpdateAntinukeSettings();
  const addWhitelist = useAddToWhitelist();
  const removeWhitelist = useRemoveFromWhitelist();

  const [form, setForm] = useState<AntinukeSettings | null>(null);
  const [newWhitelistId, setNewWhitelistId] = useState('');
  const [newWhitelistType, setNewWhitelistType] = useState<WhitelistEntryTargetType>('user');

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = () => {
    if (!form || !guildId) return;
    updateSettings.mutate({ guildId, data: form }, {
      onSuccess: () => {
        toast({ title: "Settings saved", description: "Anti-Nuke settings have been updated successfully.", variant: "default" });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message || "Failed to save settings.", variant: "destructive" });
      }
    });
  };

  const handleAddWhitelist = () => {
    if (!guildId || !newWhitelistId) return;
    addWhitelist.mutate({
      guildId,
      data: { targetId: newWhitelistId, targetType: newWhitelistType, targetName: 'Resolved by Bot' }
    }, {
      onSuccess: () => {
        setNewWhitelistId('');
        toast({ title: "Added to whitelist" });
      }
    });
  };

  if (!form || isLoading) return <div className="text-white">Loading...</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24">
      <div className="flex justify-between items-start mb-8">
        <PageHeader 
          title="Anti-Nuke Configuration" 
          description="Protect your server from malicious administrators or compromised staff accounts." 
          badge={form.enabled ? <div className="px-3 py-1 bg-success/20 text-success border border-success/30 rounded-full text-xs font-bold flex items-center gap-2"><ShieldCheck className="w-3 h-3"/> PROTECTED</div> : null}
        />
        <PremiumButton onClick={handleSave} isLoading={updateSettings.isPending}>
          Save Changes
        </PremiumButton>
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <PremiumCard>
            <div className="flex items-center justify-between mb-8 pb-6 border-b border-white/5">
              <div>
                <h3 className="text-xl font-bold font-display text-white">Master Toggle</h3>
                <p className="text-sm text-muted-foreground mt-1">Enable or disable all anti-nuke features</p>
              </div>
              <PremiumSwitch checked={form.enabled} onChange={(c) => setForm({ ...form, enabled: c })} />
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Max Channel Deletes</label>
                <PremiumInput 
                  type="number" 
                  value={form.maxChannelDeletes} 
                  onChange={(e) => setForm({ ...form, maxChannelDeletes: parseInt(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Max Bans</label>
                <PremiumInput 
                  type="number" 
                  value={form.maxBans} 
                  onChange={(e) => setForm({ ...form, maxBans: parseInt(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Max Kicks</label>
                <PremiumInput 
                  type="number" 
                  value={form.maxKicks} 
                  onChange={(e) => setForm({ ...form, maxKicks: parseInt(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Max Role Deletes</label>
                <PremiumInput 
                  type="number" 
                  value={form.maxRoleDeletes} 
                  onChange={(e) => setForm({ ...form, maxRoleDeletes: parseInt(e.target.value) })}
                />
              </div>
            </div>

            <div className="mt-8 grid md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Interval (Seconds)</label>
                <p className="text-xs text-muted-foreground mb-2">Time window to count the above actions</p>
                <PremiumInput 
                  type="number" 
                  value={form.intervalSeconds} 
                  onChange={(e) => setForm({ ...form, intervalSeconds: parseInt(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Punishment Action</label>
                <p className="text-xs text-muted-foreground mb-2">What to do to the rogue user</p>
                <PremiumSelect 
                  value={form.action} 
                  onChange={(e) => setForm({ ...form, action: e.target.value as any })}
                >
                  <option value="ban">Ban User</option>
                  <option value="kick">Kick User</option>
                  <option value="strip_roles">Strip All Roles</option>
                  <option value="timeout">Timeout</option>
                </PremiumSelect>
              </div>
            </div>
          </PremiumCard>

          <PremiumCard>
            <h3 className="text-xl font-bold font-display text-white mb-6">Additional Settings</h3>
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium text-white">DM Server Owner</h4>
                  <p className="text-sm text-muted-foreground">Send a direct message when anti-nuke is triggered</p>
                </div>
                <PremiumSwitch checked={form.dmOwner} onChange={(c) => setForm({ ...form, dmOwner: c })} />
              </div>
            </div>
          </PremiumCard>
        </div>

        <div className="space-y-6">
          <PremiumCard>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold font-display text-white">Whitelist</h3>
              <div className="p-2 bg-primary/20 rounded-lg text-primary">
                <Shield className="w-5 h-5" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Users and roles in this list bypass ALL anti-nuke restrictions. Be extremely careful who you add here.
            </p>

            <div className="space-y-4 mb-6 p-4 rounded-xl bg-black/20 border border-white/5">
              <PremiumSelect value={newWhitelistType} onChange={(e) => setNewWhitelistType(e.target.value as any)} className="py-2">
                <option value="user">User ID</option>
                <option value="role">Role ID</option>
              </PremiumSelect>
              <PremiumInput 
                placeholder="Enter Discord ID..." 
                value={newWhitelistId}
                onChange={(e) => setNewWhitelistId(e.target.value)}
              />
              <PremiumButton className="w-full" onClick={handleAddWhitelist} disabled={!newWhitelistId || addWhitelist.isPending}>
                <Plus className="w-4 h-4 mr-2" /> Add to Whitelist
              </PremiumButton>
            </div>

            <div className="space-y-2">
              {whitelist?.map(entry => (
                <div key={entry.id} className="flex items-center justify-between p-3 rounded-lg bg-card border border-white/5">
                  <div>
                    <p className="text-sm font-bold text-white">{entry.targetName}</p>
                    <p className="text-xs text-muted-foreground capitalize">{entry.targetType} • {entry.targetId}</p>
                  </div>
                  <button 
                    onClick={() => guildId && entry.id && removeWhitelist.mutate({ guildId, entryId: entry.id })}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {whitelist?.length === 0 && (
                <p className="text-sm text-center text-muted-foreground py-4">Whitelist is empty.</p>
              )}
            </div>
          </PremiumCard>
        </div>
      </div>
    </motion.div>
  );
}
