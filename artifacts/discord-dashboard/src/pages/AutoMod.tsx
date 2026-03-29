import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FileWarning } from 'lucide-react';
import { useStore } from '@/store';
import { useGetAutomodSettings, useUpdateAutomodSettings } from '@workspace/api-client-react';
import type { AutomodSettings } from '@workspace/api-client-react/src/generated/api.schemas';
import { PremiumCard, PageHeader, PremiumSwitch, PremiumSelect, PremiumInput, PremiumButton, PremiumTextarea } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function AutoMod() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useGetAutomodSettings(guildId || '', { query: { enabled: !!guildId } });
  const updateSettings = useUpdateAutomodSettings();

  const [form, setForm] = useState<AutomodSettings | null>(null);

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

  const FilterRow = ({ title, desc, checked, onChange }: any) => (
    <div className="flex items-center justify-between p-4 rounded-xl bg-black/20 border border-white/5 hover:border-white/10 transition-colors">
      <div>
        <h4 className="font-bold text-white">{title}</h4>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      <PremiumSwitch checked={checked} onChange={onChange} />
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24">
      <div className="flex justify-between items-start mb-8">
        <PageHeader 
          title="Auto-Moderation" 
          description="Keep your chat clean automatically with advanced filters." 
        />
        <PremiumButton onClick={handleSave} isLoading={updateSettings.isPending}>
          Save Changes
        </PremiumButton>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <div className="space-y-6">
          <PremiumCard>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold font-display text-white">Core Filters</h3>
              <PremiumSwitch checked={form.enabled} onChange={(c) => setForm({ ...form, enabled: c })} />
            </div>

            <div className="space-y-3 opacity-100 transition-opacity" style={{ opacity: form.enabled ? 1 : 0.5 }}>
              <FilterRow 
                title="Discord Invites" 
                desc="Block links to other Discord servers" 
                checked={form.filterInvites} 
                onChange={(c: boolean) => setForm({ ...form, filterInvites: c })} 
              />
              <FilterRow 
                title="External Links" 
                desc="Block all http/https links" 
                checked={form.filterLinks} 
                onChange={(c: boolean) => setForm({ ...form, filterLinks: c })} 
              />
              <FilterRow 
                title="Message Spam" 
                desc="Prevent users from sending identical messages rapidly" 
                checked={form.filterSpam} 
                onChange={(c: boolean) => setForm({ ...form, filterSpam: c })} 
              />
              
              <div className="p-4 rounded-xl bg-black/20 border border-white/5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-bold text-white">CAPS Filter</h4>
                    <p className="text-sm text-muted-foreground">Block messages with too many capital letters</p>
                  </div>
                  <PremiumSwitch checked={form.filterCaps} onChange={(c) => setForm({ ...form, filterCaps: c })} />
                </div>
                {form.filterCaps && (
                  <div className="pt-2">
                    <label className="text-xs font-medium text-muted-foreground mb-2 block">Threshold (%)</label>
                    <PremiumInput 
                      type="number" 
                      value={form.capsThreshold} 
                      onChange={(e) => setForm({ ...form, capsThreshold: parseInt(e.target.value) })}
                    />
                  </div>
                )}
              </div>

              <div className="p-4 rounded-xl bg-black/20 border border-white/5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-bold text-white">Mention Spam</h4>
                    <p className="text-sm text-muted-foreground">Block messages mentioning too many users</p>
                  </div>
                  <PremiumSwitch checked={form.filterMentionSpam} onChange={(c) => setForm({ ...form, filterMentionSpam: c })} />
                </div>
                {form.filterMentionSpam && (
                  <div className="pt-2">
                    <label className="text-xs font-medium text-muted-foreground mb-2 block">Max Mentions</label>
                    <PremiumInput 
                      type="number" 
                      value={form.maxMentions} 
                      onChange={(e) => setForm({ ...form, maxMentions: parseInt(e.target.value) })}
                    />
                  </div>
                )}
              </div>
            </div>
          </PremiumCard>
        </div>

        <div className="space-y-6">
          <PremiumCard>
            <h3 className="text-xl font-bold font-display text-white mb-6">Punishment Config</h3>
            <div className="space-y-2">
              <label className="text-sm font-medium text-white">Action to take when a filter triggers</label>
              <PremiumSelect 
                value={form.spamAction} 
                onChange={(e) => setForm({ ...form, spamAction: e.target.value as any })}
              >
                <option value="delete">Delete Message Only</option>
                <option value="warn">Delete & Warn User</option>
                <option value="mute">Delete & Mute User</option>
                <option value="kick">Delete & Kick User</option>
                <option value="ban">Delete & Ban User</option>
              </PremiumSelect>
            </div>
          </PremiumCard>

          <PremiumCard>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-display text-white">Bad Words Filter</h3>
              <PremiumSwitch checked={form.filterWords} onChange={(c) => setForm({ ...form, filterWords: c })} />
            </div>
            
            {form.filterWords && (
              <div className="space-y-2 mt-4 animate-in fade-in slide-in-from-top-4">
                <label className="text-sm font-medium text-white">Banned Words (comma separated)</label>
                <PremiumTextarea 
                  value={form.bannedWords.join(', ')} 
                  onChange={(e) => setForm({ ...form, bannedWords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  placeholder="e.g. badword1, badword2, scam"
                />
              </div>
            )}
          </PremiumCard>
        </div>
      </div>
    </motion.div>
  );
}
