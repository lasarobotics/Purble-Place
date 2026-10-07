import "./globals.css";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Providers } from "./providers";

// Condensed display type with neutral body text and tabular UI numerals.
const inter = localFont({ src: "./fonts/inter-variable.woff2", variable: "--font-inter", display: "swap", weight: "100 900" });

const barlow = localFont({ src: [{ path: "./fonts/barlow-regular.woff2", weight: "400" }, { path: "./fonts/barlow-medium.woff2", weight: "500" }], variable: "--font-barlow", display: "swap" });

export const metadata: Metadata = {
  title: "HazeHub. FRC Scouting",
  description: "Purple Haze scouting, strategy and picklist hub for FRC.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "HazeHub", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
