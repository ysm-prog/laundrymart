import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "LaundryMart", template: "%s · LaundryMart" },
  description: "Commercial laundry operations — routes, jobs, inventory and billing.",
  applicationName: "LaundryMart",
  formatDetection: { telephone: false },
  // Installable on a driver's phone; the service worker keeps /run reachable offline.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "LaundryMart", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
};

// Applied before paint so a dark-mode user never sees a white flash.
const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem("theme");
  var dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <a href="#main"
           className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50
                      focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
