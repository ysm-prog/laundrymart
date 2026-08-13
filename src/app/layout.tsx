import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/* Self-hosted by next/font rather than a <link> to Google: the driver app has
   to render on a loading dock with no signal, and a render-blocking font fetch
   is the last thing that should decide whether a stop can be recorded.
   `display: swap` keeps text visible regardless. */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

/* Bound but deliberately rare. Monospace is for genuine machine text — a raw
   audit payload, an opaque identifier — never for a date, a total or a job
   number, which are ordinary business content and read better in Inter. */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Electro Services", template: "%s · Electro Services" },
  description: "Commercial laundry operations — runs, jobs, linen and invoicing.",
  applicationName: "Electro Services",
  formatDetection: { telephone: false },
  // Installable on a driver's phone; the service worker keeps /run reachable offline.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Electro Services", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#141821" },
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
    <html lang="en-AU" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <a href="#main"
           className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50
                      focus:rounded-lg focus:bg-action focus:px-4 focus:py-2.5 focus:text-sm
                      focus:font-medium focus:text-action-foreground focus:shadow-lg">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
