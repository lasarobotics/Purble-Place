import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";

// One quiet family, weight contrast does the work. Numerals stay on the
// system mono stack (globals.css) for tabular data.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

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
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
