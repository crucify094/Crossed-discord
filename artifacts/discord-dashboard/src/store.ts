import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AppState {
  selectedGuildId: string | null;
  setSelectedGuildId: (id: string) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      selectedGuildId: null,
      setSelectedGuildId: (id) => set({ selectedGuildId: id }),
    }),
    {
      name: 'discord-dashboard-storage',
    }
  )
);
