import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Terminal, ChevronDown, ChevronUp, Search, Slash,
  Shield, Star, Swords, Users, Settings, BookOpen, Ticket,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { useStore } from '@/store';
import { PageHeader, PremiumCard, PremiumSwitch, PremiumInput } from '@/components/PremiumComponents';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/components/PremiumComponents';

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Static prefix command list ────────────────────────────────────────────────

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
  { name: 'remindme', aliases: ['remind'], description: 'Sets a personal reminder.', usage: '<duration> <reminder>', category: 'General' },
  { name: 'giveaway', aliases: ['gw'], description: 'Starts a giveaway in the current channel.', usage: '<duration> <winners> <prize>', category: 'General' },
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
  { name: 'vcmute', description: 'Server-mutes a member in voice.', usage: '<@user|id>', category: 'Moderation' },
  { name: 'vcunmute', description: 'Removes server-mute from a member in voice.', usage: '<@user|id>', category: 'Moderation' },
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
  { name: 'setlogchannel', aliases: ['setlog', 'setlogs'], description: 'Sets the event log channel (deleted msgs, edits, bans, kicks, VC, timeouts, jails & more).', usage: '<#channel>', category: 'Moderation' },
  { name: 'setvcchannel', aliases: ['setvc'], description: 'Sets the voice channel activity log channel.', usage: '<#channel>', category: 'Moderation' },
  { name: 'setprefix', description: "Changes the bot's command prefix (admin only).", usage: '<prefix>', category: 'Moderation' },
  { name: 'alias', description: 'Manage command aliases.', usage: 'add <command> <alias> | remove <alias> | list', category: 'Moderation' },
  { name: 'rolecreate', aliases: ['cr', 'mkrole'], description: 'Creates a new role.', usage: '<name> [color]', category: 'Moderation' },
  // Security
  { name: 'whitelist', description: 'Whitelists a user or bot from AntiNuke detection.', usage: '<user_id>', category: 'Security' },
  { name: 'unwhitelist', description: 'Removes a user from the AntiNuke whitelist.', usage: '<user_id>', category: 'Security' },
  { name: 'whitelistlist', aliases: ['wl'], description: 'Shows all whitelisted users for AntiNuke.', usage: '', category: 'Security' },
  { name: 'editantinuke', description: 'Enables or disables the AntiNuke system.', usage: 'enable | disable', category: 'Security' },
  { name: 'antinuke', description: 'Shows current AntiNuke settings.', usage: '', category: 'Security' },
  // Leveling
  { name: 'rank', aliases: ['level', 'xp'], description: 'Shows the leveling rank of a member.', usage: '[@user]', category: 'Leveling' },
  { name: 'leaderboard', aliases: ['lb', 'top'], description: 'Shows the top 10 members by XP.', usage: '', category: 'Leveling' },
  { name: 'setxp', description: "Sets a member's XP (admin only).", usage: '<@user|id> <amount>', category: 'Leveling' },
  { name: 'givexp', description: 'Gives XP to a member.', usage: '<@user|id> <amount>', category: 'Leveling' },
  { name: 'resetxp', description: 'Resets XP for a member or the whole server.', usage: '<@user|id | all>', category: 'Leveling' },
  // Tickets
  { name: 'ticket', description: 'Manage the ticket system (setup, manager, close).', usage: 'setup | manager add/remove <@role> | close', category: 'Tickets' },
  // Setup
  { name: 'setup', description: 'Quick setup guide for the bot.', usage: '', category: 'Setup' },
  { name: 'setwelcome', description: 'Sets the welcome announcements channel.', usage: '<#channel>', category: 'Setup' },
  { name: 'setbooster', description: 'Sets the booster announcements channel.', usage: '<#channel>', category: 'Setup' },
  { name: 'dmall', description: 'DMs all members in the server (admin only).', usage: '<message>', category: 'Setup' },
];

// ── Category Config ────────────────────────────────────────────────────────────

const CATEGORIES = [
  { name: 'All', icon: <BookOpen className="w-4 h-4" />, color: 'text-white' },
  { name: 'General', icon: <Users className="w-4 h-4" />, color: 'text-blue-400' },
  { name: 'Moderation', icon: <Shield className="w-4 h-4" />, color: 'text-yellow-400' },
  { name: 'Security', icon: <Swords className="w-4 h-4" />, color: 'text-red-400' },
  { name: 'Leveling', icon: <Star className="w-4 h-4" />, color: 'text-purple-400' },
  { name: 'Tickets', icon: <Ticket className="w-4 h-4" />, color: 'text-green-400' },
  { name: 'Setup', icon: <Settings className="w-4 h-4" />, color: 'text-orange-400' },
];

const CATEGORY_STYLE: Record<string, string> = {
  General: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  Moderation: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
  Security: 'bg-red-500/10 border-red-500/20 text-red-400',
  Leveling: 'bg-purple-500/10 border-purple-500/20 text-purple-400',
  Tickets: 'bg-green-500/10 border-green-500/20 text-green-400',
  Setup: 'bg-orange-500/10 border-orange-500/20 text-orange-400',
};

const COMMAND_TYPES: Record<number, string> = {
  1: 'Slash Command',
  2: 'User Context Menu',
  3: 'Message Context Menu',
};

// ── Category Dropdown ──────────────────────────────────────────────────────────

function CategoryDropdown({ selected, onSelect, counts }: {
  selected: string;
  onSelect: (cat: string) => void;
  counts: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const cat = CATEGORIES.find((c) => c.name === selected) ?? CATEGORIES[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-black/20 border border-white/10 hover:border-white/20 transition-all text-sm font-medium text-white min-w-[200px] justify-between"
      >
        <span className="flex items-center gap-2">
          <span className={cat.color}>{cat.icon}</span>
          {cat.name}
          <span className="text-xs text-muted-foreground">
            ({cat.name === 'All' ? counts.__all__ : (counts[cat.name] ?? 0)})
          </span>
        </span>
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 w-56 rounded-xl border border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl z-50 overflow-hidden">
            {CATEGORIES.map((c) => (
              <button
                key={c.name}
                onClick={() => { onSelect(c.name); setOpen(false); }}
                className={cn(
                  'flex items-center justify-between w-full px-4 py-2.5 text-sm transition-all hover:bg-white/5',
                  selected === c.name ? 'bg-primary/10 text-white' : 'text-muted-foreground'
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={c.color}>{c.icon}</span>
                  {c.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.name === 'All' ? counts.__all__ : (counts[c.name] ?? 0)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Prefix Command Card ────────────────────────────────────────────────────────

function PrefixCommandCard({ cmd }: { cmd: PrefixCommand }) {
  const [expanded, setExpanded] = useState(false);
  const hasAliases = cmd.aliases && cmd.aliases.length > 0;

  return (
    <div className="border border-white/5 rounded-xl bg-black/20 overflow-hidden transition-all hover:border-white/10">
      <div className="flex items-start gap-4 p-4">
        <div className="w-9 h-9 rounded-lg bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0 text-orange-400 font-bold text-sm mt-0.5">
          {PREFIX}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-mono font-semibold text-white">{PREFIX}{cmd.name}</span>
            {cmd.usage && (
              <span className="font-mono text-xs text-muted-foreground/60">{cmd.usage}</span>
            )}
            <span className={cn('text-xs px-2 py-0.5 rounded-full border', CATEGORY_STYLE[cmd.category] ?? 'bg-white/5 border-white/10 text-muted-foreground')}>
              {cmd.category}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{cmd.description}</p>
          {hasAliases && expanded && (
            <div className="flex items-center gap-1 mt-2 flex-wrap">
              <span className="text-xs text-muted-foreground/50">aliases:</span>
              {cmd.aliases!.map((a) => (
                <span key={a} className="text-xs font-mono px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground">{PREFIX}{a}</span>
              ))}
            </div>
          )}
        </div>
        {hasAliases && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="p-1.5 rounded-lg hover:bg-white/5 text-muted-foreground hover:text-white transition-colors shrink-0 mt-0.5"
            title={expanded ? 'Hide aliases' : 'Show aliases'}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

// ── App Command Card ───────────────────────────────────────────────────────────

function AppCommandCard({ cmd, guildId }: { cmd: AppCommand; guildId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await customFetch(`${BASE}/api/guild/${guildId}/commands/${cmd.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('Failed');
    },
    onSuccess: (_data, enabled) => {
      queryClient.setQueryData<AppCommand[]>(['commands', guildId], (old) =>
        old?.map((c) => (c.id === cmd.id ? { ...c, enabled } : c))
      );
      toast({ title: `/${cmd.name} ${enabled ? 'enabled' : 'disabled'}` });
    },
    onError: () => toast({ title: 'Failed to update command', variant: 'destructive' }),
  });

  return (
    <div className={cn('border border-white/5 rounded-xl overflow-hidden transition-all hover:border-white/10', !cmd.enabled && 'opacity-60')}>
      <div className="flex items-center gap-4 p-4 bg-black/20">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Slash className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="font-mono font-semibold text-white">/{cmd.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-muted-foreground">{COMMAND_TYPES[cmd.type] ?? 'Command'}</span>
            <span className={cn('text-xs px-2 py-0.5 rounded-full border', cmd.scope === 'global' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-purple-500/10 border-purple-500/30 text-purple-400')}>
              {cmd.scope}
            </span>
          </div>
          <p className="text-sm text-muted-foreground truncate">{cmd.description || 'No description.'}</p>
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
        <div className="border-t border-white/5 px-4 py-3 space-y-2 bg-black/10">
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

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'prefix' | 'slash';

export default function Commands() {
  const guildId = useStore((s) => s.selectedGuildId);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [tab, setTab] = useState<Tab>('prefix');

  const { data: appCommandsRaw = [], isLoading } = useQuery({
    queryKey: ['commands', guildId],
    queryFn: async () => {
      if (!guildId) return [];
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await customFetch(`${BASE}/api/guild/${guildId}/commands`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data as AppCommand[] : [];
    },
    enabled: !!guildId,
  });

  const appCommands: AppCommand[] = appCommandsRaw as AppCommand[];

  const filteredPrefix = useMemo(() => {
    return PREFIX_COMMANDS.filter((cmd) => {
      const matchCat = category === 'All' || cmd.category === category;
      const q = search.toLowerCase();
      const matchSearch = !q || cmd.name.includes(q) || cmd.description.toLowerCase().includes(q) || cmd.aliases?.some((a) => a.includes(q));
      return matchCat && matchSearch;
    });
  }, [category, search]);

  const filteredApp = useMemo(() => {
    const q = search.toLowerCase();
    return appCommands.filter((cmd) => !q || cmd.name.includes(q) || cmd.description.toLowerCase().includes(q));
  }, [appCommands, search]);

  const prefixCounts = useMemo(() => {
    const counts: Record<string, number> = { __all__: PREFIX_COMMANDS.length };
    for (const cmd of PREFIX_COMMANDS) {
      counts[cmd.category] = (counts[cmd.category] ?? 0) + 1;
    }
    return counts;
  }, []);

  const grouped = useMemo(() => {
    if (category !== 'All' || search) {
      const key = search ? 'Results' : category;
      return { [key]: filteredPrefix };
    }
    const g: Record<string, PrefixCommand[]> = {};
    for (const cmd of filteredPrefix) {
      (g[cmd.category] ??= []).push(cmd);
    }
    return g;
  }, [filteredPrefix, category, search]);

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-24">
      <PageHeader
        title="App Commands"
        description="Browse and manage all bot commands by category."
        icon={<Terminal className="w-6 h-6" />}
      />

      {/* Tab switch */}
      <div className="flex gap-2 p-1 bg-black/20 border border-white/5 rounded-xl w-fit">
        {(['prefix', 'slash'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setSearch(''); setCategory('All'); }}
            className={cn(
              'px-5 py-2 rounded-lg text-sm font-medium transition-all',
              tab === t ? 'bg-primary/20 text-primary border border-primary/30' : 'text-muted-foreground hover:text-white'
            )}
          >
            {t === 'prefix' ? `${PREFIX} Prefix Commands` : '/ Slash Commands'}
          </button>
        ))}
      </div>

      <PremiumCard className="p-6">
        {/* Controls bar */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          {tab === 'prefix' && (
            <CategoryDropdown
              selected={category}
              onSelect={(c) => { setCategory(c); setSearch(''); }}
              counts={prefixCounts}
            />
          )}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <PremiumInput
              placeholder="Search commands..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {tab === 'prefix' ? `${filteredPrefix.length} command${filteredPrefix.length !== 1 ? 's' : ''}` : `${filteredApp.length} command${filteredApp.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        {/* Prefix Commands — grouped */}
        {tab === 'prefix' && (
          filteredPrefix.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Terminal className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="font-medium">No commands match your search.</p>
            </div>
          ) : (
            <div className="space-y-8">
              {Object.entries(grouped).map(([section, cmds]) => (
                <div key={section}>
                  {Object.keys(grouped).length > 1 && (
                    <div className="flex items-center gap-2 mb-3">
                      <span className={cn('text-xs font-bold uppercase tracking-wider', CATEGORY_STYLE[section]?.split(' ').at(-1) ?? 'text-muted-foreground')}>
                        {section}
                      </span>
                      <span className="text-xs text-muted-foreground">({cmds.length})</span>
                      <div className="flex-1 h-px bg-white/5" />
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {cmds.map((cmd) => <PrefixCommandCard key={cmd.name} cmd={cmd} />)}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* Slash Commands */}
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
                {search ? 'No commands match your search.' : 'No slash commands found for this bot.'}
              </p>
              {!search && (
                <p className="text-sm mt-1 opacity-70">Register slash commands with Discord to see them here.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredApp.map((cmd) => <AppCommandCard key={cmd.id} cmd={cmd} guildId={guildId!} />)}
            </div>
          )
        )}
      </PremiumCard>
    </motion.div>
  );
}
