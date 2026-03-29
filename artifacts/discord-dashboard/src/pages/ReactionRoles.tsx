import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { SmilePlus, Trash2, Plus } from 'lucide-react';
import { useStore } from '@/store';
import { useGetReactionRoles, useCreateReactionRole, useDeleteReactionRole, useGetGuildChannels, useGetGuildRoles } from '@workspace/api-client-react';
import { PremiumCard, PageHeader, PremiumSelect, PremiumInput, PremiumButton } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';

export default function ReactionRoles() {
  const guildId = useStore((state) => state.selectedGuildId);
  const { toast } = useToast();
  
  const { data: rolesConfig, refetch } = useGetReactionRoles(guildId || '', { query: { enabled: !!guildId } });
  const { data: channels } = useGetGuildChannels(guildId || '', { query: { enabled: !!guildId } });
  const { data: roles } = useGetGuildRoles(guildId || '', { query: { enabled: !!guildId } });
  
  const createConfig = useCreateReactionRole();
  const deleteConfig = useDeleteReactionRole();

  const [channelId, setChannelId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [emoji, setEmoji] = useState('');
  const [roleId, setRoleId] = useState('');

  const handleAdd = () => {
    if (!guildId || !channelId || !messageId || !emoji || !roleId) return;
    const roleName = roles?.find(r => r.id === roleId)?.name || 'Unknown';
    createConfig.mutate({
      guildId,
      data: { channelId, messageId, emoji, roleId, roleName }
    }, {
      onSuccess: () => {
        setEmoji('');
        setRoleId('');
        refetch();
        toast({ title: "Reaction role created" });
      }
    });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24 max-w-5xl mx-auto">
      <PageHeader 
        title="Reaction Roles" 
        description="Let users self-assign roles by reacting to messages." 
      />

      <PremiumCard className="mb-8">
        <h3 className="text-xl font-bold font-display text-white mb-6">Create New Binding</h3>
        <div className="grid md:grid-cols-5 gap-4 items-end">
          <div className="space-y-2 col-span-2 md:col-span-1">
            <label className="text-xs font-medium text-muted-foreground">Channel</label>
            <PremiumSelect value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Select...</option>
              {channels?.filter(c => c.type === 'text').map(c => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </PremiumSelect>
          </div>
          <div className="space-y-2 col-span-3 md:col-span-1">
            <label className="text-xs font-medium text-muted-foreground">Message ID</label>
            <PremiumInput placeholder="123456789..." value={messageId} onChange={(e) => setMessageId(e.target.value)} />
          </div>
          <div className="space-y-2 col-span-2 md:col-span-1">
            <label className="text-xs font-medium text-muted-foreground">Emoji</label>
            <PremiumInput placeholder="✨ or :custom:" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
          </div>
          <div className="space-y-2 col-span-3 md:col-span-1">
            <label className="text-xs font-medium text-muted-foreground">Role to Assign</label>
            <PremiumSelect value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Select...</option>
              {roles?.map(r => (
                <option key={r.id} value={r.id}>@{r.name}</option>
              ))}
            </PremiumSelect>
          </div>
          <div className="col-span-5 md:col-span-1 pb-1">
            <PremiumButton className="w-full" onClick={handleAdd} disabled={!channelId || !messageId || !emoji || !roleId || createConfig.isPending}>
              <Plus className="w-4 h-4 mr-2" /> Add
            </PremiumButton>
          </div>
        </div>
      </PremiumCard>

      <div className="glass-panel rounded-2xl overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10 bg-black/20">
              <th className="p-4 font-medium text-muted-foreground text-sm">Emoji</th>
              <th className="p-4 font-medium text-muted-foreground text-sm">Role</th>
              <th className="p-4 font-medium text-muted-foreground text-sm">Channel</th>
              <th className="p-4 font-medium text-muted-foreground text-sm">Message ID</th>
              <th className="p-4 font-medium text-muted-foreground text-sm text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rolesConfig?.map(rr => (
              <tr key={rr.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="p-4 text-2xl">{rr.emoji}</td>
                <td className="p-4">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/20 text-primary border border-primary/20">
                    @{rr.roleName}
                  </span>
                </td>
                <td className="p-4 text-sm text-white">#{channels?.find(c => c.id === rr.channelId)?.name || rr.channelId}</td>
                <td className="p-4 text-sm font-mono text-muted-foreground">{rr.messageId}</td>
                <td className="p-4 text-right">
                  <button 
                    onClick={() => guildId && rr.id && deleteConfig.mutate({ guildId, roleId: rr.id }, { onSuccess: () => refetch() })}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-all inline-block"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {(!rolesConfig || rolesConfig.length === 0) && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">
                  No reaction roles configured yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
