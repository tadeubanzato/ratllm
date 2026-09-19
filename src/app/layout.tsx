import type { Metadata, Viewport } from "next";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "RatLLM", template: "%s · RatLLM" },
  description: "Self-hosted AI model deployment control plane",
  applicationName: "RatLLM Model Curator",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], shortcut: ["/icon.svg"], apple: [{ url: "/icon.svg" }] },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f5f6f8" }, { media: "(prefers-color-scheme: dark)", color: "#0d0f12" }],
};

const themeScript = `(function(){try{var t=localStorage.getItem("theme");var dark=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.dataset.theme=dark?"dark":"light"}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeScript }}/></head>
    <body><Sidebar/><div className="app-content">{children}</div></body>
  </html>;
}
