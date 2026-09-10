/** Inline SVG icons. Every status carries colour + word + icon (+ sound), per §3's
 *  redundant encoding — roughly 8 % of men are colour-vision deficient. */

type P = { className?: string }
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const CheckIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" {...base}><path d="M4 12.5 9.5 18 20 6" /></svg>
)
export const CrossIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" {...base}><path d="M5 5l14 14M19 5 5 19" /></svg>
)
export const WarnIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" {...base}>
    <path d="M12 3.5 22 20H2L12 3.5Z" /><path d="M12 10v4.2" /><path d="M12 17.3v.01" />
  </svg>
)
export const SearchIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...base}>
    <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />
  </svg>
)
export const SoundOnIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" {...base}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" /><path d="M16 9.2a4 4 0 0 1 0 5.6" /><path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" />
  </svg>
)
export const SoundOffIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" {...base}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" /><path d="m16.5 9.5 5 5M21.5 9.5l-5 5" />
  </svg>
)
export const OfflineIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" {...base}>
    <path d="M2.5 8.2A16 16 0 0 1 8 5.2M21.5 8.2a16 16 0 0 0-6.6-3.1" />
    <path d="M6 12a10.5 10.5 0 0 1 2.6-1.7M18 12a10.5 10.5 0 0 0-3.4-2" />
    <path d="M9.6 15.6a5 5 0 0 1 4.2.3" /><path d="M12 19.5v.01" /><path d="M3 3l18 18" />
  </svg>
)
