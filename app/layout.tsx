// Minimal root layout — this project is API-only, but Next.js requires
// a layout to bootstrap. No UI is served from non-/api routes.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

export const metadata = {
  title: "rok-api",
};
