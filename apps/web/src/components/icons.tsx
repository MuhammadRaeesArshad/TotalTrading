/** Single-stroke 18px icons, matching the rail in the design. */
const s = {
  width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.5,
} as const;

export const IconSummary = () => (
  <svg {...s}><rect x="2.5" y="2.5" width="6" height="6" rx="1.5" /><rect x="9.5" y="2.5" width="6" height="6" rx="1.5" /><rect x="2.5" y="9.5" width="6" height="6" rx="1.5" /><rect x="9.5" y="9.5" width="6" height="6" rx="1.5" /></svg>
);
export const IconStrategies = () => (
  <svg {...s}><path d="M2 13l4-5 3 3 3-5 4 3" strokeLinecap="round" strokeLinejoin="round" /><circle cx="6" cy="8" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="6" r="1.3" fill="currentColor" stroke="none" /></svg>
);
export const IconAccounts = () => (
  <svg {...s}><rect x="2" y="4" width="14" height="10" rx="2" /><path d="M2 7.5h14" /></svg>
);
export const IconPositions = () => (
  <svg {...s}><path d="M3 15V7M7 15V3M11 15v-6M15 15V5" strokeLinecap="round" /></svg>
);
export const IconJobs = () => (
  <svg {...s}><circle cx="9" cy="9" r="6.5" /><path d="M9 5.5V9l2.5 1.5" strokeLinecap="round" /></svg>
);
export const IconBacktests = () => (
  <svg {...s}><path d="M2.5 12.5l4-6 3.5 3 5.5-7" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.5 15.5h13" strokeLinecap="round" /></svg>
);
/** A grid being sliced: this page groups trades rather than listing them. */
export const IconExplore = () => (
  <svg {...s}><path d="M2.5 2.5h13v13h-13z" /><path d="M2.5 7h13M2.5 11.5h13M7 2.5v13" strokeLinecap="round" /></svg>
);
export const IconAnalysis = () => (
  <svg {...s}><path d="M4 2.5h7l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z" /><path d="M6 9h6M6 12h4" strokeLinecap="round" /></svg>
);
export const IconJournal = () => (
  <svg {...s}><path d="M4 2.5h10v13H4z" /><path d="M4 6h10M7 2.5v13" strokeLinecap="round" /></svg>
);
export const IconLogs = () => (
  <svg {...s}><path d="M3 4.5h12M3 9h12M3 13.5h8" strokeLinecap="round" /></svg>
);
export const IconSettings = () => (
  <svg {...s}><circle cx="9" cy="9" r="2.5" /><path d="M14.4 11.1a1.2 1.2 0 00.24 1.32l.05.05a1.5 1.5 0 11-2.12 2.12l-.05-.05a1.2 1.2 0 00-1.32-.24 1.2 1.2 0 00-.73 1.1v.15a1.5 1.5 0 01-3 0v-.08a1.2 1.2 0 00-.79-1.1 1.2 1.2 0 00-1.32.24l-.05.05a1.5 1.5 0 11-2.12-2.12l.05-.05a1.2 1.2 0 00.24-1.32 1.2 1.2 0 00-1.1-.73H2.2a1.5 1.5 0 010-3h.08a1.2 1.2 0 001.1-.79 1.2 1.2 0 00-.24-1.32l-.05-.05A1.5 1.5 0 115.21 3.1l.05.05a1.2 1.2 0 001.32.24h.12a1.2 1.2 0 00.73-1.1V2.2a1.5 1.5 0 013 0v.08a1.2 1.2 0 00.73 1.1 1.2 1.2 0 001.32-.24l.05-.05a1.5 1.5 0 112.12 2.12l-.05.05a1.2 1.2 0 00-.24 1.32v.07a1.2 1.2 0 001.1.73h.15a1.5 1.5 0 010 3h-.08a1.2 1.2 0 00-1.1.73z" /></svg>
);
export const IconTheme = () => (
  <svg {...s}><circle cx="9" cy="9" r="5" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" strokeLinecap="round" /></svg>
);

export const Logomark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
    <path d="M2 14.5L6.5 8l3.5 4 3-5.5L18 5" stroke="var(--fg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="18" cy="5" r="2" fill="var(--gain)" />
  </svg>
);
