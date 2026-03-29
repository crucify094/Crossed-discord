import React from 'react';
import { motion } from 'framer-motion';
import { useGetBotInfo } from '@workspace/api-client-react';
import { PremiumCard, PremiumButton } from '@/components/PremiumComponents';

export default function BotSettings() {
  const { data: bot, isLoading } = useGetBotInfo();

  if (isLoading) return <div className="p-8 text-white">Loading...</div>;
  if (!bot) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl mx-auto pb-24">
      <PremiumCard className="p-0 overflow-hidden border-white/10">
        <div className="h-48 w-full relative">
          <img 
            src={`${import.meta.env.BASE_URL}images/bot-banner.png`} 
            alt="Banner" 
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-card to-transparent" />
        </div>
        
        <div className="px-8 pb-8 relative">
          <div className="flex justify-between items-end -mt-16 mb-6">
            <div className="relative">
              <img 
                src={bot.avatar || "https://images.unsplash.com/photo-1614680376573-df3480f0c6ff?w=150&h=150&fit=crop"} 
                alt="Avatar" 
                className="w-32 h-32 rounded-full border-4 border-card object-cover bg-card"
              />
              <span className={`absolute bottom-2 right-2 w-6 h-6 rounded-full border-4 border-card ${
                bot.status === 'online' ? "bg-green-500" : 
                bot.status === 'idle' ? "bg-yellow-500" : 
                bot.status === 'dnd' ? "bg-red-500" : "bg-gray-500"
              }`} />
            </div>
            <div className="flex gap-3">
              <PremiumButton variant="secondary">Invite Bot</PremiumButton>
              <PremiumButton variant="primary">Edit Profile</PremiumButton>
            </div>
          </div>

          <div>
            <h1 className="text-4xl font-display font-bold text-white mb-1">{bot.username}</h1>
            <p className="text-xl text-muted-foreground mb-6">#{bot.discriminator}</p>
            
            <div className="glass-panel p-6 rounded-xl inline-block w-full max-w-2xl bg-black/20">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-2">About Me</h3>
              <p className="text-white leading-relaxed">
                {bot.bio || "Premium security, moderation, and utility bot. Keeping servers safe from nukes and raids."}
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8">
              <div className="p-4 rounded-xl bg-black/20 border border-white/5">
                <p className="text-sm text-muted-foreground mb-1">Servers</p>
                <p className="text-2xl font-bold text-white">{bot.guildCount.toLocaleString()}</p>
              </div>
              <div className="p-4 rounded-xl bg-black/20 border border-white/5">
                <p className="text-sm text-muted-foreground mb-1">Latency</p>
                <p className="text-2xl font-bold text-white">{bot.ping}ms</p>
              </div>
            </div>
          </div>
        </div>
      </PremiumCard>
    </motion.div>
  );
}
