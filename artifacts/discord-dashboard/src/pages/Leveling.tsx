import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpCircle, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/store';
import { useGetLevelingSettings, useUpdateLevelingSettings, useGetGuildRoles, useGetGuildChannels } from '@workspace/api-client-react';
import type { LevelingSettings, LevelRole } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSwitch, PremiumSelect, PremiumInput, PremiumButton, PremiumTextarea } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function Leveling() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useGetLevelingSettings(guildId || '', { query: { enabled: !!guildId } });
  const { data: roles } = useGetGuildRoles(guildId || '', { query: { enabled: !!guildId } });
  const { data: channels } = useGetGuildChannels(guildId || '', { query: { enabled: !!guildId } });
  
  const updateSettings = useUpdateLevelingSettings();

  const [form, setForm] = useState<LevelingSettings | null>(null);
  const [newLevel, setNewLevel] = useState<number>(5);
  const [newRoleId, setNewRoleId] = useState<string>('');

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = () => {
    if (!form || !guildId) return;
    updateSettings.mutate({ guildId, data: form }, {
      onSuccess: () => toast({ title: "Leveling Settings saved" }),
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" })
    });
  };

  const handleAddRole = () => {
    if (!form || !newRoleId) return;
    const roleName = roles?.find(r => r.id === newRoleId)?.name || 'Unknown Role';
    setForm({
      ...form,
      levelRoles: [...form.levelRoles, { level: newLevel, roleId: newRoleId, roleName }]
    });
  };

  if (!form || isLoading) return <div className="text-white">Loading...</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24">
      <div className="flex justify-between items-start mb-8">
        <PageHeader 
          title="Leveling System" 
          description="Reward your active community members with XP and roles." 
        />
        <PremiumButton onClick={handleSave} isLoading={updateSettings.isPending}>
          Save Changes
        </PremiumButton>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <div className="space-y-6">
          <PremiumCard>
            <div className="flex items-center justify-between mb-8 pb-6 border-b border-white/5">
              <div>
                <h3 className="text-xl font-bold font-display text-white">Enable Leveling</h3>
                <p className="text-sm text-muted-foreground mt-1">Users gain XP for sending messages</p>
              </div>
              <PremiumSwitch checked={form.enabled} onChange={(c) => setForm({ ...form, enabled: c })} />
            </div>

            <div className="grid grid-cols-2 gap-6 mb-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">XP Per Message</label>
                <PremiumInput 
                  type="number" 
                  value={form.xpPerMessage} 
                  onChange={(e) => setForm({ ...form, xpPerMessage: parseInt(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Cooldown (Sec)</label>
                <PremiumInput 
                  type="number" 
                  value={form.xpCooldownSeconds} 
                  onChange={(e) => setForm({ ...form, xpCooldownSeconds: parseInt(e.target.value) })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Level Up Channel</label>
              <PremiumSelect 
                value={form.levelUpChannelId || ''} 
                onChange={(e) => setForm({ ...form, levelUpChannelId: e.target.value })}
              >
                <option value="">Current Channel</option>
                {channels?.filter(c => c.type === 'text').map(c => (
                  <option key={c.id} value={c.id}># {c.name}</option>
                ))}
              </PremiumSelect>
            </div>

            <div className="space-y-2 mt-6">
              <label className="text-sm font-medium text-white">Level Up Message</label>
              <p className="text-xs text-muted-foreground mb-2">Variables: {"{user}"}, {"{level}"}</p>
              <PremiumTextarea 
                value={form.levelUpMessage} 
                onChange={(e) => setForm({ ...form, levelUpMessage: e.target.value })}
              />
            </div>
          </PremiumCard>
        </div>

        <div className="space-y-6">
          <PremiumCard>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold font-display text-white">Level Roles</h3>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Stack Roles</span>
                <PremiumSwitch checked={form.stackRoles} onChange={(c) => setForm({ ...form, stackRoles: c })} />
              </div>
            </div>

            <div className="flex items-end gap-4 mb-6 p-4 rounded-xl bg-black/20 border border-white/5">
              <div className="w-24 space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Level</label>
                <PremiumInput 
                  type="number" 
                  value={newLevel} 
                  onChange={(e) => setNewLevel(parseInt(e.target.value))}
                />
              </div>
              <div className="flex-1 space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Role Reward</label>
                <PremiumSelect 
                  value={newRoleId} 
                  onChange={(e) => setNewRoleId(e.target.value)}
                >
                  <option value="">Select Role...</option>
                  {roles?.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </PremiumSelect>
              </div>
              <PremiumButton onClick={handleAddRole} disabled={!newRoleId}>
                <Plus className="w-5 h-5" />
              </PremiumButton>
            </div>

            <div className="space-y-2">
              {form.levelRoles.sort((a,b)=>a.level - b.level).map((lr, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-card border border-white/5">
                  <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                      {lr.level}
                    </div>
                    <span className="font-medium text-white">{lr.roleName}</span>
                  </div>
                  <button 
                    onClick={() => setForm({ ...form, levelRoles: form.levelRoles.filter(x => x.roleId !== lr.roleId) })}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {form.levelRoles.length === 0 && (
                <p className="text-sm text-center text-muted-foreground py-4">No level roles configured.</p>
              )}
            </div>
          </PremiumCard>
        </div>
      </div>
    </motion.div>
  );
}
