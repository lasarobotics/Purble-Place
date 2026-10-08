import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "HazeHub. FRC Scouting",
  description: "Purple Haze scouting, strategy and picklist hub for FRC.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "HazeHub", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#222222",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
