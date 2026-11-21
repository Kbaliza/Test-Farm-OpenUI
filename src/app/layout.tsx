import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AppHeight } from "@/components/layout/app-height";
import "./globals.css";

// Set the real visible height before first paint (no flash) — iOS Safari's 100vh/
// 100dvh can be the tall viewport behind the toolbars; window.innerHeight is right.
const SET_APP_HEIGHT = `try{document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px')}catch(e){}`;

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Dairy Suite",
  description: "Dairy farm management: Production, deliveries, billing, ledgers",
};

// viewport-fit=cover so env(safe-area-inset-*) resolves on notched iPhones (used by
// the scroll area's bottom padding). Zoom is left enabled for accessibility.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} app-height antialiased`}
    >
      {/* app-height = the real visible height (see globals.css / AppHeight): on mobile
          100vh/100dvh can extend behind the browser toolbars, which pushed the bottom
          of the internal scroll area out of reach and made pages rubber-band. */}
      <body className="app-height overflow-hidden" suppressHydrationWarning>
        {/* Set the height var before the shell paints (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: SET_APP_HEIGHT }} />
        <AppHeight />
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
