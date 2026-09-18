interface Props {
  title: string;
  /** What will actually be on this page, in the user's terms. */
  children: React.ReactNode;
  /** What has to happen before it can be built. Omit if nothing blocks it. */
  blockedOn?: React.ReactNode;
  planned?: string[];
}

/**
 * The placeholder every unbuilt page uses. An empty screen is a chance to
 * explain where the product is going, so this says what lands here and what
 * it's waiting on rather than just "coming soon".
 */
export function ComingSoon({ title, children, blockedOn, planned }: Props) {
  return (
    <div className="soon">
      <span className="badge">Not built yet</span>
      <h2>{title}</h2>
      <p>{children}</p>
      {planned && (
        <ul className="soon-list">
          {planned.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {blockedOn && <div className="blocked">{blockedOn}</div>}
    </div>
  );
}
