import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Chakra_Petch } from "next/font/google";
import { Providers } from "./providers";

// Night Pit type pairing: Chakra Petch (squared, technical) carries headers
// and labels; Atkinson Hyperlegible keeps body text readable on dark screens
// in bright arenas. Numerals stay on the system mono stack (globals.css).
const chakra = Chakra_Petch({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-chakra",
  display: "swap",
});
const atkinson = Atkinson_Hyperlegible({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-atkinson",
  display: "swap",
});

export const metadata: Metadata = {
  title: "HazeHub — FRC Scouting",
  description: "Purple Haze scouting, strategy & picklist hub for FRC.",
};

export const viewport: Viewport = {
  themeColor: "#0b0910",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${chakra.variable} ${atkinson.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
