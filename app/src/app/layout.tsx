import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { CSSProperties, ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { BottomNav, TopNav } from "@/components/Nav";
import { brand, brandCssVars, tickerLabel } from "@/config/brand";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: `${brand.name} · ${brand.tagline}`, template: `%s · ${brand.name}` },
  description: brand.description,
  applicationName: brand.name,
  keywords: [brand.name, tickerLabel, "Robinhood Chain", "Hyperliquid", "treasury", "governance"],
  openGraph: { title: brand.name, description: brand.description, type: "website" },
};

export const viewport: Viewport = {
  themeColor: brand.colors.bg,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} style={brandCssVars() as CSSProperties}>
      <body className="min-h-dvh">
        <Providers>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-bg"
          >
            Skip to content
          </a>
          <TopNav />
          <main id="main">{children}</main>
          <Footer />
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
