type NoticeBannerProps = {
  tone: 'info' | 'error';
  message: string;
};

export function NoticeBanner({
  tone,
  message,
}: NoticeBannerProps) {
  return (
    <p
      aria-live="polite"
      className="notice-banner"
      data-notice-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {message}
    </p>
  );
}
