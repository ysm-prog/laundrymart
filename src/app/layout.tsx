import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

/* The pack's typography. Self-hosted by next/font rather than a <link> to
   Google: the driver app has to render on a loading dock with no signal, and a
   render-blocking font fetch is the last thing that should decide whether a
   stop can be recorded. `display: swap` keeps text visible regardless. */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

/* Mono carries every number, identifier, date and uppercase label — in this
   design it is structural, not decorative. */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

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
    { media: "(prefers-color-scheme: light)", color: "#eceff1" },
    { media: "(prefers-color-scheme: dark)", color: "#14171a" },
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
    <html lang="en-AU" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <a href="#main"
           className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50
                      focus:bg-action focus:px-3 focus:py-2 focus:text-action-foreground">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
