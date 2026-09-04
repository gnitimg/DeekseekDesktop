type IconName =
  | 'activity' | 'archive' | 'arrow-up' | 'branch' | 'cache' | 'check' | 'chevron-down'
  | 'chevron-left' | 'chevron-right' | 'clock' | 'close' | 'command' | 'copy' | 'external'
  | 'edit' | 'folder' | 'folder-plus' | 'globe' | 'grid' | 'layers' | 'menu' | 'more' | 'panel' | 'paperclip'
  | 'pin' | 'plus' | 'refresh' | 'search' | 'settings' | 'shield' | 'sparkles'
  | 'terminal' | 'trash' | 'user' | 'keyboard' | 'link' | 'monitor'

interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}

const paths: Record<IconName, React.ReactNode> = {
  activity: <><path d="M4 12h3l2-7 4 14 2-7h5" /></>,
  archive: <><path d="M4 7h16v13H4z" /><path d="M3 4h18v3H3zM9 11h6" /></>,
  'arrow-up': <><path d="m6 12 6-6 6 6M12 6v12" /></>,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 8c2 3 6 3 8 0" /></>,
  cache: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-down': <path d="m7 9 5 5 5-5" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></>,
  close: <path d="M7 7l10 10M17 7 7 17" />,
  command: <><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  external: <><path d="M14 5h5v5M19 5l-8 8" /><path d="M17 13v6H5V7h6" /></>,
  folder: <path d="M3.5 7.5h6l2-2h9v13h-17z" />,
  'folder-plus': <><path d="M3.5 7.5h6l2-2h9v13h-17z" /><path d="M12 11v5M9.5 13.5h5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 14h7M17 14h.01" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
  menu: <><path d="M5 8h14M5 12h14M5 16h14" /></>,
  monitor: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  paperclip: <path d="m8 12 5.8-5.8a3 3 0 0 1 4.2 4.2L9.4 19a5 5 0 0 1-7-7l8-8" />,
  pin: <><path d="m9 3 6 6-2 2 4 4-2 2-4-4-2 2-6-6z" /><path d="m9 15-5 5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-2 5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5 5 18l2.4-1.1a8 8 0 0 0 1.7 1l.4 3.1h5l.3-3.1a8 8 0 0 0 1.8-1L19 18l2-3.5-2.1-1.4a7 7 0 0 0 .1-1.1Z" /></>,
  shield: <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z" /><path d="m9 12 2 2 4-5" /></>,
  sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z" /><path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7zM5 13l.7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7z" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 9 3 3-3 3M12 15h5" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
}

export function Icon({ name, size = 18, strokeWidth = 1.7, className }: IconProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      {paths[name]}
    </svg>
  )
}

export function BrandMark({ size = 28, muted = false }: { size?: number; muted?: boolean }): React.ReactElement {
  return (
    <svg aria-label="DeepSeek Harness" className="brand-mark" height={size} viewBox="0 0 32 32" width={size}>
      <rect width="32" height="32" rx="8.5" fill={muted ? '#e7e6e2' : '#20211f'} />
      <path d="M8 18.2c2.3-6.6 8-8.8 16-7.7-1.8 1.1-3.4 2.7-4.4 4.8 1.7-.3 3.2 0 4.5.8-3.5 5.1-8.2 7-14.1 5.4 2.4-.4 4.5-1.3 6.3-2.9-3.1 1-5.8.9-8.3-.4Z" fill={muted ? '#777873' : '#f4f4ef'} />
      <circle cx="21.7" cy="13.8" r="1.05" fill={muted ? '#e7e6e2' : '#20211f'} />
    </svg>
  )
}
