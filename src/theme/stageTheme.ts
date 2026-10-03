import type { EfmTheme } from '@theclearsky/easy-folder-management-ui/ui';

/**
 * The folder library (sidebar, tabs, menus, dialogs, toasts) dressed for the
 * stage: Nodestra-homepage language — ivory serif titles with gold tracking,
 * a gold active tab, gold-rimmed dialogs, pill buttons. Colours come from the
 * `--efm-*` tokens in index.css; these slots carry what tokens cannot.
 *
 * Classes here are the APP's own Tailwind (unprefixed); the library's `cn`
 * makes them win over its `efm:` defaults property by property.
 */
const stageTheme: EfmTheme = {
  fileSidebar: {
    header: 'border-b border-[#e9d3a8]/10',
    title: 'font-serif text-[11px] tracking-[0.3em] text-[#e9d3a8]/80',
    accessTagReadWrite: 'border-[#e9d3a8]/60 text-[#e9d3a8]',
    rowActive: 'bg-[#e9d3a8]/12 text-[#f4ead8]',
    rowSelected: 'bg-[#e9d3a8]/8',
    empty: 'text-[#d8c7a8]/60',
  },
  tabStrip: {
    root: 'border-b border-[#e9d3a8]/10 bg-[#0f0a09]',
    tabActive: 'bg-[#140d0b] text-[#f4ead8] shadow-[inset_0_2px_0_#e9d3a8]',
    tabInactive: 'text-[#a8957f] hover:text-[#f4ead8]',
  },
  menu: {
    content: 'rounded-xl border-[#e9d3a8]/15 bg-[#140d0b]/98 shadow-[0_20px_60px_rgba(0,0,0,0.7)] backdrop-blur-md',
    item: 'rounded-md',
  },
  choiceDialog: {
    panel:
      'rounded-[20px] border border-[#e9d3a8]/30 bg-[#120b09] shadow-[0_0_0_1px_rgba(255,224,160,0.1),0_0_40px_rgba(255,206,130,0.12),0_30px_80px_rgba(0,0,0,0.75)]',
    title: 'font-serif text-[20px] text-[#f4ead8]',
    body: 'text-[#d8c7a8]/85',
    choice: 'rounded-full',
    choicePrimary: 'rounded-full border border-[#e9d3a8]/45 bg-white/[0.07] text-[#f4ead8] shadow-[0_0_30px_rgba(255,190,110,0.18)] hover:bg-white/[0.14]',
    choiceNeutral: 'rounded-full border border-[#e9d3a8]/25 bg-black/30 text-[#e9d3a8] hover:bg-black/50',
    choiceDanger: 'rounded-full',
    card: 'rounded-2xl border-[#e9d3a8]/15 bg-black/30 hover:border-[#e9d3a8]/45',
    cardLabel: 'font-serif text-[16px] text-[#f4ead8]',
    cardDescription: 'text-[#d8c7a8]/75',
    cancel: 'rounded-full',
    progressTrack: 'rounded-full bg-[#e9d3a8]/10',
    progressBar: 'rounded-full bg-[#e9d3a8]',
  },
  unsavedDialog: {
    panel: 'rounded-[20px] border border-[#e9d3a8]/30 bg-[#120b09]',
    title: 'font-serif text-[20px] text-[#f4ead8]',
  },
  // Toasts at the TOP: at the bottom they covered the player's controls.
  toaster: {
    viewport: 'top-[86px] bottom-auto max-sm:top-[108px] max-sm:inset-x-3 max-sm:items-stretch',
    toast: 'rounded-2xl border-[#e9d3a8]/20 bg-[#140d0b]/95 shadow-[0_18px_50px_rgba(0,0,0,0.6)] backdrop-blur-md',
    action: 'rounded-full border border-[#e9d3a8]/40 px-3 text-[#e9d3a8] hover:bg-white/[0.08]',
  },
  emptyState: {
    title: 'font-serif text-[22px] text-[#f4ead8]',
    rowButton: 'rounded-xl hover:bg-white/[0.04]',
    hint: 'text-[#d8c7a8]/55',
  },
};

export { stageTheme };
