import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Terminal, ChevronDown, ChevronUp, Search, Slash, Hash, Shield, Star, Info } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { useStore } from '@/store';
import { PageHeader, PremiumCard, PremiumSwitch, PremiumInput } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/components/PremiumComponents';

// ── Types ────────────────────────────────────────────────────────────────────

interface AppCommand {
  id: string;
  name: string;
  description: string;
  type: number;
  scope: 'global' | 'guild';
  enabled: boolean;
  options: { name: string; description: string; type: number }[];
}

interface PrefixCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  category: string;
}

// ── Static prefix command list (mirrors prefixCommands.ts) ───────────────────

const PREFIX = '-';

const PREFIX_COMMANDS: PrefixCommand[] = [
  // General
  { name: 'help', aliases: ['h', 'cmds'], description: 'Shows all commands or details for a specific command.', usage: '[command | category]', category: 'General' },
  { name: 'ping', description: "Shows the bot's current latency.", usage: '', category: 'General' },
  { name: 'botinfo', aliases: ['about', 'bi'], description: 'Shows information about the bot.', usage: '', category: 'General' },
  { name: 'uptime', description: 'Shows how long the bot has been online.', usage: '', category: 'General' },
  { name: 'invite', description: 'Gets the invite link for the bot.', usage: '', category: 'General' },
  { name: 'userinfo', aliases: ['ui', 'whois'], description: 'Shows detailed information about a user.', usage: '[@user]', category: 'General' },
  { name: 'serverinfo', aliases: ['si', 'guildinfo'], description: 'Shows information about the current server.', usage: '', category: 'General' },
  { name: 'avatar', aliases: ['av', 'pfp'], description: 'Shows the avatar of a user.', usage: '[@user]', category: 'General' },
  { name: 'membercount', aliases: ['mc'], description: 'Shows member count breakdown for the server.', usage: '', category: 'General' },
  { name: 'channelinfo', aliases: ['ci'], description: 'Shows information about a channel.', usage: '[#channel]', category: 'General' },
  { name: 'roleinfo', aliases: ['ri'], description: 'Shows information about a role.', usage: '<@role|id>', category: 'General' },
  { name: 'inrole', description: 'Lists members who have a specific role.', usage: '<@role|id>', category: 'General' },
  { name: 'emojis', description: 'Lists all custom emojis in the server.', usage: '', category: 'General' },
  { name: 'firstmessage', aliases: ['first'], description: 'Links to the first message in this channel.', usage: '', category: 'General' },
  { name: 'permissions', aliases: ['perms'], description: "Shows a user's permissions in the current channel.", usage: '[@user]', category: 'General' },
  { name: 'color', aliases: ['colour'], description: 'Shows info about a hex color.', usage: '<#hexcode>', category: 'General' },
  { name: '8ball', aliases: ['ball', 'ask'], description: 'Ask the magic 8 ball a question.', usage: '<question>', category: 'General' },
  { name: 'flip', aliases: ['coin', 'coinflip'], description: 'Flips a coin.', usage: '', category: 'General' },
  { name: 'choose', aliases: ['pick'], description: 'Chooses randomly between given options.', usage: '<opt1> | <opt2> | ...', category: 'General' },
  { name: 'calc', aliases: ['calculate', 'math'], description: 'Evaluates a math expression.', usage: '<expression>', category: 'General' },
  { name: 'poll', description: 'Creates a reaction poll.', usage: '<question> | <opt1> | <opt2>', category: 'General' },
  { name: 'snipe', aliases: ['s'], description: 'Shows the last deleted message in this channel.', usage: '', category: 'General' },
  { name: 'afk', description: 'Sets your AFK status. Cleared when you next message.', usage: '[reason]', category: 'General' },
  // Moderation
  { name: 'ban', description: 'Bans a member from the server.', usage: '<@user|id> [reason]', category: 'Moderation' },
  { name: 'softban', aliases: ['sban'], description: 'Bans then immediately unbans (clears messages).', usage: '<@user|id> [reason]', category: 'Moderation' },
  { name: 'hackban', aliases: ['forceban', 'idban'], description: 'Bans a user by ID even if not in the server.', usage: '<userId> [reason]', category: 'Moderation' },
  { name: 'unban', description: 'Unbans a user by ID.', usage: '<userId> [reason]', category: 'Moderation' },
  { name: 'tempban', aliases: ['tban'], description: 'Bans a member for a set duration.', usage: '<@user|id> <duration> [reason]', category: 'Moderation' },
  { name: 'massban', aliases: ['mban'], description: 'Bans multiple users by ID at once.', usage: '<id1> <id2> ... [reason: ...]', category: 'Moderation' },
  { name: 'kick', description: 'Kicks a member from the server.', usage: '<@user|id> [reason]', category: 'Moderation' },
  { name: 'mute', aliases: ['timeout', 'to'], description: 'Times out a member for a given duration.', usage: '<@user|id> <duration> [reason]', category: 'Moderation' },
  { name: 'unmute', aliases: ['untimeout'], description: 'Removes a timeout from a member.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'deafen', aliases: ['deaf'], description: 'Server-deafens a member in voice.', usage: '<@user|id> [reason]', category: 'Moderation' },
  { name: 'undeafen', aliases: ['undeaf'], description: 'Removes server-deafen from a member.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'vckick', aliases: ['vcdisconnect', 'dvc'], description: 'Disconnects a member from their voice channel.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'vcmove', aliases: ['move'], description: 'Moves a member to a different voice channel.', usage: '<@user|id> <#channel|id>', category: 'Moderation' },
  { name: 'voiceban', aliases: ['vban'], description: 'Prevents a member from joining any voice channel.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'voiceunban', aliases: ['vunban'], description: "Restores a member's voice channel access.", usage: '<@user|id>', category: 'Moderation' },
  { name: 'warn', description: 'Issues a warning to a member.', usage: '<@user|id> <reason>', category: 'Moderation' },
  { name: 'warnings', aliases: ['warns', 'warnlist'], description: 'Shows all warnings for a member.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'clearwarns', aliases: ['clearwarnings', 'resetwarns'], description: 'Clears all warnings for a member.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'delwarn', aliases: ['removewarn', 'unwarn'], description: 'Removes a specific warning by case ID.', usage: '<@user|id> <caseId>', category: 'Moderation' },
  { name: 'purge', aliases: ['clear', 'prune', 'clean'], description: 'Bulk-deletes messages in the channel (1–100).', usage: '<amount> [@user]', category: 'Moderation' },
  { name: 'slowmode', aliases: ['slow'], description: 'Sets slowmode on the channel (0 to disable).', usage: '<seconds>', category: 'Moderation' },
  { name: 'lock', description: 'Locks the channel so @everyone cannot send.', usage: '[reason]', category: 'Moderation' },
  { name: 'unlock', description: 'Unlocks the channel.', usage: '[reason]', category: 'Moderation' },
  { name: 'lockdown', aliases: ['ld'], description: 'Locks ALL text channels in the server.', usage: '[reason]', category: 'Moderation' },
  { name: 'unlockdown', aliases: ['uld', 'unlockall'], description: 'Unlocks ALL text channels in the server.', usage: '', category: 'Moderation' },
  { name: 'nick', aliases: ['nickname'], description: "Changes or resets a member's nickname.", usage: '<@user|id> <nickname|reset>', category: 'Moderation' },
  { name: 'role', description: 'Toggles a role on a member.', usage: '<@user|id> <@role|id>', category: 'Moderation' },
  { name: 'addrole', aliases: ['ar', 'giverole'], description: 'Adds a role to a member.', usage: '<@user|id> <@role|id>', category: 'Moderation' },
  { name: 'removerole', aliases: ['rr', 'takerole'], description: 'Removes a role from a member.', usage: '<@user|id> <@role|id>', category: 'Moderation' },
  { name: 'strip', aliases: ['stripall'], description: 'Removes all removable roles from a member.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'nuke', description: 'Clones the channel and deletes the original.', usage: '[reason]', category: 'Moderation' },
  { name: 'say', description: 'Makes the bot send a message in the channel.', usage: '<message>', category: 'Moderation' },
  { name: 'announce', aliases: ['ann'], description: 'Sends an announcement embed to a channel.', usage: '<#channel> <message>', category: 'Moderation' },
  { name: 'dm', description: 'Sends a DM to a user.', usage: '<@user|id> <message>', category: 'Moderation' },
  { name: 'jail', description: 'Restricts a member so they can only see the jail channel.', usage: '<@user|id> [reason]', category: 'Moderation' },
  { name: 'unjail', description: 'Releases a member from jail.', usage: '<@user|id>', category: 'Moderation' },
  // Leveling
  { name: 'rank', aliases: ['level', 'xp'], description: 'Shows the leveling rank of a member.', usage: '[@user]', category: 'Leveling' },
  { name: 'leaderboard', aliases: ['lb', 'top'], description: 'Shows the top 10 members by XP.', usage: '', category: 'Leveling' },
];

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  General: <Info className="w-3.5 h-3.5" />,
  Moderation: <Shield className="w-3.5 h-3.5" />,
  Leveling: <Star className="w-3.5 h-3.5" />,
};

const CATEGORY_COLORS: Record<string, string> = {
  General: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  Moderation: 'bg-red-500/10 border-red-500/20 text-red-400',
  Leveling: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
};

const COMMAND_TYPES: Record<number, string> = {
  1: 'Slash Command',
  2: 'User Context Menu',
  3: 'Message Context Menu',
};

// ── App Command Row ───────────────────────────────────────────────────────────

function AppCommandRow({ cmd, guildId }: { cmd: AppCommand; guildId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      customFetch(`/api/guild/${guildId}/commands/${cmd.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (_data, enabled) => {
      queryClient.setQueryData<AppCommand[]>(['commands', guildId], (old) =>
        old?.map((c) => (c.id === cmd.id ? { ...c, enabled } : c))
      );
      toast({ title: `/${cmd.name} ${enabled ? 'enabled' : 'disabled'}` });
    },
    onError: () => toast({ title: 'Failed to update command', variant: 'destructive' }),
  });

  return (
    <div className={cn('border border-white/5 rounded-xl overflow-hidden transition-all', cmd.enabled ? 'bg-black/20' : 'bg-black/10 opacity-60')}>
      <div className="flex items-center gap-4 p-4">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Slash className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-semibold text-white">/{cmd.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-muted-foreground">{COMMAND_TYPES[cmd.type] ?? 'Command'}</span>
            <span className={cn('text-xs px-2 py-0.5 rounded-full border', cmd.scope === 'global' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-purple-500/10 border-purple-500/30 text-purple-400')}>
              {cmd.scope}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5 truncate">{cmd.description || 'No description provided.'}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <PremiumSwitch checked={cmd.enabled} onCheckedChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} />
          {cmd.options.length > 0 && (
            <button onClick={() => setExpanded((e) => !e)} className="p-1.5 rounded-lg hover:bg-white/5 text-muted-foreground hover:text-white transition-colors">
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>
      {expanded && cmd.options.length > 0 && (
        <div className="border-t border-white/5 px-4 py-3 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Options</p>
          {cmd.options.map((opt) => (
            <div key={opt.name} className="flex items-start gap-3 text-sm pl-2">
              <span className="font-mono text-primary/80 shrink-0">{opt.name}</span>
              <span className="text-muted-foreground">{opt.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Prefix Command Row ────────────────────────────────────────────────────────

function PrefixCommandRow({ cmd }: { cmd: PrefixCommand }) {
  return (
    <div className="flex items-center gap-4 p-4 border border-white/5 rounded-xl bg-black/20">
      <div className="w-9 h-9 rounded-lg bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0 text-orange-400 font-bold text-sm">
        {PREFIX}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-white">{PREFIX}{cmd.name}</span>
          {cmd.usage && (
            <span className="font-mono text-xs text-muted-foreground opacity-60">{cmd.usage}</span>
          )}
          <span className={cn('text-xs px-2 py-0.5 rounded-full border flex items-center gap-1', CATEGORY_COLORS[cmd.category] ?? 'bg-white/5 border-white/10 text-muted-foreground')}>
            {CATEGORY_ICONS[cmd.category]}
            {cmd.category}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{cmd.description}</p>
        {cmd.aliases && cmd.aliases.length > 0 && (
          <p className="text-xs text-muted-foreground/60 mt-1">
            Aliases: {cmd.aliases.map((a) => <span key={a} className="font-mono">{PREFIX}{a}</span>).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], [])}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'prefix' | 'slash';

export default function Commands() {
  const guildId = useStore((state) => state.selectedGuildId);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('prefix');

  const { data: appCommands = [], isLoading } = useQuery<AppCommand[]>({
    queryKey: ['commands', guildId],
    queryFn: () => customFetch(`/api/guild/${guildId}/commands`),
    enabled: !!guildId,
  });

  const filteredApp = appCommands.filter(
    (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.description.toLowerCase().includes(search.toLowerCase())
  );
  const filteredPrefix = PREFIX_COMMANDS.filter(
    (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.description.toLowerCase().includes(search.toLowerCase())
  );

  const enabledCount = appCommands.filter((c) => c.enabled).length;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="pb-24">
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-4">
        <PageHeader
          title="Commands"
          description={`Manage your bot's prefix commands (${PREFIX}) and slash commands.`}
        />
        {tab === 'slash' && (
          <div className="px-4 py-2 rounded-xl bg-primary/10 border border-primary/20 text-sm font-medium text-primary shrink-0">
            {enabledCount} / {appCommands.length} enabled
          </div>
        )}
        {tab === 'prefix' && (
          <div className="px-4 py-2 rounded-xl bg-orange-500/10 border border-orange-500/20 text-sm font-medium text-orange-400 shrink-0">
            Prefix: <span className="font-mono font-bold">{PREFIX}</span> &nbsp;·&nbsp; {PREFIX_COMMANDS.length} commands
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 p-1 bg-black/30 rounded-xl border border-white/5 w-fit">
        {(['prefix', 'slash'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize',
              tab === t
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-muted-foreground hover:text-white'
            )}
          >
            {t === 'prefix' ? `${PREFIX} Prefix Commands` : '/ Slash Commands'}
          </button>
        ))}
      </div>

      <PremiumCard className="p-6">
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PremiumInput
            placeholder="Search commands..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {tab === 'prefix' && (
          filteredPrefix.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Terminal className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="font-medium">No commands match your search.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredPrefix.map((cmd) => <PrefixCommandRow key={cmd.name} cmd={cmd} />)}
            </div>
          )
        )}

        {tab === 'slash' && (
          isLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />
              ))}
            </div>
          ) : filteredApp.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Terminal className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="font-medium">
                {search ? 'No commands match your search.' : 'No application commands found for this bot.'}
              </p>
              {!search && (
                <p className="text-sm mt-1 opacity-70">Register slash commands with Discord to see them here.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredApp.map((cmd) => <AppCommandRow key={cmd.id} cmd={cmd} guildId={guildId!} />)}
            </div>
          )
        )}
      </PremiumCard>
    </motion.div>
  );
}
